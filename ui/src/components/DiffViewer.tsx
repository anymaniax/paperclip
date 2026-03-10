import { useState, useMemo } from "react";
import { ChevronRight, File, FilePlus, FileX, FileEdit, FileDiff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { DiffFile } from "../api/approvals";

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

interface DiffLineProps {
  type: "addition" | "deletion" | "context" | "header";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

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
      // "\ No newline at end of file" — skip
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

const lineStyles: Record<DiffLineProps["type"], string> = {
  addition: "bg-green-500/10 text-green-800 dark:text-green-200",
  deletion: "bg-red-500/10 text-red-800 dark:text-red-200",
  context: "",
  header: "bg-blue-500/10 text-blue-700 dark:text-blue-300 font-medium",
};

const lineGutterStyles: Record<DiffLineProps["type"], string> = {
  addition: "bg-green-500/20 text-green-700 dark:text-green-400",
  deletion: "bg-red-500/20 text-red-700 dark:text-red-400",
  context: "text-muted-foreground",
  header: "bg-blue-500/15",
};

const DiffLine = ({ type, content, oldLineNo, newLineNo }: DiffLineProps) => (
  <div className={cn("flex text-xs font-mono leading-5 min-w-0", lineStyles[type])}>
    <span className={cn("w-10 shrink-0 text-right px-1 select-none border-r border-border/40", lineGutterStyles[type])}>
      {type === "header" ? "..." : (type === "deletion" ? oldLineNo : type === "addition" ? "" : oldLineNo)}
    </span>
    <span className={cn("w-10 shrink-0 text-right px-1 select-none border-r border-border/40", lineGutterStyles[type])}>
      {type === "header" ? "..." : (type === "deletion" ? "" : newLineNo)}
    </span>
    <span className="pl-2 whitespace-pre overflow-x-auto flex-1">
      {type === "addition" && <span className="select-none text-green-600 dark:text-green-400 mr-1">+</span>}
      {type === "deletion" && <span className="select-none text-red-600 dark:text-red-400 mr-1">-</span>}
      {type === "context" && <span className="select-none mr-1">&nbsp;</span>}
      {type === "header" ? content : content}
    </span>
  </div>
);

const fileName = (path: string) => {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
};

const fileDir = (path: string) => {
  const parts = path.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/") + "/";
};

interface FileDiffSectionProps {
  file: DiffFile;
  defaultOpen?: boolean;
}

const FileDiffSection = ({ file, defaultOpen = true }: FileDiffSectionProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const lines = useMemo(() => parsePatch(file.patch), [file.patch]);
  const Icon = statusIcon[file.status] ?? FileEdit;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border border-border rounded-md overflow-hidden">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors">
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform text-muted-foreground", open && "rotate-90")} />
        <Icon className={cn("h-3.5 w-3.5 shrink-0", statusColor[file.status] ?? "text-muted-foreground")} />
        <span className="text-xs font-mono truncate min-w-0">
          <span className="text-muted-foreground">{fileDir(file.path)}</span>
          <span className="font-medium">{fileName(file.path)}</span>
        </span>
        <span className="ml-auto flex items-center gap-2 text-xs shrink-0">
          {file.additions > 0 && (
            <span className="text-green-600 dark:text-green-400 font-medium">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-red-600 dark:text-red-400 font-medium">-{file.deletions}</span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border overflow-x-auto">
          {lines.length > 0 ? (
            lines.map((line, i) => <DiffLine key={i} {...line} />)
          ) : (
            <p className="text-xs text-muted-foreground px-3 py-2">No diff content available</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

interface DiffViewerProps {
  files: DiffFile[];
}

export const DiffViewer = ({ files }: DiffViewerProps) => {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const scrollToFile = (path: string) => {
    setSelectedFile(path);
    const el = document.getElementById(`diff-file-${path.replace(/[^a-zA-Z0-9]/g, "-")}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-4">
      {/* File tree summary */}
      <div className="border border-border rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            {files.length} file{files.length !== 1 ? "s" : ""} changed
          </span>
          <span className="text-xs text-muted-foreground">
            <span className="text-green-600 dark:text-green-400 font-medium">+{totalAdditions}</span>
            {" "}
            <span className="text-red-600 dark:text-red-400 font-medium">-{totalDeletions}</span>
          </span>
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
                  <Icon className={cn("h-3 w-3 shrink-0", statusColor[file.status] ?? "text-muted-foreground")} />
                  <span className="truncate min-w-0">
                    <span className="text-muted-foreground">{fileDir(file.path)}</span>
                    <span>{fileName(file.path)}</span>
                  </span>
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    {file.additions > 0 && <span className="text-green-600 dark:text-green-400">+{file.additions}</span>}
                    {file.deletions > 0 && <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>}
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
          <div key={file.path} id={`diff-file-${file.path.replace(/[^a-zA-Z0-9]/g, "-")}`}>
            <FileDiffSection file={file} defaultOpen={files.length <= 10} />
          </div>
        ))}
      </div>
    </div>
  );
};
