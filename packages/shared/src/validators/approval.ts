import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";

const mergeRequestPayloadSchema = z.object({
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  repoPath: z.string().optional(),
  diffSummary: z.string(),
  filesChanged: z.array(z.string()),
  commitSha: z.string().min(1),
  commitMessage: z.string().min(1),
  autoMergeOnApproval: z.boolean().optional(),
});

export const createApprovalSchema = z
  .object({
    type: z.enum(APPROVAL_TYPES),
    requestedByAgentId: z.string().uuid().optional().nullable(),
    payload: z.record(z.unknown()),
    issueIds: z.array(z.string().uuid()).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "merge_request") {
      const result = mergeRequestPayloadSchema.safeParse(data.payload);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            ...issue,
            path: ["payload", ...issue.path],
          });
        }
      }
    }
  });

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: z.string().optional().nullable(),
  decidedByUserId: z.string().optional().default("board"),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: z.string().min(1),
  filePath: z.string().optional(),
  lineNumber: z.number().int().positive().optional(),
  side: z.enum(["old", "new"]).optional(),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
