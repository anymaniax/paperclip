import { useState, useMemo, useEffect } from "react";
import {
  ChevronRight,
  File,
  FilePlus,
  FileX,
  FileEdit,
  FileDiff,
  Columns2,
  AlignJustify,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from "shiki";
import type { DiffFile } from "../api/approvals";

// ── View mode ──────────────────────────────────────────────

type ViewMode = "unified" | "split";

// ── Status icon / color maps ───────────────────────────────

const statusIcon: Record<string, typeof File> = {
  added: FilePlus,
  deleted: FileX,
  modified: FileEdit,
  renamed: FileDiff,
  copied: FileDiff,
};

const statusColor: Record<string, string> = {
  added: "text-green-600 dark:text-green-400",
  deleted: "text-red-600 dark:text-red-400",
  modified: "text-yellow-600 dark:text-yellow-400",
  renamed: "text-blue-600 dark:text-blue-400",
  copied: "text-blue-600 dark:text-blue-400",
};

// ── Diff line types ────────────────────────────────────────

interface DiffLineProps {
  type: "addition" | "deletion" | "context" | "header";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

// ── Patch parser ───────────────────────────────────────────

const parsePatch = (patch: string): DiffLineProps[] => {
  if (!patch) return [];
  const lines = patch.split("\n");
  const result: DiffLineProps[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) continue;
    if (line.startsWith("index ")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[2]!, 10);
        result.push({ type: "header", content: line });
      }
      continue;
    }
    if (line.startsWith("+")) {
      result.push({ type: "addition", content: line.slice(1), newLineNo: newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "deletion", content: line.slice(1), oldLineNo: oldLine });
      oldLine++;
    } else if (line.startsWith("\\")) {
      continue;
    } else {
      result.push({
        type: "context",
        content: line.startsWith(" ") ? line.slice(1) : line,
        oldLineNo: oldLine,
        newLineNo: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return result;
};

// ── Line styles ────────────────────────────────────────────

const lineStyles: Record<DiffLineProps["type"], string> = {
  addition: "bg-green-500/10",
  deletion: "bg-red-500/10",
  context: "",
  header: "bg-blue-500/10 text-blue-700 dark:text-blue-300 font-medium",
};

const lineGutterStyles: Record<DiffLineProps["type"], string> = {
  addition: "bg-green-500/20 text-green-700 dark:text-green-400",
  deletion: "bg-red-500/20 text-red-700 dark:text-red-400",
  context: "text-muted-foreground",
  header: "bg-blue-500/15",
};

// ── Shiki highlighter singleton ────────────────────────────

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

const HIGHLIGHT_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "rust",
  "go",
  "yaml",
  "toml",
  "bash",
  "sql",
  "vue",
  "svelte",
  "graphql",
  "dockerfile",
  "xml",
  "ruby",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "swift",
  "kotlin",
  "scala",
] as const;

const initHighlighter = (): Promise<Highlighter> => {
  if (highlighterInstance) return Promise.resolve(highlighterInstance);
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = createHighlighter({
    themes: ["github-dark", "github-light"],
    langs: [...HIGHLIGHT_LANGS],
  }).then((h) => {
    highlighterInstance = h;
    return h;
  });
  return highlighterPromise;
};

const useHighlighter = (): Highlighter | null => {
  const [h, setH] = useState<Highlighter | null>(highlighterInstance);
  useEffect(() => {
    if (h) return;
    initHighlighter().then(setH);
  }, [h]);
  return h;
};

const useIsDark = (): boolean => {
  const [isDark, setIsDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(el.classList.contains("dark"));
    });
    observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
};

// ── Language detection ─────────────────────────────────────

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  xml: "xml",
  svg: "xml",
  rb: "ruby",
  java: "java",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  dockerfile: "dockerfile",
};

const detectLang = (filePath: string): BundledLanguage | null => {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  const ext = name.split(".").pop() ?? "";
  return (EXT_TO_LANG[ext] as BundledLanguage) ?? null;
};

// ── File highlight hook ────────────────────────────────────

type TokenMap = Map<number, ThemedToken[]>;

interface HighlightedFile {
  oldTokens: TokenMap;
  newTokens: TokenMap;
}

