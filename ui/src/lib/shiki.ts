import { useState, useEffect } from "react";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";

// ── Supported languages ─────────────────────────────────────

export const HIGHLIGHT_LANGS = [
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

// ── Extension → language map ────────────────────────────────

export const EXT_TO_LANG: Record<string, string> = {
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

// ── Alias → canonical language mapping ──────────────────────

const LANG_ALIASES: Record<string, string> = {
  ...EXT_TO_LANG,
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  rust: "rust",
  ruby: "ruby",
  csharp: "csharp",
  "c++": "cpp",
  "c#": "csharp",
  shell: "bash",
  zsh: "bash",
  text: "text",
  txt: "text",
  plaintext: "text",
};

const SUPPORTED_SET = new Set<string>(HIGHLIGHT_LANGS);

export const normalizeLanguage = (lang: string): BundledLanguage | null => {
  const lower = lang.toLowerCase().trim();
  const mapped = LANG_ALIASES[lower] ?? lower;
  if (mapped === "text" || mapped === "txt" || mapped === "plaintext") return null;
  if (SUPPORTED_SET.has(mapped)) return mapped as BundledLanguage;
  return null;
};

// ── Highlighter singleton ───────────────────────────────────

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

export const getShikiHighlighter = (): Promise<Highlighter> => {
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

// Eagerly kick off initialization so the highlighter is ready
// by the time any component mounts.
getShikiHighlighter();

// ── Hooks ───────────────────────────────────────────────────

export const useHighlighter = (): Highlighter | null => {
  const [h, setH] = useState<Highlighter | null>(highlighterInstance);
  useEffect(() => {
    if (h) return;
    getShikiHighlighter().then(setH);
  }, [h]);
  return h;
};

export const useIsDark = (): boolean => {
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

// ── File extension detection ────────────────────────────────

export const detectLangFromPath = (filePath: string): BundledLanguage | null => {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  const ext = name.split(".").pop() ?? "";
  return (EXT_TO_LANG[ext] as BundledLanguage) ?? null;
};
