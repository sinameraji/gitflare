import type { FC, PropsWithChildren } from "hono/jsx";
import { LOGO_PNG_DATA_URL } from "./logo-data";

export const Layout: FC<PropsWithChildren<{ title?: string }>> = ({
  title,
  children,
}) => (
  <html lang="en" data-theme="dark">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width" />
      <title>{title ? `${title} · GitFlare` : "GitFlare"}</title>
      <link rel="icon" href={LOGO_PNG_DATA_URL} type="image/png" />
      <style dangerouslySetInnerHTML={{ __html: css }} />
    </head>
    <body>{children}</body>
  </html>
);

const css = `
:root {
  --bg: #0b0b0c;
  --bg-elev: #131316;
  --fg: #e8e8ea;
  --muted: #8b8b91;
  --accent: #f38020;
  --border: #1f1f22;
  --ok: #4ade80;
  --warn: #facc15;
  --err: #f87171;
}
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--fg); margin: 0; }
body {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.wrap { max-width: 960px; margin: 0 auto; padding: 32px 24px 96px; }
.hdr { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; border-bottom: 1px solid var(--border); }
.hdr .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -0.01em; font-size: 15px; }
.hdr .brand .logo { width: 28px; height: 28px; display: inline-block; }
.hdr .ver { color: var(--muted); font-size: 12px; }

h1 { font-weight: 600; letter-spacing: -0.02em; font-size: 28px; margin: 32px 0 4px; }
h2 { font-weight: 600; letter-spacing: -0.01em; font-size: 16px; margin: 32px 0 12px; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.08em; }
p.muted { color: var(--muted); margin: 0; }

.card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }

.kv { display: grid; grid-template-columns: 160px 1fr; gap: 6px 16px; font-size: 13px; }
.kv .k { color: var(--muted); }
.kv .v { font-family: "JetBrains Mono", ui-monospace, monospace; word-break: break-all; }

.refs { width: 100%; border-collapse: collapse; font-size: 13px; }
.refs th, .refs td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.refs th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.refs td.mono { font-family: "JetBrains Mono", ui-monospace, monospace; }

.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-family: "JetBrains Mono", ui-monospace, monospace; }
.pill.ok { background: rgba(74,222,128,0.12); color: var(--ok); }
.pill.warn { background: rgba(250,204,21,0.12); color: var(--warn); }
.pill.err { background: rgba(248,113,113,0.12); color: var(--err); }

.empty { padding: 32px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; }

footer { color: var(--muted); font-size: 12px; padding: 32px 0; border-top: 1px solid var(--border); margin-top: 48px; }

.readme { line-height: 1.65; }
.readme h1, .readme h2, .readme h3 { margin-top: 24px; margin-bottom: 8px; font-weight: 600; letter-spacing: -0.01em; }
.readme h1 { font-size: 22px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.readme h2 { font-size: 18px; padding-bottom: 6px; border-bottom: 1px solid var(--border); color: var(--fg); text-transform: none; letter-spacing: -0.01em; }
.readme h3 { font-size: 15px; }
.readme p { margin: 12px 0; }
.readme a { color: var(--accent); }
.readme code { background: var(--bg); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
.readme pre { background: var(--bg); padding: 12px; border-radius: 6px; border: 1px solid var(--border); overflow-x: auto; }
.readme pre code { background: none; padding: 0; font-size: 12px; }
.readme ul, .readme ol { padding-left: 24px; margin: 12px 0; }
.readme li { margin: 4px 0; }
.readme blockquote { border-left: 3px solid var(--border); padding-left: 12px; color: var(--muted); margin: 12px 0; }
.readme table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
.readme th, .readme td { padding: 6px 12px; border: 1px solid var(--border); text-align: left; }
.readme th { background: var(--bg); color: var(--muted); font-weight: 500; }
.readme img { max-width: 100%; }
.readme hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }

/* highlight.js — compact dark theme tuned to the GitFlare palette. */
.hljs { color: var(--fg); background: transparent; }
.hljs-comment, .hljs-quote { color: #6b6b73; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-meta { color: #c792ea; }
.hljs-string, .hljs-regexp, .hljs-symbol, .hljs-char { color: #8bd49c; }
.hljs-number, .hljs-literal { color: #f78c6c; }
.hljs-title, .hljs-title.function_, .hljs-section { color: #82aaff; }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable { color: #ffcb6b; }
.hljs-type, .hljs-class .hljs-title, .hljs-title.class_ { color: #ffcb6b; }
.hljs-tag { color: #8b8b91; }
.hljs-name { color: #f07178; }
.hljs-params { color: var(--fg); }
.hljs-deletion { color: var(--err); }
.hljs-addition { color: var(--ok); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
.hljs-link { color: var(--accent); }
`;
