// Cloudflare deploy primitives, called from inside the Worker (DeployDO):
//  - Workers Scripts multipart upload (with bindings)
//  - Pages Direct Upload (production + preview deploys)
//  - D1 query execution (for migrations)
//
// These mirror what `wrangler` does over the API. The exact wire shapes are
// per the Cloudflare API docs and SHOULD be re-checked against a live account
// before being relied on.

import type { WorkerBindings } from "./workflow";

const API = "https://api.cloudflare.com/client/v4";

// ---------------------------------------------------------------------------
// Workers Scripts upload
// ---------------------------------------------------------------------------

export interface ScriptUpload {
  scriptName: string;
  moduleFileName: string; // referenced by metadata.main_module
  code: string;
  compatibilityDate?: string;
  bindings?: WorkerBindings;
}

/** Translate our binding model into the Workers metadata.bindings array. */
export function bindingsArray(b?: WorkerBindings): unknown[] {
  if (!b) return [];
  const out: unknown[] = [];
  for (const [name, text] of Object.entries(b.vars))
    out.push({ type: "plain_text", name, text });
  for (const kv of b.kv)
    out.push({ type: "kv_namespace", name: kv.binding, namespace_id: kv.id });
  for (const r2 of b.r2)
    out.push({ type: "r2_bucket", name: r2.binding, bucket_name: r2.bucket_name });
  for (const d1 of b.d1)
    out.push({ type: "d1", name: d1.binding, id: d1.database_id });
  for (const dobj of b.durable_objects)
    out.push({
      type: "durable_object_namespace",
      name: dobj.name,
      class_name: dobj.class_name,
      ...(dobj.script_name ? { script_name: dobj.script_name } : {}),
    });
  for (const svc of b.services)
    out.push({
      type: "service",
      name: svc.binding,
      service: svc.service,
      ...(svc.environment ? { environment: svc.environment } : {}),
    });
  return out;
}

/** Build the multipart body for `PUT /workers/scripts/{name}`. Pure + testable. */
export function buildScriptUploadForm(u: ScriptUpload): FormData {
  const form = new FormData();
  const metadata = {
    main_module: u.moduleFileName,
    compatibility_date: u.compatibilityDate ?? "2026-05-01",
    bindings: bindingsArray(u.bindings),
  };
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(
    u.moduleFileName,
    new Blob([u.code], { type: "application/javascript+module" }),
    u.moduleFileName,
  );
  return form;
}

export interface DeployApiResult {
  ok: boolean;
  status: number;
  detail?: string;
  url?: string;
}

export interface UploadWorkerParams {
  accountId: string;
  apiToken: string;
  upload: ScriptUpload;
  fetchImpl?: typeof fetch;
}

