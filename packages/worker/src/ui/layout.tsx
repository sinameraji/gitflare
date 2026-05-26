import type { FC, PropsWithChildren } from "hono/jsx";

export const Layout: FC<PropsWithChildren<{ title?: string }>> = ({
  title,
  children,
}) => (
  <html lang="en" data-theme="dark">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width" />
      <title>{title ? `${title} · GitFlare` : "GitFlare"}</title>
      <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
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
.hdr .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -0.01em; }
.hdr .brand .logo { width: 18px; height: 18px; border-radius: 4px; background: var(--accent); display: inline-block; }
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
`;
