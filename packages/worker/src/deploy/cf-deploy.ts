// Uploads a pre-built single-file Worker to the user's own Cloudflare account
// via the Workers Scripts API — the same multipart PUT `wrangler deploy` makes
// under the hood. v0.2 MVP: no build step (Workers can't spawn processes), so
// the repo must commit a built ES-module entry; arbitrary build lands in v0.3
// (generic CI on Sandboxes).
//
// NOTE: the exact multipart shape is verified against wrangler's behaviour but
// should be re-checked live before relying on it in production.

export interface ScriptUpload {
  scriptName: string;
  /** The module file name referenced by metadata.main_module. */
  moduleFileName: string;
  /** ES-module source. */
  code: string;
  compatibilityDate?: string;
}

/**
 * Build the multipart body for `PUT /accounts/{id}/workers/scripts/{name}`.
 * Pure + synchronous so it can be unit-tested without a network.
 */
export function buildScriptUploadForm(u: ScriptUpload): FormData {
  const form = new FormData();
  const metadata = {
    main_module: u.moduleFileName,
    compatibility_date: u.compatibilityDate ?? "2026-05-01",
  };
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  form.append(
    u.moduleFileName,
    new Blob([u.code], { type: "application/javascript+module" }),
    u.moduleFileName,
  );
  return form;
}

export interface DeployApiParams {
  accountId: string;
  apiToken: string;
  upload: ScriptUpload;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface DeployApiResult {
  ok: boolean;
  status: number;
  detail?: string;
}

export async function uploadWorkerScript(
  p: DeployApiParams,
): Promise<DeployApiResult> {
  const doFetch = p.fetchImpl ?? fetch;
  const url = `https://api.cloudflare.com/client/v4/accounts/${p.accountId}/workers/scripts/${p.upload.scriptName}`;
  const res = await doFetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${p.apiToken}` },
    body: buildScriptUploadForm(p.upload),
  });
  let detail: string | undefined;
  try {
    const json = (await res.json()) as {
      success?: boolean;
      errors?: Array<{ code: number; message: string }>;
    };
    if (json.errors?.length) {
      detail = json.errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    }
    return { ok: res.ok && json.success !== false, status: res.status, ...(detail ? { detail } : {}) };
  } catch {
    return { ok: res.ok, status: res.status };
  }
}
