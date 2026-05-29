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
  // Namespaces are auto-provisioned on first repo creation; no ensure step.

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

  // --- Cloudflare Access (Zero Trust) ---
  // NOTE: exact request/response shapes vary by API version — verify live
  // before relying on these. `aud` is the tag the Worker validates.

  /**
   * Returns the account's Zero Trust org auth domain (e.g.
   * "myteam.cloudflareaccess.com"). Throws if the account has no org yet —
   * the user must enable Zero Trust once in the dashboard.
   */
  async getZeroTrustOrg(
    accountId: string,
  ): Promise<{ authDomain: string; name: string }> {
    const r = await this.req<{ auth_domain: string; name: string }>(
      "GET",
      `/accounts/${accountId}/access/organizations`,
    );
    if (!r?.auth_domain) {
      throw new Error("no Zero Trust organization on this account");
    }
    return { authDomain: r.auth_domain, name: r.name };
  }

  async listAccessApps(
    accountId: string,
  ): Promise<Array<{ id: string; aud: string; name: string; domain: string }>> {
    return this.req("GET", `/accounts/${accountId}/access/apps`);
  }

  async createAccessApp(
    accountId: string,
    params: { name: string; domain: string },
  ): Promise<{ id: string; aud: string }> {
    return this.req("POST", `/accounts/${accountId}/access/apps`, {
      type: "self_hosted",
      name: params.name,
      domain: params.domain,
      session_duration: "24h",
    });
  }

  async createAccessPolicy(
    accountId: string,
    appId: string,
    params: { name: string; emails: string[] },
  ): Promise<{ id: string }> {
    return this.req(
      "POST",
      `/accounts/${accountId}/access/apps/${appId}/policies`,
      {
        name: params.name,
        decision: "allow",
        include: params.emails.map((email) => ({ email: { email } })),
      },
    );
  }

  async deleteAccessApp(accountId: string, appId: string): Promise<void> {
    await this.req("DELETE", `/accounts/${accountId}/access/apps/${appId}`);
  }
}
