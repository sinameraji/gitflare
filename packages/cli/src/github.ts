// Minimal GitHub REST client. Just what `gitflare init` needs.

export class GitHubClient {
  constructor(private token: string) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gitflare-cli",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getUser(): Promise<{ login: string; id: number }> {
    return this.req("GET", "/user");
  }

  async getRepo(
    owner: string,
    repo: string,
  ): Promise<{
    default_branch: string;
    private: boolean;
    clone_url: string;
    permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  }> {
    return this.req("GET", `/repos/${owner}/${repo}`);
  }

  /** Branch protection for `branch`: null when none (404) or not visible (403). */
  async getBranchProtection(owner: string, repo: string, branch: string): Promise<unknown | null> {
    try {
      return await this.req("GET", `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}/protection`);
    } catch (e) {
      const msg = (e as Error).message;
      if (/→ (404|403)/.test(msg)) return null;
      throw e;
    }
  }

  async listHooks(owner: string, repo: string): Promise<Array<{ id: number; config: { url?: string } }>> {
    return this.req("GET", `/repos/${owner}/${repo}/hooks`);
  }

  async createHook(
    owner: string,
    repo: string,
    params: { url: string; secret: string; events: string[] },
  ): Promise<{ id: number }> {
    return this.req("POST", `/repos/${owner}/${repo}/hooks`, {
      name: "web",
      active: true,
      events: params.events,
      config: {
        url: params.url,
        secret: params.secret,
        content_type: "json",
        insecure_ssl: "0",
      },
    });
  }

  async deleteHook(owner: string, repo: string, id: number): Promise<void> {
    await this.req("DELETE", `/repos/${owner}/${repo}/hooks/${id}`);
  }
}
