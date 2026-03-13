import { isValidElement, useEffect, useId, useState, useCallback, type CSSProperties, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { parseProjectMentionHref } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { useTheme } from "../context/ThemeContext";
import { getShikiHighlighter, normalizeLanguage } from "../lib/shiki";
import type { Highlighter } from "shiki";

interface MarkdownBodyProps {
  children: string;
  className?: string;
}

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidLoaderPromise) {
    mermaidLoaderPromise = import("mermaid").then((module) => module.default);
  }
  return mermaidLoaderPromise;
}

function flattenText(value: ReactNode): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item)).join("");
  return "";
}

function extractMermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as { className?: unknown; children?: ReactNode };
  if (typeof childProps.className !== "string") return null;
  if (!/\blanguage-mermaid\b/i.test(childProps.className)) return null;
  return flattenText(childProps.children).replace(/\n$/, "");
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function mentionChipStyle(color: string | null): CSSProperties | undefined {
  if (!color) return undefined;
  const rgb = hexToRgb(color);
  if (!rgb) return undefined;
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return {
    borderColor: color,
    backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`,
    color: luminance > 0.55 ? "#111827" : "#f8fafc",
  };
}

function MermaidDiagramBlock({ source, darkMode }: { source: string; darkMode: boolean }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: darkMode ? "dark" : "default",
          fontFamily: "inherit",
          suppressErrorRendering: true,
        });
        const rendered = await mermaid.render(`paperclip-mermaid-${renderId}`, source);
        if (!active) return;
        setSvg(rendered.svg);
      })
      .catch((err) => {
        if (!active) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : "Failed to render Mermaid diagram.";
        setError(message);
      });

    return () => {
      active = false;
    };
  }, [darkMode, renderId, source]);

  return (
    <div className="paperclip-mermaid">
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <>
          <p className={cn("paperclip-mermaid-status", error && "paperclip-mermaid-status-error")}>
            {error ? `Unable to render Mermaid diagram: ${error}` : "Rendering Mermaid diagram..."}
          </p>
          <pre className="paperclip-mermaid-source">
            <code className="language-mermaid">{source}</code>
          </pre>
        </>
      )}
    </div>
  );
}

// ── Code block extraction ───────────────────────────────────

interface CodeBlockInfo {
  language: string | null;
  code: string;
}

function extractCodeBlock(children: ReactNode): CodeBlockInfo | null {
  if (!isValidElement(children)) return null;
  const childProps = children.props as { className?: unknown; children?: ReactNode };
  const className2 = typeof childProps.className === "string" ? childProps.className : "";
  const langMatch = /\blanguage-(\S+)/.exec(className2);
  const language = langMatch ? langMatch[1] : null;
  const code = flattenText(childProps.children).replace(/\n$/, "");
  return { language, code };
}

// ── Shiki code block with copy + language badge ─────────────

function ShikiCodeBlock({ language, code, darkMode }: { language: string | null; code: string; darkMode: boolean }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const resolvedLang = language ? normalizeLanguage(language) : null;

  useEffect(() => {
    let active = true;
    getShikiHighlighter().then((highlighter: Highlighter) => {
      if (!active) return;
      if (!resolvedLang) {
        setHtml(null);
        return;
      }
      const theme = darkMode ? "github-dark" : "github-light";
      try {
        const result = highlighter.codeToHtml(code, { lang: resolvedLang, theme });
        setHtml(result);
      } catch {
        setHtml(null);
      }
    });
    return () => { active = false; };
  }, [code, resolvedLang, darkMode]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <div className="group/codeblock relative not-prose my-2 rounded-md border border-border/50 bg-[var(--shiki-bg,_hsl(var(--muted)))] overflow-hidden">
      {/* Language badge + Copy button header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30 bg-muted/30">
        {language ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground select-none">
            {language}
          </span>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-green-500" />
              <span className="text-green-500">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* Code content */}
      {html ? (
        <div
          className="overflow-x-auto text-xs leading-5 [&_pre]:!m-0 [&_pre]:!bg-transparent [&_pre]:p-3 [&_code]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto text-xs leading-5 p-3 m-0">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

export function MarkdownBody({ children, className }: MarkdownBodyProps) {
  const { theme } = useTheme();
  return (
    <div
      className={cn(
        "paperclip-markdown prose prose-sm max-w-none break-words overflow-hidden prose-pre:whitespace-pre-wrap prose-pre:break-words prose-code:break-all",
        theme === "dark" && "prose-invert",
        className,
      )}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ node: _node, children: preChildren, ...preProps }) => {
            const mermaidSource = extractMermaidSource(preChildren);
            if (mermaidSource) {
              return <MermaidDiagramBlock source={mermaidSource} darkMode={theme === "dark"} />;
            }
            const codeBlock = extractCodeBlock(preChildren);
            if (codeBlock) {
              return <ShikiCodeBlock language={codeBlock.language} code={codeBlock.code} darkMode={theme === "dark"} />;
            }
            return <pre {...preProps}>{preChildren}</pre>;
          },
          a: ({ href, children: linkChildren }) => {
            const parsed = href ? parseProjectMentionHref(href) : null;
            if (parsed) {
              const label = linkChildren;
              return (
                <a
                  href={`/projects/${parsed.projectId}`}
                  className="paperclip-project-mention-chip"
                  style={mentionChipStyle(parsed.color)}
                >
                  {label}
                </a>
              );
            }
            return (
              <a href={href} rel="noreferrer">
                {linkChildren}
              </a>
            );
          },
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
