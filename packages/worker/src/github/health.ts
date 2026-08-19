// "Is GitHub up?" — the row PLAN §4 Stage 1 asked for. One cheap probe per
// isolate every 30 s (module-scoped cache), never blocks the page for more
// than ~3 s. Unauthenticated: api.github.com's root answers 200 with a link
// map; a 5xx or timeout reads as "unreachable".

export interface GithubHealth {
  ok: boolean;
  status: number | null;
  latencyMs: number | null;
  checkedAt: number;
  detail?: string | undefined;
}

let cached: GithubHealth | null = null;
const TTL_MS = 30_000;
const TIMEOUT_MS = 3_000;

export async function probeGithub(fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<GithubHealth> {
  if (cached && now - cached.checkedAt < TTL_MS) return cached;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://api.github.com/", {
      method: "GET",
      headers: { "User-Agent": "gitflare-worker", Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    cached = { ok: res.status < 500, status: res.status, latencyMs: Date.now() - started, checkedAt: now };
  } catch (err) {
    cached = {
      ok: false,
      status: null,
      latencyMs: null,
      checkedAt: now,
      detail: (err as Error).name === "AbortError" ? `no answer in ${TIMEOUT_MS / 1000}s` : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
  return cached;
}

/** Test hook. */
export function resetGithubHealthCache(): void {
  cached = null;
}