const useFileHighlight = (
  lines: DiffLineProps[],
  filePath: string,
  highlighter: Highlighter | null,
  isDark: boolean,
  isOpen: boolean,
): HighlightedFile | null =>
  useMemo(() => {
    if (!highlighter || !isOpen) return null;

    const lang = detectLang(filePath);
    if (!lang) return null;

    const loadedLangs = highlighter.getLoadedLanguages();
    if (!loadedLangs.includes(lang)) return null;

    const theme = isDark ? "github-dark" : "github-light";

    const oldLines: { lineNo: number; content: string }[] = [];
    const newLines: { lineNo: number; content: string }[] = [];

    for (const line of lines) {
      if (line.type === "context" && line.oldLineNo != null && line.newLineNo != null) {
        oldLines.push({ lineNo: line.oldLineNo, content: line.content });
        newLines.push({ lineNo: line.newLineNo, content: line.content });
      } else if (line.type === "deletion" && line.oldLineNo != null) {
        oldLines.push({ lineNo: line.oldLineNo, content: line.content });
      } else if (line.type === "addition" && line.newLineNo != null) {
        newLines.push({ lineNo: line.newLineNo, content: line.content });
      }
    }

    oldLines.sort((a, b) => a.lineNo - b.lineNo);
    newLines.sort((a, b) => a.lineNo - b.lineNo);

    const oldContent = oldLines.map((l) => l.content).join("\n");
    const newContent = newLines.map((l) => l.content).join("\n");

    const oldTokenMap = new Map<number, ThemedToken[]>();
    const newTokenMap = new Map<number, ThemedToken[]>();

    try {
      if (oldContent) {
        const result = highlighter.codeToTokens(oldContent, { lang, theme });
        oldLines.forEach((l, i) => {
          if (result.tokens[i]) oldTokenMap.set(l.lineNo, result.tokens[i]);
        });
      }
      if (newContent) {
        const result = highlighter.codeToTokens(newContent, { lang, theme });
        newLines.forEach((l, i) => {
          if (result.tokens[i]) newTokenMap.set(l.lineNo, result.tokens[i]);
        });
      }
    } catch {
      return null;
    }

    return { oldTokens: oldTokenMap, newTokens: newTokenMap };
  }, [lines, filePath, highlighter, isDark, isOpen]);

// ── Token helpers ──────────────────────────────────────────

const getLineTokens = (
  line: DiffLineProps,
  highlight: HighlightedFile | null,
): ThemedToken[] | null => {
  if (!highlight) return null;
  if (line.type === "deletion" && line.oldLineNo != null) {
    return highlight.oldTokens.get(line.oldLineNo) ?? null;
  }
  if (line.type === "addition" && line.newLineNo != null) {
    return highlight.newTokens.get(line.newLineNo) ?? null;
  }
  if (line.type === "context") {
    if (line.newLineNo != null) return highlight.newTokens.get(line.newLineNo) ?? null;
    if (line.oldLineNo != null) return highlight.oldTokens.get(line.oldLineNo) ?? null;
  }
  return null;
};

const TokenizedContent = ({ tokens }: { tokens: ThemedToken[] }) => (
  <>
    {tokens.map((token, i) => (
      <span key={i} style={token.color ? { color: token.color } : undefined}>
        {token.content}
      </span>
    ))}
  </>
);

const LineContent = ({
  line,
  tokens,
}: {
  line: DiffLineProps;
  tokens: ThemedToken[] | null;
}) => (
  <>
    {line.type === "addition" && (
      <span className="select-none text-green-600 dark:text-green-400 mr-1">+</span>
    )}
    {line.type === "deletion" && (
      <span className="select-none text-red-600 dark:text-red-400 mr-1">-</span>
    )}
    {line.type === "context" && <span className="select-none mr-1">&nbsp;</span>}
    {tokens ? <TokenizedContent tokens={tokens} /> : line.content}
  </>
);

// ── Split view helpers ─────────────────────────────────────

interface SplitRow {
  left: DiffLineProps | null;
  right: DiffLineProps | null;
  isHeader?: boolean;
}