export async function uploadWorkerScript(p: UploadWorkerParams): Promise<DeployApiResult> {
  const doFetch = p.fetchImpl ?? fetch;
  const url = `${API}/accounts/${p.accountId}/workers/scripts/${p.upload.scriptName}`;
  const res = await doFetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${p.apiToken}` },
    body: buildScriptUploadForm(p.upload),
  });
  return envelope(res);
}

// ---------------------------------------------------------------------------
// Pages Direct Upload
// ---------------------------------------------------------------------------

export interface PagesFile {
  path: string; // path within the site, no leading slash
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Cloudflare Pages addresses assets by the hex digest of (blake3 normally, but
 * the API accepts the file's content hash). We use a sha-256 hex digest of the
 * bytes — the Direct Upload API keys files by this digest; mismatches simply
 * mean a file re-uploads, never a wrong file. Returns a manifest mapping the
 * site path to its digest.
 */
export async function hashPagesFiles(
  files: PagesFile[],
): Promise<{ manifest: Record<string, string>; byHash: Map<string, PagesFile> }> {
  const manifest: Record<string, string> = {};
  const byHash = new Map<string, PagesFile>();
  for (const f of files) {
    const digest = await sha256Hex(f.bytes);
    manifest["/" + f.path.replace(/^\/+/, "")] = digest;
    byHash.set(digest, f);
  }
  return { manifest, byHash };
}

export interface PagesDeployParams {
  accountId: string;
  apiToken: string;
  project: string;
  files: PagesFile[];
  /** Omit (or set production branch) for a production deploy; any other branch → preview. */
  branch?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Pages Direct Upload flow:
 *   1. mint an upload JWT (`/pages/projects/:p/upload-token`)
 *   2. ask which hashes are missing (`/pages/assets/check-missing`)
 *   3. upload missing files (`/pages/assets/upload`)
 *   4. create the deployment (multipart with the manifest)
 */
export async function deployPages(p: PagesDeployParams): Promise<DeployApiResult> {
  const doFetch = p.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${p.apiToken}` };
  const base = `${API}/accounts/${p.accountId}/pages/projects/${p.project}`;

  const { manifest, byHash } = await hashPagesFiles(p.files);

  // 1. upload token
  const tokRes = await doFetch(`${base}/upload-token`, { headers: auth });
  const tok = await json<{ result?: { jwt?: string } }>(tokRes);
  const jwt = tok?.result?.jwt;
  if (!jwt) return envelope(tokRes, "could not mint Pages upload token");
  const jwtAuth = { Authorization: `Bearer ${jwt}` };

  // 2. which hashes are missing
  const allHashes = [...byHash.keys()];
  const missRes = await doFetch(`${API}/pages/assets/check-missing`, {
    method: "POST",
    headers: { ...jwtAuth, "Content-Type": "application/json" },
    body: JSON.stringify({ hashes: allHashes }),
  });
  const miss = await json<{ result?: string[] }>(missRes);
  const missing = miss?.result ?? allHashes;

  // 3. upload missing files (base64 payload, batched)
  if (missing.length) {
    const payload = missing.map((h) => {
      const f = byHash.get(h)!;
      return {
        key: h,
        value: base64(f.bytes),
        metadata: { contentType: f.contentType },
        base64: true,
      };
    });
    const upRes = await doFetch(`${API}/pages/assets/upload`, {
      method: "POST",
      headers: { ...jwtAuth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!upRes.ok) return envelope(upRes, "asset upload failed");
  }

  // 4. create the deployment
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  if (p.branch) form.append("branch", p.branch);
  const depRes = await doFetch(`${base}/deployments`, {
    method: "POST",
    headers: auth,
    body: form,
  });
  const env = await envelope(depRes);
  if (env.ok) {
    const dep = await json<{ result?: { url?: string } }>(depRes.clone?.() ?? depRes).catch(() => null);
    if (dep?.result?.url) env.url = dep.result.url;
  }
  return env;
}

// ---------------------------------------------------------------------------
// D1 query (migrations)
// ---------------------------------------------------------------------------

export interface D1QueryParams {
  accountId: string;
  apiToken: string;
  databaseId: string;
  sql: string;
  fetchImpl?: typeof fetch;
}

export async function d1Query(p: D1QueryParams): Promise<DeployApiResult> {
  const doFetch = p.fetchImpl ?? fetch;
  const res = await doFetch(
    `${API}/accounts/${p.accountId}/d1/database/${p.databaseId}/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${p.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql: p.sql }),
    },
  );
  return envelope(res);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function envelope(res: Response, fallbackDetail?: string): Promise<DeployApiResult> {
  try {
    const j = (await res.clone().json()) as {
      success?: boolean;
      errors?: Array<{ code: number; message: string }>;
    };
    const detail = j.errors?.length
      ? j.errors.map((e) => `[${e.code}] ${e.message}`).join("; ")
      : fallbackDetail;
    return { ok: res.ok && j.success !== false, status: res.status, ...(detail ? { detail } : {}) };
  } catch {
    return { ok: res.ok, status: res.status, ...(fallbackDetail ? { detail: fallbackDetail } : {}) };
  }
}

async function json<T>(res: Response): Promise<T | null> {
  try {
    return (await res.clone().json()) as T;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  let hex = "";
  for (const b of new Uint8Array(buf)) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
