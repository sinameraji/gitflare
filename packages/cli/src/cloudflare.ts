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

  // --- Queues + event subscriptions (M9) ---
  // Shapes verified live 2026-08-19: queues return {queue_id, queue_name};
  // subscriptions take source {type:"artifacts.repo", namespace, repo_name}
  // (snake_case, both required) and destination {type:"queues.queue", queue_id}.

  async listQueues(accountId: string): Promise<Array<{ queue_id: string; queue_name: string }>> {
    return this.req("GET", `/accounts/${accountId}/queues`);
  }

  async createQueue(accountId: string, queueName: string): Promise<{ queue_id: string; queue_name: string }> {
    return this.req("POST", `/accounts/${accountId}/queues`, { queue_name: queueName });
  }

  async deleteQueue(accountId: string, queueId: string): Promise<void> {
    await this.req("DELETE", `/accounts/${accountId}/queues/${queueId}`);
  }

  async listEventSubscriptions(accountId: string): Promise<EventSubscription[]> {
    return this.req("GET", `/accounts/${accountId}/event_subscriptions/subscriptions`);
  }

  async createArtifactsPushSubscription(
    accountId: string,
    params: { name: string; namespace: string; repoName: string; queueId: string },
  ): Promise<EventSubscription> {
    return this.req("POST", `/accounts/${accountId}/event_subscriptions/subscriptions`, {
      name: params.name,
      enabled: true,
      source: { type: "artifacts.repo", namespace: params.namespace, repo_name: params.repoName },
      destination: { type: "queues.queue", queue_id: params.queueId },
      events: ["pushed"],
    });
  }

  async setEventSubscriptionEnabled(accountId: string, id: string, enabled: boolean): Promise<void> {
    await this.req("PATCH", `/accounts/${accountId}/event_subscriptions/subscriptions/${id}`, { enabled });
  }

  async deleteEventSubscription(accountId: string, id: string): Promise<void> {
    await this.req("DELETE", `/accounts/${accountId}/event_subscriptions/subscriptions/${id}`);
  }

  // --- Artifacts tokens (REST) ---
  // {plaintext} carries a "?expires=<unix>" suffix; TTL 60 s … 31 536 000 s.

  async createRepoToken(
    accountId: string,
    namespace: string,
    params: { repo: string; scope: "read" | "write"; ttl: number },
  ): Promise<{ id: string; plaintext: string; expires_at: string; scope: string }> {
    return this.req("POST", `/accounts/${accountId}/artifacts/namespaces/${namespace}/tokens`, params);
  }
}

export interface EventSubscription {
  id: string;
  name: string;
  enabled: boolean;
  source: { type: string; namespace?: string; repo_name?: string };
  destination: { type: string; queue_id?: string };
  events: string[];
}