const pairLinesForSplit = (lines: DiffLineProps[]): SplitRow[] => {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.type === "header") {
      rows.push({ left: line, right: line, isHeader: true });
      i++;
      continue;
    }

    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    // Collect consecutive change block
    const deletions: DiffLineProps[] = [];
    const additions: DiffLineProps[] = [];

    while (i < lines.length) {
      const cur = lines[i]!;
      if (cur.type === "deletion") {
        deletions.push(cur);
        i++;
      } else if (cur.type === "addition") {
        additions.push(cur);
        i++;
      } else {
        break;
      }
    }

    const maxLen = Math.max(deletions.length, additions.length);
    for (let j = 0; j < maxLen; j++) {
      rows.push({
        left: deletions[j] ?? null,
        right: additions[j] ?? null,
      });
    }
  }

  return rows;
};

// ── Unified diff line ──────────────────────────────────────

const UnifiedDiffLine = ({
  line,
  highlight,
}: {
  line: DiffLineProps;
  highlight: HighlightedFile | null;
}) => {
  const tokens = getLineTokens(line, highlight);

  return (
    <div className={cn("flex text-xs font-mono leading-5 min-w-0", lineStyles[line.type])}>
      <span
        className={cn(
          "w-10 shrink-0 text-right px-1 select-none border-r border-border/40",
          lineGutterStyles[line.type],
        )}
      >
        {line.type === "header"
          ? "..."
          : line.type === "deletion"
            ? line.oldLineNo
            : line.type === "addition"
              ? ""
              : line.oldLineNo}
      </span>
      <span
        className={cn(
          "w-10 shrink-0 text-right px-1 select-none border-r border-border/40",
          lineGutterStyles[line.type],
        )}
      >
        {line.type === "header" ? "..." : line.type === "deletion" ? "" : line.newLineNo}
      </span>
      <span className="pl-2 whitespace-pre overflow-x-auto flex-1">
        <LineContent line={line} tokens={tokens} />
      </span>
    </div>
  );
};

// ── Split diff row ─────────────────────────────────────────

const SplitDiffHalf = ({
  line,
  side,
  tokens,
}: {
  line: DiffLineProps | null;
  side: "left" | "right";
  tokens: ThemedToken[] | null;
}) => {
  if (!line) {
    return (
      <div className="w-1/2 flex text-xs font-mono leading-5 min-w-0 bg-muted/20">
        <span className="w-10 shrink-0 border-r border-border/40" />
        <span className="flex-1" />
      </div>
    );
  }

  const lineNo = side === "left" ? line.oldLineNo : line.newLineNo;

  return (
    <div className={cn("w-1/2 flex text-xs font-mono leading-5 min-w-0", lineStyles[line.type])}>
      <span
        className={cn(
          "w-10 shrink-0 text-right px-1 select-none border-r border-border/40",
          lineGutterStyles[line.type],
        )}
      >
        {line.type === "header" ? "..." : lineNo}
      </span>
      <span className="pl-2 whitespace-pre overflow-x-auto flex-1">
        <LineContent line={line} tokens={tokens} />
      </span>
    </div>
  );
};

const SplitDiffRow = ({
  row,
  highlight,
}: {
  row: SplitRow;
  highlight: HighlightedFile | null;
}) => {
  if (row.isHeader && row.left) {
    return (
      <div className={cn("flex text-xs font-mono leading-5", lineStyles.header)}>
        <span className="w-full pl-2 whitespace-pre">{row.left.content}</span>
      </div>
    );
  }

  const leftTokens = row.left ? getLineTokens(row.left, highlight) : null;
  const rightTokens = row.right ? getLineTokens(row.right, highlight) : null;

  return (
    <div className="flex">
      <SplitDiffHalf line={row.left} side="left" tokens={leftTokens} />
      <div className="w-px bg-border/40 shrink-0" />
      <SplitDiffHalf line={row.right} side="right" tokens={rightTokens} />
    </div>
  );
};

// ── File path helpers ──────────────────────────────────────

const fileName = (path: string) => {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
};

const fileDir = (path: string) => {
  const parts = path.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") + "/";
};

// ── File diff section ──────────────────────────────────────

