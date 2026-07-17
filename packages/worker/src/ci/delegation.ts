// Interprets the DeployDO response a CI deploy job receives when it delegates
// to the deploy pipeline. Extracted as a pure function so the four response
// shapes are exhaustively unit-testable — the important one being that a
// "skipped" deploy (e.g. CD not enabled) must NOT read as a green job.

import type { DeployRecord } from "../durable-objects/deploy";

export interface DeployJobOutcome {
  ok: boolean;
  steps: Array<{ label: string; ok: boolean; detail?: string }>;
  message?: string;
}

/**
 * @param httpOk    resp.ok
 * @param httpStatus resp.status
 * @param body      parsed JSON: a DeployRecord on 200, else `{ error? }`
 */
export function interpretDeployResponse(
  httpOk: boolean,
  httpStatus: number,
  body: unknown,
): DeployJobOutcome {
  if (!httpOk) {
    const err = (body as { error?: string } | null)?.error;
    return { ok: false, steps: [], message: `deploy failed: ${err ?? httpStatus}` };
  }
  const record = body as DeployRecord;
  const steps = (record.steps ?? []).map((s) => ({
    label: `${s.kind}: ${s.project}`,
    ok: s.ok,
    ...(s.detail ? { detail: s.detail } : {}),
  }));
  if (record.status === "success") return { ok: true, steps };
  // "skipped" (e.g. CD not enabled) must NOT read as green — the whole point of
  // a needs-gated deploy job is that it actually shipped.
  return {
    ok: false,
    steps,
    message:
      record.status === "skipped"
        ? `deploy skipped: ${record.message ?? "CD not enabled — run `gitflare deploy enable`"}`
        : `deploy #${record.id} ${record.status}${record.message ? `: ${record.message}` : ""}`,
  };
}
