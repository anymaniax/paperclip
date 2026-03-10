import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { Identity } from "../components/Identity";
import { typeLabel, typeIcon, defaultTypeIcon, ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { PageSkeleton } from "../components/PageSkeleton";
import { DiffViewer } from "../components/DiffViewer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, ChevronRight, GitBranch, GitMerge, Sparkles, AlertTriangle } from "lucide-react";
import type { ApprovalComment } from "@paperclipai/shared";
import { MarkdownBody } from "../components/MarkdownBody";
import type { MergeResult } from "../api/approvals";

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const [mergeResult, setMergeResult] = useState<MergeResult | null>(null);

  const { data: approval, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!),
    queryFn: () => approvalsApi.get(approvalId!),
    enabled: !!approvalId,
  });
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const isMergeRequest = approval?.type === "merge_request";
  const payload = (approval?.payload ?? {}) as Record<string, unknown>;

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  const { data: diffResult, isLoading: isDiffLoading } = useQuery({
    queryKey: queryKeys.approvals.diff(approvalId!),
    queryFn: () => approvalsApi.getDiff(approvalId!),
    enabled: !!approvalId && isMergeRequest,
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Approvals", href: "/approvals" },
      { label: approval?.id?.slice(0, 8) ?? approvalId ?? "Approval" },
    ]);
  }, [setBreadcrumbs, approval, approvalId]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.diff(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.approvals.list(approval.companyId, "pending"),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const { mutate: approveAndMerge, isPending: isApproveAndMerging } = useMutation({
    mutationFn: async () => {
      await approvalsApi.approve(approvalId!);
      try {
        return await approvalsApi.merge(approvalId!);
      } catch (mergeErr) {
        throw new Error(
          `Approval succeeded but merge failed: ${mergeErr instanceof Error ? mergeErr.message : "unknown error"}. The approval is now in "approved" state — you can retry the merge separately.`,
        );
      }
    },
    onSuccess: (result) => {
      setError(null);
      setMergeResult(result);
      refresh();
      if (result.success) {
        navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve & merge failed"),
  });

  const { mutate: mergeOnly, isPending: isMerging } = useMutation({
    mutationFn: () => approvalsApi.merge(approvalId!),
    onSuccess: (result) => {
      setError(null);
      setMergeResult(result);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Merge failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agentId: string) => agentsApi.remove(agentId),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate("/approvals");
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Delete failed"),
  });

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const TypeIcon = typeIcon[approval.type] ?? defaultTypeIcon;
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label:
            (linkedIssues?.length ?? 0) > 1
              ? "Review linked issues"
              : "Review linked issue",
          to: `/issues/${primaryLinkedIssue.identifier ?? primaryLinkedIssue.id}`,
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: "Back to approvals",
            to: "/approvals",
          };

  const canMerge = isMergeRequest && approval.status === "approved" && !mergeResult?.success;

  return (
    <div className="space-y-6 max-w-3xl">
      {showApprovedBanner && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="h-3 w-3 text-green-500 dark:text-green-200 absolute -right-2 -top-1 animate-pulse" />
              </div>
              <div>
                <p className="text-sm text-green-800 dark:text-green-100 font-medium">
                  {isMergeRequest ? "Approved & merged" : "Approval confirmed"}
                </p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  {isMergeRequest
                    ? "Code has been merged successfully."
                    : "Requesting agent was notified to review this approval and linked issues."}
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 dark:border-green-600/50 text-green-800 dark:text-green-100 hover:bg-green-100 dark:hover:bg-green-900/30 w-full sm:w-auto"
              onClick={() => navigate(resolvedCta.to)}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      )}

      {/* Merge result banner */}
      {mergeResult && !mergeResult.success && (
        <div className="border border-red-300 dark:border-red-700/40 bg-red-50 dark:bg-red-900/20 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm text-red-800 dark:text-red-100 font-medium">Merge failed</p>
              <p className="text-xs text-red-700 dark:text-red-200/90 mt-1 font-mono whitespace-pre-wrap">
                {mergeResult.conflictDetails ?? "Unknown error during merge"}
              </p>
            </div>
          </div>
        </div>
      )}

      {mergeResult?.success && (
        <div className="border border-green-300 dark:border-green-700/40 bg-green-50 dark:bg-green-900/20 rounded-lg px-4 py-3">
          <div className="flex items-start gap-2">
            <GitMerge className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm text-green-800 dark:text-green-100 font-medium">Merged successfully</p>
              {mergeResult.mergeCommitSha && (
                <p className="text-xs text-green-700 dark:text-green-200/90 font-mono mt-0.5">
                  Commit: {mergeResult.mergeCommitSha.slice(0, 7)}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="border border-border rounded-lg p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <TypeIcon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{typeLabel[approval.type] ?? approval.type.replace(/_/g, " ")}</h2>
              <p className="text-xs text-muted-foreground font-mono truncate">{approval.id}</p>
            </div>
          </div>
          <StatusBadge status={approval.status} />
        </div>

        {/* Branch info bar for merge requests */}
        {isMergeRequest && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-3 py-2">
            <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-mono text-xs font-medium break-all">{String(payload.branch ?? "")}</span>
            <span className="text-muted-foreground text-xs">&rarr;</span>
            <span className="font-mono text-xs font-medium break-all">{String(payload.baseBranch ?? "")}</span>
            {typeof payload.commitSha === "string" && (
              <span className="sm:ml-auto font-mono text-[10px] text-muted-foreground">
                {payload.commitSha.slice(0, 7)}
              </span>
            )}
          </div>
        )}

        {/* Commit message for merge requests */}
        {isMergeRequest && typeof payload.commitMessage === "string" && (
          <div className="text-sm">
            <p className="text-xs text-muted-foreground mb-1">Commit message</p>
            <p className="text-sm font-mono bg-muted/30 rounded px-2 py-1.5">{payload.commitMessage}</p>
          </div>
        )}

        <div className="text-sm space-y-1">
          {approval.requestedByAgentId && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">Requested by</span>
              <Identity
                name={agentNameById.get(approval.requestedByAgentId) ?? approval.requestedByAgentId.slice(0, 8)}
                size="sm"
              />
            </div>
          )}
          {!isMergeRequest && (
            <ApprovalPayloadRenderer type={approval.type} payload={payload} />
          )}
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-2"
            onClick={() => setShowRawPayload((v) => !v)}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${showRawPayload ? "rotate-90" : ""}`} />
            See full request
          </button>
          {showRawPayload && (
            <pre className="text-xs bg-muted/40 rounded-md p-3 overflow-x-auto">
              {JSON.stringify(payload, null, 2)}
            </pre>
          )}
          {approval.decisionNote && (
            <p className="text-xs text-muted-foreground">Decision note: {approval.decisionNote}</p>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {linkedIssues && linkedIssues.length > 0 && (
          <div className="pt-2 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-1.5">Linked Issues</p>
            <div className="space-y-1.5">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={`/issues/${issue.identifier ?? issue.id}`}
                  className="block text-xs rounded border border-border/70 px-2 py-1.5 hover:bg-accent/20"
                >
                  <span className="font-mono text-muted-foreground mr-2">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Linked issues remain open until the requesting agent follows up and closes them.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {isActionable && !isMergeRequest && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                Reject
              </Button>
            </>
          )}
          {isActionable && isMergeRequest && (
            <>
              <Button
                size="sm"
                className="bg-green-700 hover:bg-green-600 text-white"
                onClick={() => approveAndMerge()}
                disabled={isApproveAndMerging}
              >
                <GitMerge className="h-3.5 w-3.5 mr-1.5" />
                {isApproveAndMerging ? "Merging\u2026" : "Approve & Merge"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => rejectMutation.mutate()}
                disabled={rejectMutation.isPending}
              >
                Reject
              </Button>
            </>
          )}
          {canMerge && (
            <Button
              size="sm"
              className="bg-green-700 hover:bg-green-600 text-white"
              onClick={() => mergeOnly()}
              disabled={isMerging}
            >
              <GitMerge className="h-3.5 w-3.5 mr-1.5" />
              {isMerging ? "Merging\u2026" : "Merge now"}
            </Button>
          )}
          {approval.status === "pending" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => revisionMutation.mutate()}
              disabled={revisionMutation.isPending}
            >
              Request revision
            </Button>
          )}
          {approval.status === "revision_requested" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => resubmitMutation.mutate()}
              disabled={resubmitMutation.isPending}
            >
              Mark resubmitted
            </Button>
          )}
          {approval.status === "rejected" && approval.type === "hire_agent" && linkedAgentId && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/40"
              onClick={() => {
                if (!window.confirm("Delete this disapproved agent? This cannot be undone.")) return;
                deleteAgentMutation.mutate(linkedAgentId);
              }}
              disabled={deleteAgentMutation.isPending}
            >
              Delete disapproved agent
            </Button>
          )}
        </div>
      </div>

      {/* Diff viewer for merge requests */}
      {isMergeRequest && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Code Changes</h3>
          {isDiffLoading ? (
            <div className="border border-border rounded-lg p-6 text-center">
              <p className="text-sm text-muted-foreground">Loading diff...</p>
            </div>
          ) : diffResult?.files && diffResult.files.length > 0 ? (
            <DiffViewer files={diffResult.files} />
          ) : (
            <div className="border border-border rounded-lg p-6 text-center">
              <p className="text-sm text-muted-foreground">No file changes found</p>
            </div>
          )}
        </div>
      )}

      <div className="border border-border rounded-lg p-4 space-y-3">
        <h3 className="text-sm font-medium">Comments ({comments?.length ?? 0})</h3>
        <div className="space-y-2">
          {(comments ?? []).map((comment: ApprovalComment) => (
            <div key={comment.id} className="border border-border/60 rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                {comment.authorAgentId ? (
                  <Link to={`/agents/${comment.authorAgentId}`} className="hover:underline">
                    <Identity
                      name={agentNameById.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
                      size="sm"
                    />
                  </Link>
                ) : (
                  <Identity name="Board" size="sm" />
                )}
                <span className="text-xs text-muted-foreground">
                  {new Date(comment.createdAt).toLocaleString()}
                </span>
              </div>
              <MarkdownBody className="text-sm">{comment.body}</MarkdownBody>
            </div>
          ))}
        </div>
        <Textarea
          value={commentBody}
          onChange={(e) => setCommentBody(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => addCommentMutation.mutate()}
            disabled={!commentBody.trim() || addCommentMutation.isPending}
          >
            {addCommentMutation.isPending ? "Posting\u2026" : "Post comment"}
          </Button>
        </div>
      </div>
    </div>
  );
}