interface FileDiffSectionProps {
  file: DiffFile;
  defaultOpen?: boolean;
  viewMode: ViewMode;
  highlighter: Highlighter | null;
  isDark: boolean;
}

const FileDiffSection = ({
  file,
  defaultOpen = true,
  viewMode,
  highlighter,
  isDark,
}: FileDiffSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  const splitRows = useMemo(
    () => (viewMode === "split" ? pairLinesForSplit(lines) : []),
    [lines, viewMode],
  );
  const highlight = useFileHighlight(lines, file.path, highlighter, isDark, open);
  const Icon = statusIcon[file.status] ?? FileEdit;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border border-border rounded-md overflow-hidden"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors">
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform text-muted-foreground",
            open && "rotate-90",
          )}
        />
        <Icon
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            statusColor[file.status] ?? "text-muted-foreground",
          )}
        />
        <span className="text-xs font-mono truncate min-w-0">
          <span className="text-muted-foreground">{fileDir(file.path)}</span>
          <span className="font-medium">{fileName(file.path)}</span>
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs shrink-0">
          {file.additions > 0 && (
            <span className="text-green-600 dark:text-green-400 font-medium">
              +{file.additions}
            </span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-600 dark:text-red-400 font-medium">
              -{file.deletions}
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border overflow-x-auto">
          {lines.length > 0 ? (
            viewMode === "unified" ? (
              lines.map((line, i) => (
                <UnifiedDiffLine key={i} line={line} highlight={highlight} />
              ))
            ) : (
              splitRows.map((row, i) => (
                <SplitDiffRow key={i} row={row} highlight={highlight} />
              ))
            )
          ) : (
            <p className="text-xs text-muted-foreground px-3 py-2">No diff content available</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

// ── Main DiffViewer ────────────────────────────────────────

interface DiffViewerProps {
  files: DiffFile[];
}

export const DiffViewer = ({ files }: DiffViewerProps) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const highlighter = useHighlighter();
  const isDark = useIsDark();

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const scrollToFile = (path: string) => {
    setSelectedFile(path);
    const el = document.getElementById(`diff-file-${path.replace(/[^a-zA-Z0-9]/g, "-")}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4">
      {/* File tree summary + view mode toggle */}
      <div className="border border-border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400 font-medium">
                +{totalAdditions}
              </span>{" "}
              <span className="text-red-600 dark:text-red-400 font-medium">
                -{totalDeletions}
              </span>
            </span>
            <div className="flex items-center border border-border rounded-md overflow-hidden">
              <button
                type="button"
                onClick={() => setViewMode("unified")}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-xs transition-colors",
                  viewMode === "unified"
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/30",
                )}
              >
                <AlignJustify className="h-3 w-3" />
                Unified
              </button>
              <button
                type="button"
                onClick={() => setViewMode("split")}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 text-xs transition-colors border-l border-border",
                  viewMode === "split"
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/30",
                )}
              >
                <Columns2 className="h-3 w-3" />
                Split
              </button>
            </div>
          </div>
        </div>
        <ScrollArea className="max-h-48">
          <div className="space-y-0.5">
            {files.map((file) => {
              const Icon = statusIcon[file.status] ?? FileEdit;
              return (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => scrollToFile(file.path)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2 py-1 rounded text-xs font-mono hover:bg-accent/30 transition-colors text-left",
                    selectedFile === file.path && "bg-accent/40",
                  )}
                >
                  <Icon
                    className={cn(
                      "h-3 w-3 shrink-0",
                      statusColor[file.status] ?? "text-muted-foreground",
                    )}
                  />
                  <span className="truncate min-w-0">
                    <span className="text-muted-foreground">{fileDir(file.path)}</span>
                    <span>{fileName(file.path)}</span>
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    {file.additions > 0 && (
                      <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* File diffs */}
      <div className="space-y-3">
        {files.map((file) => (
          <div
            key={file.path}
            id={`diff-file-${file.path.replace(/[^a-zA-Z0-9]/g, "-")}`}
          >
            <FileDiffSection
              file={file}
              defaultOpen={files.length <= 10}
              viewMode={viewMode}
              highlighter={highlighter}
              isDark={isDark}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
