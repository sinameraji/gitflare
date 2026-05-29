import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import type { DeployRecord } from "../durable-objects/deploy";

interface Props {
  githubFullName: string;
  artifactsRepoName: string;
  deploys: DeployRecord[];
  cdEnabled: boolean;
  version: string;
}

const PILL: Record<DeployRecord["status"], string> = {
  success: "ok",
  failed: "err",
  running: "warn",
  skipped: "warn",
};

function rel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const Deployments: FC<Props> = (p) => (
  <Layout title={`Deployments · ${p.githubFullName}`}>
    <div class="wrap">
      <div class="hdr">
        <div class="brand">
          <a href="/" style="display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none;">
            <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
            GitFlare
          </a>
        </div>
        <div class="ver mono">v{p.version}</div>
      </div>

      <h1>Deployments</h1>
      <p class="muted">
        {p.githubFullName} · <a href={`/r/${p.artifactsRepoName}/tree/`}>browse code</a>
      </p>

      {!p.cdEnabled ? (
        <div class="empty" style="margin-top: 24px; text-align: left;">
          <div style="margin-bottom: 12px;">Continuous deploy isn't enabled for this repo.</div>
          <pre style="margin: 0 0 12px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto;"><code class="mono">gitflare deploy enable</code></pre>
          <div class="muted">
            Then commit a <code>.gitflare/deploy.yml</code>. On push, GitFlare deploys your built
            Worker to your own account — even when GitHub Actions is down.
          </div>
        </div>
      ) : p.deploys.length === 0 ? (
        <div class="empty" style="margin-top: 24px;">
          No deploys yet. Push to a branch matched by <code>.gitflare/deploy.yml</code> to trigger one.
        </div>
      ) : (
        <div class="card" style="padding: 0; overflow: hidden; margin-top: 24px;">
          <table class="refs" style="margin: 0;">
            <thead>
              <tr>
                <th style="width: 50px;">#</th>
                <th>Ref</th>
                <th>Commit</th>
                <th>Steps</th>
                <th>Status</th>
                <th style="text-align: right;">When</th>
              </tr>
            </thead>
            <tbody>
              {p.deploys.map((d) => (
                <tr>
                  <td class="mono muted">{d.id}</td>
                  <td class="mono">{d.ref.replace(/^refs\/heads\//, "")}</td>
                  <td class="mono">{d.sha.slice(0, 8)}</td>
                  <td class="mono">
                    {d.steps.length === 0
                      ? "—"
                      : d.steps.map((s) => `${s.project}${s.ok ? "✓" : "✗"}`).join(" ")}
                  </td>
                  <td>
                    <span class={`pill ${PILL[d.status]}`}>{d.status}</span>
                    {d.message ? (
                      <span style="color: var(--muted); margin-left: 8px;">{d.message}</span>
                    ) : null}
                  </td>
                  <td class="mono" style="text-align: right; color: var(--muted);">{rel(d.startedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  </Layout>
);
