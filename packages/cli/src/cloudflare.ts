// Minimal Cloudflare REST client. Covers token verification, account lookup,
// Artifacts namespace + repo provisioning, and import polling.

const API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages?: unknown[];
  result: T;
  result_info?: unknown;
}

export class CloudflareClient {
  constructor(private token: string) {}

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json()) as CfEnvelope<T>;
    if (!res.ok || !json.success) {
      const detail = json.errors?.map((e) => `[${e.code}] ${e.message}`).join("; ");
      throw new Error(`Cloudflare ${method} ${path} → ${res.status}: ${detail || "unknown error"}`);
    }
    return json.result;
  }

  async verifyToken(): Promise<{ id: string; status: string }> {
    return this.req("GET", "/user/tokens/verify");
  }

  async listAccounts(): Promise<Array<{ id: string; name: string }>> {
    return this.req("GET", "/accounts");
  }

  // --- Artifacts ---

  async ensureNamespace(accountId: string, name: string): Promise<void> {
    try {
      await this.req("POST", `/accounts/${accountId}/artifacts/namespaces`, {
        name,
      });
    } catch (err) {
      // If it already exists, the API returns an error — that's fine.
      const msg = (err as Error).message;
      if (/already exists|already taken|duplicate/i.test(msg)) return;
      throw err;
    }
  }

  async importRepo(
    accountId: string,
    namespace: string,
    params: { name: string; url: string; branch?: string; depth?: number },
  ): Promise<{ name: string; remote: string; token: string }> {
    return this.req(
      "POST",
      `/accounts/${accountId}/artifacts/namespaces/${namespace}/repos/${params.name}/import`,
      {
        url: params.url,
        ...(params.branch ? { branch: params.branch } : {}),
        ...(params.depth ? { depth: params.depth } : {}),
      },
    );
  }

  async getRepo(
    accountId: string,
    namespace: string,
    name: string,
  ): Promise<{ name: string; remote: string; status?: string }> {
    return this.req(
      "GET",
      `/accounts/${accountId}/artifacts/namespaces/${namespace}/repos/${name}`,
    );
  }

  // --- Workers subdomain ---

  async getWorkersSubdomain(accountId: string): Promise<string> {
    const r = await this.req<{ subdomain: string }>(
      "GET",
      `/accounts/${accountId}/workers/subdomain`,
    );
    return r.subdomain;
  }
}
