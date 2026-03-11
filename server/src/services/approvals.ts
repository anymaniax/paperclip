import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals } from "@paperclipai/db";
import type { MergeRequestPayload } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { notifyHireApproved } from "./hire-hook.js";
import { gitMerge } from "./git-operations.js";
import { issueApprovalService } from "./issue-approvals.js";
import { projectService } from "./projects.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const projectsSvc = projectService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findExistingMergeRequest: (companyId: string, branch: string, baseBranch: string) =>
      db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "merge_request"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload}->>'branch' = ${branch}`,
            sql`${approvals.payload}->>'baseBranch' = ${baseBranch}`,
          ),
        )
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      // Auto-merge hook for merge_request approvals
      if (applied && updated.type === "merge_request") {
        const mrPayload = updated.payload as Partial<MergeRequestPayload>;
        if (mrPayload.autoMergeOnApproval && mrPayload.branch && mrPayload.baseBranch) {
          try {
            let repoPath = mrPayload.repoPath;
            if (!repoPath) {
              const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(id);
              for (const issue of linkedIssues) {
                if (issue.projectId) {
                  const project = await projectsSvc.getById(issue.projectId);
                  if (project?.primaryWorkspace?.cwd) {
                    repoPath = project.primaryWorkspace.cwd;
                    break;
                  }
                }
              }
            }
            if (repoPath) {
              const mergeResult = await gitMerge(repoPath, mrPayload.baseBranch, mrPayload.branch);
              await logActivity(db, {
                companyId: updated.companyId,
                actorType: "system",
                actorId: "auto-merge",
                action: mergeResult.success ? "approval.auto_merge_completed" : "approval.auto_merge_failed",
                entityType: "approval",
                entityId: id,
                details: {
                  branch: mrPayload.branch,
                  baseBranch: mrPayload.baseBranch,
                  mergeCommitSha: mergeResult.mergeCommitSha ?? null,
                  conflictDetails: mergeResult.conflictDetails ?? null,
                },
              });
            }
          } catch (err) {
            logger.warn({ err, approvalId: id }, "auto-merge failed after approval");
            await logActivity(db, {
              companyId: updated.companyId,
              actorType: "system",
              actorId: "auto-merge",
              action: "approval.auto_merge_failed",
              entityType: "approval",
              entityId: id,
              details: {
                branch: mrPayload.branch,
                baseBranch: mrPayload.baseBranch,
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
      lineContext?: { filePath: string; lineNumber: number; side: "old" | "new" },
    ) => {
      const existing = await getExistingApproval(approvalId);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body,
          filePath: lineContext?.filePath ?? null,
          lineNumber: lineContext?.lineNumber ?? null,
          side: lineContext?.side ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
