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

// Client-side: stream live deploy logs over a WebSocket and reload the page
// when a run finishes so the history table refreshes.
function streamScript(name: string): string {
  return `
(function () {
  var box = document.getElementById('live-logs');
  if (!box || !('WebSocket' in window)) return;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/r/${name}/deployments/stream');
  function append(line) {
    box.textContent += line + '\\n';
    box.scrollTop = box.scrollHeight;
    document.getElementById('live-wrap').style.display = 'block';
  }
  ws.onmessage = function (ev) {
    try {
      var m = JSON.parse(ev.data);
      if (m.type === 'snapshot' || m.type === 'start') {
        if (m.record && m.record.logs) { box.textContent = m.record.logs.join('\\n') + '\\n'; document.getElementById('live-wrap').style.display = 'block'; }
      } else if (m.type === 'log') {
        append(m.line);
      } else if (m.type === 'done') {
        append('— run finished: ' + (m.record ? m.record.status : '') + ' —');
        setTimeout(function () { location.reload(); }, 1500);
      }
    } catch (e) {}
  };
})();
`;
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
            Then commit a <code>.gitflare/deploy.yml</code>. On push, GitFlare deploys to your own
            account — even when GitHub Actions is down.
          </div>
        </div>
      ) : (
        <>
          <div id="live-wrap" style="display: none; margin-top: 24px;">
            <h2>Live</h2>
            <pre
              id="live-logs"
              class="mono"
              style="margin: 0; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.5;"
            ></pre>
          </div>

          {p.deploys.length === 0 ? (
            <div class="empty" style="margin-top: 24px;">
              No deploys yet. Push to a branch matched by <code>.gitflare/deploy.yml</code>, or run{" "}
              <code>gitflare deploy run</code>.
            </div>
          ) : (
            <div class="card" style="padding: 0; overflow: hidden; margin-top: 24px;">
              <table class="refs" style="margin: 0;">
                <thead>
                  <tr>
                    <th style="width: 44px;">#</th>
                    <th>Branch</th>
                    <th>Commit</th>
                    <th>Mode</th>
                    <th>Steps</th>
                    <th>Status</th>
                    <th style="text-align: right;">When</th>
                  </tr>
                </thead>
                <tbody>
                  {p.deploys.map((d) => (
                    <tr>
                      <td class="mono muted">{d.id}</td>
                      <td class="mono">{d.branch}</td>
                      <td class="mono">{d.sha.slice(0, 8)}</td>
                      <td class="mono muted">{d.mode}</td>
                      <td class="mono">
                        {d.steps.length === 0
                          ? "—"
                          : d.steps.map((s) => (
                              <span>
                                {s.url ? (
                                  <a href={s.url}>{s.project}</a>
                                ) : (
                                  s.project
                                )}
                                {s.ok ? " ✓ " : " ✗ "}
                              </span>
                            ))}
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

          {p.deploys[0] && p.deploys[0].logs.length > 0 ? (
            <>
              <h2>Latest log (#{p.deploys[0].id})</h2>
              <pre
                class="mono"
                style="margin: 0; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.5;"
              >
                {p.deploys[0].logs.join("\n")}
              </pre>
            </>
          ) : null}

          <script dangerouslySetInnerHTML={{ __html: streamScript(p.artifactsRepoName) }} />
        </>
      )}
    </div>
  </Layout>
);
