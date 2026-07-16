import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import type { CiRunRecord } from "../durable-objects/ci";

interface Props {
  githubFullName: string;
  artifactsRepoName: string;
  runs: CiRunRecord[];
  ciEnabled: boolean;
  // Cancel from the dashboard is only offered when Cloudflare Access gates the
  // page (otherwise anyone could kill runs on a public mirror — use the CLI).
  canCancel: boolean;
  version: string;
}

const PILL: Record<CiRunRecord["status"], string> = {
  success: "ok",
  failed: "err",
  running: "warn",
  skipped: "warn",
};

const JOB_GLYPH: Record<string, string> = {
  success: "✓",
  failed: "✗",
  skipped: "○",
  running: "●",
  pending: "·",
};

function rel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function dur(r: CiRunRecord): string {
  if (!r.finishedAt) return "…";
  const s = Math.round((r.finishedAt - r.startedAt) / 1000);
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

// Client-side: stream live CI logs over a WebSocket, offer cancel, and reload
// when the run finishes so the history table refreshes.
function streamScript(name: string): string {
  return `
(function () {
  var box = document.getElementById('live-logs');
  if (!box || !('WebSocket' in window)) return;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/r/${name}/ci/stream');
  function show() { document.getElementById('live-wrap').style.display = 'block'; }
  function append(line) {
    box.textContent += line + '\\n';
    box.scrollTop = box.scrollHeight;
    show();
  }
  ws.onmessage = function (ev) {
    try {
      var m = JSON.parse(ev.data);
      if (m.type === 'snapshot' || m.type === 'start') {
        if (m.record && m.record.logs) { box.textContent = m.record.logs.join('\\n') + '\\n'; show(); }
      } else if (m.type === 'log') {
        append(m.line);
      } else if (m.type === 'done') {
        append('— run finished: ' + (m.record ? m.record.status : '') + ' —');
        setTimeout(function () { location.reload(); }, 1500);
      }
    } catch (e) {}
  };
  var btn = document.getElementById('cancel-run');
  if (btn) btn.addEventListener('click', function () {
    btn.disabled = true;
    fetch('/r/${name}/ci/cancel', { method: 'POST' }).catch(function () {});
  });
})();
`;
}

export const Runs: FC<Props> = (p) => (
  <Layout title={`CI runs · ${p.githubFullName}`}>
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

      <h1>CI runs</h1>
      <p class="muted">
        {p.githubFullName} · <a href={`/r/${p.artifactsRepoName}/tree/`}>browse code</a> ·{" "}
        <a href={`/r/${p.artifactsRepoName}/deployments`}>deployments</a>
      </p>

      {!p.ciEnabled ? (
        <div class="empty" style="margin-top: 24px; text-align: left;">
          <div style="margin-bottom: 12px;">CI isn't enabled for this repo.</div>
          <pre style="margin: 0 0 12px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto;"><code class="mono">gitflare ci enable</code></pre>
          <div class="muted">
            Then commit a <code>.gitflare/ci.yml</code>. On push, GitFlare runs your jobs in a
            Cloudflare Sandbox on your own account — even when GitHub Actions is down.
          </div>
        </div>
      ) : (
        <>
          <div id="live-wrap" style="display: none; margin-top: 24px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <h2>Live</h2>
              {p.canCancel ? (
                <button
                  id="cancel-run"
                  class="mono"
                  style="background: none; border: 1px solid var(--border); border-radius: 6px; color: var(--fg); padding: 4px 10px; cursor: pointer; font-size: 12px;"
                >
                  cancel run
                </button>
              ) : null}
            </div>
            <pre
              id="live-logs"
              class="mono"
              style="margin: 0; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.5;"
            ></pre>
          </div>

          {p.runs.length === 0 ? (
            <div class="empty" style="margin-top: 24px;">
              No runs yet. Push to a branch matched by <code>.gitflare/ci.yml</code>, or run{" "}
              <code>gitflare ci run</code>.
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
                    <th>Jobs</th>
                    <th>Status</th>
                    <th style="text-align: right;">Took</th>
                    <th style="text-align: right;">When</th>
                  </tr>
                </thead>
                <tbody>
                  {p.runs.map((r) => (
                    <tr>
                      <td class="mono muted">{r.id}</td>
                      <td class="mono">{r.branch}</td>
                      <td class="mono">{r.sha.slice(0, 8)}</td>
                      <td class="mono muted">{r.mode}</td>
                      <td class="mono">
                        {r.jobs.length === 0
                          ? "—"
                          : r.jobs.map((j) => (
                              <span title={j.message ?? j.status} style="margin-right: 8px;">
                                {j.name} {JOB_GLYPH[j.status] ?? "?"}
                              </span>
                            ))}
                      </td>
                      <td>
                        <span class={`pill ${PILL[r.status]}`}>{r.status}</span>
                        {r.message ? (
                          <span style="color: var(--muted); margin-left: 8px;">{r.message}</span>
                        ) : null}
                      </td>
                      <td class="mono" style="text-align: right; color: var(--muted);">{dur(r)}</td>
                      <td class="mono" style="text-align: right; color: var(--muted);">{rel(r.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {p.runs[0] && p.runs[0].logs.length > 0 ? (
            <>
              <h2>Latest log (#{p.runs[0].id})</h2>
              <pre
                class="mono"
                style="margin: 0; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.5;"
              >
                {p.runs[0].logs.join("\n")}
              </pre>
            </>
          ) : null}

          <script dangerouslySetInnerHTML={{ __html: streamScript(p.artifactsRepoName) }} />
        </>
      )}
    </div>
  </Layout>
);
