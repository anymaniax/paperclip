import { UserPlus, Lightbulb, ShieldCheck, GitMerge, GitBranch, FileCode } from "lucide-react";
import { Link } from "@/lib/router";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  merge_request: "Merge Request",
};

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  merge_request: GitMerge,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function MergeRequestPayload({ payload, approvalId }: { payload: Record<string, unknown>; approvalId?: string }) {
  const branch = String(payload.branch ?? "");
  const baseBranch = String(payload.baseBranch ?? "");
  const commitMessage = String(payload.commitMessage ?? "");
  const filesChanged = Array.isArray(payload.filesChanged) ? payload.filesChanged : [];
  const commitSha = String(payload.commitSha ?? "");

  return (
    <div className="mt-3 space-y-2 text-sm">
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2">
        <GitBranch className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-mono text-xs font-medium">{branch}</span>
        <span className="text-muted-foreground text-xs">&rarr;</span>
        <span className="font-mono text-xs font-medium">{baseBranch}</span>
        {commitSha && (
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {commitSha.slice(0, 7)}
          </span>
        )}
      </div>
      {commitMessage && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Message</span>
          <span className="text-muted-foreground text-xs">{commitMessage}</span>
        </div>
      )}
      {filesChanged.length > 0 && (
        <div className="flex items-center gap-2">
          <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground">
            {filesChanged.length} file{filesChanged.length !== 1 ? "s" : ""} changed
          </span>
          {approvalId && (
            <Link
              to={`/approvals/${approvalId}`}
              className="text-xs text-primary hover:underline ml-auto"
            >
              Review diff
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload, approvalId }: { type: string; payload: Record<string, unknown>; approvalId?: string }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "merge_request") return <MergeRequestPayload payload={payload} approvalId={approvalId} />;
  return <CeoStrategyPayload payload={payload} />;
}
