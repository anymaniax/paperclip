import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { badRequest, unprocessable } from "../errors.js";

// Per-repo mutex to prevent concurrent merge operations on the same repository
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const normalizedPath = resolve(repoPath);
  const previous = repoLocks.get(normalizedPath) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  repoLocks.set(normalizedPath, current);
  current.finally(() => {
    if (repoLocks.get(normalizedPath) === current) {
      repoLocks.delete(normalizedPath);
    }
  });
  return current;
}

interface DiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface DiffResult {
  files: DiffFile[];
}

export interface MergeResult {
  success: boolean;
  mergeCommitSha?: string;
  conflictDetails?: string;
}

function execGit(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function assertSafeBranchName(name: string): void {
  if (name.startsWith("-")) {
    throw badRequest(`Invalid branch name: "${name}" — branch names must not start with "-"`);
  }
}

async function assertRepoExists(repoPath: string) {
  try {
    await access(repoPath);
  } catch {
    throw badRequest(`Repository path does not exist: ${repoPath}`);
  }

  try {
    await execGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw badRequest(`Path is not a git repository: ${repoPath}`);
  }
}

function parseDiffNumstat(numstatOutput: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatOutput.trim().split("\n")) {
    if (!line) continue;
    const [addStr, delStr, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    stats.set(filePath, {
      additions: addStr === "-" ? 0 : parseInt(addStr!, 10),
      deletions: delStr === "-" ? 0 : parseInt(delStr!, 10),
    });
  }
  return stats;
}

function parseDiffNameStatus(nameStatusOutput: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of nameStatusOutput.trim().split("\n")) {
    if (!line) continue;
    const [status, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    const statusMap: Record<string, string> = {
      A: "added",
      M: "modified",
      D: "deleted",
      R: "renamed",
      C: "copied",
    };
    statuses.set(filePath, statusMap[status?.[0] ?? ""] ?? "modified");
  }
  return statuses;
}

function splitDiffByFile(patchOutput: string): Map<string, string> {
  const files = new Map<string, string>();
  const fileBlocks = patchOutput.split(/^diff --git /m);
  for (const block of fileBlocks) {
    if (!block.trim()) continue;
    const headerMatch = block.match(/^a\/(.+?) b\/(.+)/);
    if (headerMatch) {
      const filePath = headerMatch[2]!;
      files.set(filePath, `diff --git ${block}`);
    }
  }
  return files;
}

export async function gitDiff(repoPath: string, baseBranch: string, branch: string): Promise<DiffResult> {
  assertSafeBranchName(baseBranch);
  assertSafeBranchName(branch);
  await assertRepoExists(repoPath);

  const diffRange = `${baseBranch}...${branch}`;

  const [numstatResult, nameStatusResult, patchResult] = await Promise.allSettled([
    execGit(repoPath, ["diff", "--numstat", diffRange, "--"]),
    execGit(repoPath, ["diff", "--name-status", diffRange, "--"]),
    execGit(repoPath, ["diff", diffRange, "--"]),
  ]);

  if (numstatResult.status === "rejected") {
    const err = numstatResult.reason as Error & { stderr?: string };
    throw unprocessable(`Git diff failed: ${err.stderr ?? err.message}`);
  }

  const stats = parseDiffNumstat(numstatResult.value.stdout);
  const statuses = nameStatusResult.status === "fulfilled"
    ? parseDiffNameStatus(nameStatusResult.value.stdout)
    : new Map<string, string>();
  const patches = patchResult.status === "fulfilled"
    ? splitDiffByFile(patchResult.value.stdout)
    : new Map<string, string>();

  const files: DiffFile[] = Array.from(stats.entries()).map(([path, { additions, deletions }]) => ({
    path,
    status: statuses.get(path) ?? "modified",
    additions,
    deletions,
    patch: patches.get(path) ?? "",
  }));

  return { files };
}

export async function gitMerge(repoPath: string, baseBranch: string, branch: string): Promise<MergeResult> {
  assertSafeBranchName(baseBranch);
  assertSafeBranchName(branch);
  await assertRepoExists(repoPath);

  return withRepoLock(repoPath, async () => {
    // Ensure working tree is clean before merge
    try {
      const { stdout: statusOut } = await execGit(repoPath, ["status", "--porcelain", "-uno"]);
      if (statusOut.trim()) {
        return {
          success: false,
          conflictDetails: "Working tree is not clean. Commit or stash changes before merging.",
        };
      }
    } catch (err) {
      const gitErr = err as Error & { stderr?: string };
      return {
        success: false,
        conflictDetails: `Failed to check working tree status: ${gitErr.stderr ?? gitErr.message}`,
      };
    }

    // Checkout base branch
    try {
      await execGit(repoPath, ["checkout", baseBranch]);
    } catch (err) {
      const gitErr = err as Error & { stderr?: string };
      return {
        success: false,
        conflictDetails: `Failed to checkout ${baseBranch}: ${gitErr.stderr ?? gitErr.message}`,
      };
    }

    // Perform merge
    try {
      await execGit(repoPath, ["merge", "--no-ff", branch]);
    } catch (err) {
      const gitErr = err as Error & { stderr?: string };
      // Abort the failed merge to restore clean state
      try {
        await execGit(repoPath, ["merge", "--abort"]);
      } catch {
        // best effort
      }
      return {
        success: false,
        conflictDetails: gitErr.stderr ?? gitErr.message,
      };
    }

    // Get the merge commit SHA
    try {
      const { stdout } = await execGit(repoPath, ["rev-parse", "HEAD"]);
      return {
        success: true,
        mergeCommitSha: stdout.trim(),
      };
    } catch {
      return { success: true };
    }
  });
}
