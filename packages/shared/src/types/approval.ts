import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface ApprovalLinkedProject {
  id: string;
  name: string;
  urlKey: string | null;
}

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  linkedProject?: ApprovalLinkedProject | null;
}

export interface MergeRequestPayload {
  branch: string;
  baseBranch: string;
  repoPath?: string;
  diffSummary: string;
  filesChanged: string[];
  commitSha: string;
  commitMessage: string;
  autoMergeOnApproval?: boolean;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  filePath: string | null;
  lineNumber: number | null;
  side: string | null;
  createdAt: Date;
  updatedAt: Date;
}
