import { useState, useMemo, useEffect, useCallback } from "react";
import {
  ChevronRight,
  File,
  FilePlus,
  FileX,
  FileEdit,
  FileDiff,
  Columns2,
  AlignJustify,
  MessageSquarePlus,
  Send,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { createHighlighter, type BundledLanguage, type Highlighter, type ThemedToken } from "shiki";
import type { ApprovalComment } from "@paperclipai/shared";
import type { DiffFile } from "../api/approvals";
import { Identity } from "./Identity";
import { MarkdownBody } from "./MarkdownBody";

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

// Eagerly kick off initialization so the highlighter is ready by the time
// any DiffViewer mounts, rather than waiting until first render.
initHighlighter();

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
): HighlightedFile | null =>
  useMemo(() => {
    if (!highlighter) return null;

    const lang = detectLang(filePath);
    if (!lang) return null;

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
  }, [lines, filePath, highlighter, isDark]);

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

// ── Inline comment types ──────────────────────────────────

interface ActiveCommentLine {
  filePath: string;
  lineNumber: number;
  side: "old" | "new";
}

// ── Inline comment form ──────────────────────────────────

const InlineCommentForm = ({
  onSubmit,
  onCancel,
  isPending,
}: {
  onSubmit: (body: string) => void;
  onCancel: () => void;
  isPending: boolean;
}) => {
  const [body, setBody] = useState("");

  return (
    <div className="border border-blue-300 dark:border-blue-700/50 bg-blue-50/50 dark:bg-blue-950/20 rounded-md mx-2 my-1 p-2 space-y-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a review comment..."
        rows={2}
        className="text-sm"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) {
            onSubmit(body.trim());
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPending}>
          <X className="h-3 w-3 mr-1" />
          Cancel
        </Button>
        <Button
          size="sm"
          onClick={() => onSubmit(body.trim())}
          disabled={!body.trim() || isPending}
        >
          <Send className="h-3 w-3 mr-1" />
          {isPending ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
};

// ── Inline comment block ──────────────────────────────────

const InlineCommentBlock = ({
  comments,
  agentNameById,
}: {
  comments: ApprovalComment[];
  agentNameById?: Map<string, string>;
}) => (
  <div className="border-l-2 border-blue-400 dark:border-blue-600 bg-blue-50/30 dark:bg-blue-950/10 mx-2 my-1 rounded-r-md">
    {comments.map((comment) => (
      <div key={comment.id} className="px-3 py-2 border-b border-border/30 last:border-b-0">
        <div className="flex items-center justify-between mb-1">
          {comment.authorAgentId ? (
            <Identity
              name={agentNameById?.get(comment.authorAgentId) ?? comment.authorAgentId.slice(0, 8)}
              size="sm"
            />
          ) : (
            <Identity name="Board" size="sm" />
          )}
          <span className="text-[10px] text-muted-foreground">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
        </div>
        <MarkdownBody className="text-xs">{comment.body}</MarkdownBody>
      </div>
    ))}
  </div>
);

// ── Comment gutter button ─────────────────────────────────

const CommentGutterButton = ({
  onClick,
}: {
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="absolute left-1 top-1/2 -translate-y-1/2 z-10 opacity-0 group-hover/line:opacity-100 transition-opacity bg-blue-500 hover:bg-blue-600 text-white rounded-full h-5 w-5 flex items-center justify-center shadow-sm"
    title="Add review comment"
  >
    <MessageSquarePlus className="h-3 w-3" />
  </button>
);

// ── Unified diff line ──────────────────────────────────────

const UnifiedDiffLine = ({
  line,
  highlight,
  filePath,
  onAddCommentClick,
  inlineComments,
  activeComment,
  onSubmitComment,
  onCancelComment,
  isCommentPending,
  agentNameById,
}: {
  line: DiffLineProps;
  highlight: HighlightedFile | null;
  filePath?: string;
  onAddCommentClick?: (lineNumber: number, side: "old" | "new") => void;
  inlineComments?: ApprovalComment[];
  activeComment?: ActiveCommentLine | null;
  onSubmitComment?: (body: string) => void;
  onCancelComment?: () => void;
  isCommentPending?: boolean;
  agentNameById?: Map<string, string>;
}) => {
  const tokens = getLineTokens(line, highlight);
  const lineNumber = line.type === "deletion" ? line.oldLineNo : line.newLineNo;
  const side: "old" | "new" = line.type === "deletion" ? "old" : "new";
  const canComment = onAddCommentClick && line.type !== "header" && lineNumber != null;

  const isActiveCommentLine =
    activeComment &&
    filePath &&
    activeComment.filePath === filePath &&
    activeComment.lineNumber === lineNumber &&
    activeComment.side === side;

  const lineComments =
    inlineComments?.filter(
      (c) => c.lineNumber === lineNumber && c.side === side,
    ) ?? [];

  return (
    <>
      <div className={cn("flex text-xs font-mono leading-5 relative", canComment && "group/line", lineStyles[line.type])}>
        {canComment && (
          <CommentGutterButton onClick={() => onAddCommentClick(lineNumber!, side)} />
        )}
        <span
          className={cn(
            "w-8 sm:w-10 shrink-0 text-right px-1 select-none border-r border-border/40",
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
            "w-8 sm:w-10 shrink-0 text-right px-1 select-none border-r border-border/40",
            lineGutterStyles[line.type],
          )}
        >
          {line.type === "header" ? "..." : line.type === "deletion" ? "" : line.newLineNo}
        </span>
        <span className="pl-2 whitespace-pre flex-1">
          <LineContent line={line} tokens={tokens} />
        </span>
      </div>
      {lineComments.length > 0 && (
        <InlineCommentBlock comments={lineComments} agentNameById={agentNameById} />
      )}
      {isActiveCommentLine && onSubmitComment && onCancelComment && (
        <InlineCommentForm
          onSubmit={onSubmitComment}
          onCancel={onCancelComment}
          isPending={isCommentPending ?? false}
        />
      )}
    </>
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
      <div className="w-1/2 flex text-xs font-mono leading-5 bg-muted/20">
        <span className="w-8 sm:w-10 shrink-0 border-r border-border/40" />
        <span className="flex-1" />
      </div>
    );
  }

  const lineNo = side === "left" ? line.oldLineNo : line.newLineNo;

  return (
    <div className={cn("w-1/2 flex text-xs font-mono leading-5", lineStyles[line.type])}>
      <span
        className={cn(
          "w-8 sm:w-10 shrink-0 text-right px-1 select-none border-r border-border/40",
          lineGutterStyles[line.type],
        )}
      >
        {line.type === "header" ? "..." : lineNo}
      </span>
      <span className="pl-2 whitespace-pre flex-1">
        <LineContent line={line} tokens={tokens} />
      </span>
    </div>
  );
};

const SplitDiffRow = ({
  row,
  highlight,
  filePath,
  onAddCommentClick,
  inlineComments,
  activeComment,
  onSubmitComment,
  onCancelComment,
  isCommentPending,
  agentNameById,
}: {
  row: SplitRow;
  highlight: HighlightedFile | null;
  filePath?: string;
  onAddCommentClick?: (lineNumber: number, side: "old" | "new") => void;
  inlineComments?: ApprovalComment[];
  activeComment?: ActiveCommentLine | null;
  onSubmitComment?: (body: string) => void;
  onCancelComment?: () => void;
  isCommentPending?: boolean;
  agentNameById?: Map<string, string>;
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

  // Check for inline comments on left (old) and right (new) sides
  const leftLineNo = row.left?.oldLineNo;
  const rightLineNo = row.right?.newLineNo;
  const leftComments = inlineComments?.filter(
    (c) => c.lineNumber === leftLineNo && c.side === "old",
  ) ?? [];
  const rightComments = inlineComments?.filter(
    (c) => c.lineNumber === rightLineNo && c.side === "new",
  ) ?? [];
  const hasComments = leftComments.length > 0 || rightComments.length > 0;

  const isLeftActive =
    activeComment &&
    filePath &&
    activeComment.filePath === filePath &&
    activeComment.lineNumber === leftLineNo &&
    activeComment.side === "old";
  const isRightActive =
    activeComment &&
    filePath &&
    activeComment.filePath === filePath &&
    activeComment.lineNumber === rightLineNo &&
    activeComment.side === "new";
  const hasActiveForm = isLeftActive || isRightActive;

  const canCommentLeft = onAddCommentClick && row.left && row.left.type !== "header" && leftLineNo != null;
  const canCommentRight = onAddCommentClick && row.right && row.right.type !== "header" && rightLineNo != null;

  return (
    <>
      <div className="flex">
        <div className={cn("w-1/2 relative", canCommentLeft && "group/line")}>
          {canCommentLeft && (
            <CommentGutterButton onClick={() => onAddCommentClick(leftLineNo!, "old")} />
          )}
          <SplitDiffHalf line={row.left} side="left" tokens={leftTokens} />
        </div>
        <div className="w-px bg-border/40 shrink-0" />
        <div className={cn("w-1/2 relative", canCommentRight && "group/line")}>
          {canCommentRight && (
            <CommentGutterButton onClick={() => onAddCommentClick(rightLineNo!, "new")} />
          )}
          <SplitDiffHalf line={row.right} side="right" tokens={rightTokens} />
        </div>
      </div>
      {hasComments && (
        <div className="flex">
          <div className="w-1/2">
            {leftComments.length > 0 && (
              <InlineCommentBlock comments={leftComments} agentNameById={agentNameById} />
            )}
          </div>
          <div className="w-px bg-border/40 shrink-0" />
          <div className="w-1/2">
            {rightComments.length > 0 && (
              <InlineCommentBlock comments={rightComments} agentNameById={agentNameById} />
            )}
          </div>
        </div>
      )}
      {hasActiveForm && onSubmitComment && onCancelComment && (
        <InlineCommentForm
          onSubmit={onSubmitComment}
          onCancel={onCancelComment}
          isPending={isCommentPending ?? false}
        />
      )}
    </>
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
  inlineComments?: ApprovalComment[];
  onAddComment?: (filePath: string, lineNumber: number, side: "old" | "new", body: string) => Promise<void>;
  agentNameById?: Map<string, string>;
}

const FileDiffSection = ({
  file,
  defaultOpen = true,
  viewMode,
  highlighter,
  isDark,
  inlineComments,
  onAddComment,
  agentNameById,
}: FileDiffSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const [activeComment, setActiveComment] = useState<ActiveCommentLine | null>(null);
  const [isCommentPending, setIsCommentPending] = useState(false);
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  const splitRows = useMemo(
    () => (viewMode === "split" ? pairLinesForSplit(lines) : []),
    [lines, viewMode],
  );
  const highlight = useFileHighlight(lines, file.path, highlighter, isDark);
  const Icon = statusIcon[file.status] ?? FileEdit;

  const fileComments = useMemo(
    () => inlineComments?.filter((c) => c.filePath === file.path) ?? [],
    [inlineComments, file.path],
  );

  const commentCount = fileComments.length;

  const handleAddCommentClick = useCallback(
    (lineNumber: number, side: "old" | "new") => {
      if (!onAddComment) return;
      setActiveComment({ filePath: file.path, lineNumber, side });
    },
    [onAddComment, file.path],
  );

  const handleSubmitComment = useCallback(
    async (body: string) => {
      if (!onAddComment || !activeComment) return;
      setIsCommentPending(true);
      try {
        await onAddComment(activeComment.filePath, activeComment.lineNumber, activeComment.side, body);
        setActiveComment(null);
      } finally {
        setIsCommentPending(false);
      }
    },
    [onAddComment, activeComment],
  );

  const handleCancelComment = useCallback(() => {
    setActiveComment(null);
  }, []);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border border-border rounded-md overflow-clip"
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
          {commentCount > 0 && (
            <span className="text-blue-600 dark:text-blue-400 font-medium flex items-center gap-0.5">
              <MessageSquarePlus className="h-3 w-3" />
              {commentCount}
            </span>
          )}
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
            <div className="w-fit min-w-full">
              {viewMode === "unified" ? (
                lines.map((line, i) => (
                  <UnifiedDiffLine
                    key={i}
                    line={line}
                    highlight={highlight}
                    filePath={file.path}
                    onAddCommentClick={onAddComment ? handleAddCommentClick : undefined}
                    inlineComments={fileComments}
                    activeComment={activeComment}
                    onSubmitComment={handleSubmitComment}
                    onCancelComment={handleCancelComment}
                    isCommentPending={isCommentPending}
                    agentNameById={agentNameById}
                  />
                ))
              ) : (
                splitRows.map((row, i) => (
                  <SplitDiffRow
                    key={i}
                    row={row}
                    highlight={highlight}
                    filePath={file.path}
                    onAddCommentClick={onAddComment ? handleAddCommentClick : undefined}
                    inlineComments={fileComments}
                    activeComment={activeComment}
                    onSubmitComment={handleSubmitComment}
                    onCancelComment={handleCancelComment}
                    isCommentPending={isCommentPending}
                    agentNameById={agentNameById}
                  />
                ))
              )}
            </div>
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
  inlineComments?: ApprovalComment[];
  onAddComment?: (filePath: string, lineNumber: number, side: "old" | "new", body: string) => Promise<void>;
  agentNameById?: Map<string, string>;
}

const useIsMobile = (breakpoint = 640): boolean => {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < breakpoint,
  );
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [breakpoint]);
  return isMobile;
};

export const DiffViewer = ({ files, inlineComments, onAddComment, agentNameById }: DiffViewerProps) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const highlighter = useHighlighter();
  const isDark = useIsDark();

  // Auto-switch to unified view on mobile
  useEffect(() => {
    if (isMobile && viewMode === "split") {
      setViewMode("unified");
    }
  }, [isMobile, viewMode]);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const totalInlineComments = inlineComments?.length ?? 0;

  const scrollToFile = (path: string) => {
    setSelectedFile(path);
    const el = document.getElementById(`diff-file-${path.replace(/[^a-zA-Z0-9]/g, "-")}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4">
      {/* File tree summary + view mode toggle */}
      <div className="border border-border rounded-lg p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground flex items-center gap-2">
              {totalInlineComments > 0 && (
                <span className="text-blue-600 dark:text-blue-400 font-medium flex items-center gap-0.5">
                  <MessageSquarePlus className="h-3 w-3" />
                  {totalInlineComments}
                </span>
              )}
              <span className="text-green-600 dark:text-green-400 font-medium">
                +{totalAdditions}
              </span>
              <span className="text-red-600 dark:text-red-400 font-medium">
                -{totalDeletions}
              </span>
            </span>
            {!isMobile && (
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
            )}
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
              inlineComments={inlineComments}
              onAddComment={onAddComment}
              agentNameById={agentNameById}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
