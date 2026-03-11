import { Router } from "express";
import fs from "node:fs";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  type MergeRequestPayload,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  gitDiff,
  gitMerge,
  heartbeatService,
  issueApprovalService,
  logActivity,
  projectService,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import { unprocessable } from "../errors.js";

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

export function approvalRoutes(db: Db) {
  const router = Router();
  const svc = approvalService(db);
  const heartbeat = heartbeatService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const projectsSvc = projectService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";

  async function resolveRepoPath(approval: { type: string; payload: Record<string, unknown>; id: string; companyId: string }): Promise<string> {
    const payload = approval.payload as Partial<MergeRequestPayload>;

    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);

    // Collect all registered workspace cwds for validation
    const registeredCwds = new Set<string>();
    for (const issue of linkedIssues) {
      if (issue.projectId) {
        const workspaces = await projectsSvc.listWorkspaces(issue.projectId);
        for (const ws of workspaces) {
          if (ws.cwd) registeredCwds.add(ws.cwd);
        }
      }
    }

    if (payload.repoPath) {
      // If path exists on disk and is a registered workspace (or no workspaces registered), use it
      const pathExists = fs.existsSync(payload.repoPath);
      if (pathExists && (registeredCwds.size === 0 || registeredCwds.has(payload.repoPath))) {
        return payload.repoPath;
      }
      // Path is gone (e.g. cleaned-up worktree) or not registered — fall through to primary workspace
    }

    // Fall back to primary workspace cwd
    for (const issue of linkedIssues) {
      if (issue.projectId) {
        const project = await projectsSvc.getById(issue.projectId);
        if (project?.primaryWorkspace?.cwd) return project.primaryWorkspace.cwd;
      }
    }

    throw unprocessable("Cannot resolve repository path: no repoPath in payload and no linked issue project workspace");
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    // Auto-approve + auto-merge for merge_request when project policy is auto_merge
    if (approval.type === "merge_request") {
      let mergeReviewPolicy = "required";
      for (const issueId of uniqueIssueIds) {
        const issue = await db
          .select()
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0] ?? null);
        if (issue?.projectId) {
          const project = await projectsSvc.getById(issue.projectId);
          if (project) {
            mergeReviewPolicy = project.mergeReviewPolicy ?? "required";
            break;
          }
        }
      }

      if (mergeReviewPolicy === "auto_merge") {
        const { approval: approved } = await svc.approve(approval.id, "system:auto_merge", "Auto-approved per project auto_merge policy");
        await logActivity(db, {
          companyId,
          actorType: "system",
          actorId: "auto_merge",
          action: "approval.auto_approved",
          entityType: "approval",
          entityId: approval.id,
          details: { policy: "auto_merge" },
        });
        res.status(201).json(redactApprovalPayload(approved));
        return;
      }
    }

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { approval, applied } = await svc.approve(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const { approval, applied } = await svc.reject(
      id,
      req.body.decidedByUserId ?? "board",
      req.body.decisionNote,
    );

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      const approval = await svc.requestRevision(
        id,
        req.body.decidedByUserId ?? "board",
        req.body.decisionNote,
      );

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  // ── Merge-request endpoints ──────────────────────────────────────────

  router.get("/approvals/:id/diff", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);

    if (approval.type !== "merge_request") {
      res.status(422).json({ error: "Diff is only available for merge_request approvals" });
      return;
    }

    const payload = approval.payload as Partial<MergeRequestPayload>;
    if (!payload.branch || !payload.baseBranch) {
      res.status(422).json({ error: "Approval payload missing branch or baseBranch" });
      return;
    }

    const repoPath = await resolveRepoPath(approval);
    const diff = await gitDiff(repoPath, payload.baseBranch, payload.branch);
    res.json(diff);
  });

  router.post("/approvals/:id/merge", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);

    if (approval.type !== "merge_request") {
      res.status(422).json({ error: "Merge is only available for merge_request approvals" });
      return;
    }

    // Resolve project and check merge review policy
    const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(id);
    let mergeReviewPolicy = "required";
    for (const issue of linkedIssues) {
      if (issue.projectId) {
        const project = await projectsSvc.getById(issue.projectId);
        if (project) {
          mergeReviewPolicy = project.mergeReviewPolicy ?? "required";
          break;
        }
      }
    }

    // Policy enforcement: if required, must be approved first
    if (mergeReviewPolicy === "required" && approval.status !== "approved") {
      res.status(422).json({ error: "Merge requires approval first (project policy: required)" });
      return;
    }

    if (mergeReviewPolicy === "disabled") {
      res.status(422).json({ error: "Merge-request approvals are disabled for this project" });
      return;
    }

    const payload = approval.payload as Partial<MergeRequestPayload>;
    if (!payload.branch || !payload.baseBranch) {
      res.status(422).json({ error: "Approval payload missing branch or baseBranch" });
      return;
    }

    const repoPath = await resolveRepoPath(approval);
    const result = await gitMerge(repoPath, payload.baseBranch, payload.branch);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: result.success ? "approval.merge_completed" : "approval.merge_failed",
      entityType: "approval",
      entityId: approval.id,
      details: {
        branch: payload.branch,
        baseBranch: payload.baseBranch,
        mergeCommitSha: result.mergeCommitSha ?? null,
        conflictDetails: result.conflictDetails ?? null,
      },
    });

    res.json(result);
  });

  return router;
}
