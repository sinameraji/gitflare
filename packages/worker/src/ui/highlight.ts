// Server-side syntax highlighting for the blob viewer. We use highlight.js
// *core* and register only a curated language set — the full library pulls
// ~190 grammars and would balloon the worker bundle (which ships inside the
// CLI). Core (~25KB) + ~20 small grammars keeps the cost modest. highlight.js
// runs without a DOM, so it works inside a Worker.

import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml"; // HTML/XML/SVG
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import bash from "highlight.js/lib/languages/bash";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import rust from "highlight.js/lib/languages/rust";
import yaml from "highlight.js/lib/languages/yaml";
import toml from "highlight.js/lib/languages/ini"; // ini grammar covers toml
import sql from "highlight.js/lib/languages/sql";
import java from "highlight.js/lib/languages/java";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import shell from "highlight.js/lib/languages/shell";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import diff from "highlight.js/lib/languages/diff";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", toml);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("java", java);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("diff", diff);

// Skip highlighting very large files — tokenizing megabytes blows the Worker's
// CPU budget. The viewer falls back to a plain <pre> above this size.
const MAX_HIGHLIGHT_BYTES = 512 * 1024;

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  css: "css",
  scss: "css",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  dockerfile: "dockerfile",
  diff: "diff",
  patch: "diff",
};

const FILENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  "package.json": "json",
  "tsconfig.json": "json",
};

function langFor(path: string): string | undefined {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (FILENAME_TO_LANG[base]) return FILENAME_TO_LANG[base];
  const dot = base.lastIndexOf(".");
  if (dot === -1) return undefined;
  return EXT_TO_LANG[base.slice(dot + 1)];
}

export interface Highlighted {
  html: string; // highlight.js markup; render with dangerouslySetInnerHTML
  lang: string;
}

/**
 * Highlight `text` based on the file path's extension. Returns null when the
 * language is unknown, the file is too large, or highlighting throws — callers
 * fall back to a plain <pre>.
 */
export function highlightCode(text: string, path: string): Highlighted | null {
  if (text.length > MAX_HIGHLIGHT_BYTES) return null;
  const lang = langFor(path);
  if (!lang) return null;
  try {
    const { value } = hljs.highlight(text, { language: lang, ignoreIllegals: true });
    return { html: value, lang };
  } catch {
    return null;
  }
}
