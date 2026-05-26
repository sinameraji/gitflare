// Artifacts Workers binding surface. Typed against the public docs at
// https://developers.cloudflare.com/artifacts/api/workers-binding/ — the
// official @cloudflare/workers-types may not yet include this binding
// (Artifacts is in beta), so we declare what we use here.

export interface ArtifactsNamespace {
  create(name: string, opts?: CreateRepoOptions): Promise<CreatedRepo>;
  get(name: string): Promise<ArtifactsRepo>;
  list(opts?: ListReposOptions): Promise<{ repos: RepoSummary[]; cursor?: string }>;
  import(params: ImportParams): Promise<CreatedRepo>;
  delete(name: string): Promise<void>;
}

export interface CreateRepoOptions {
  description?: string;
  defaultBranch?: string;
  readOnly?: boolean;
}

export interface ImportParams {
  name: string;
  url: string;
  branch?: string;
  depth?: number;
}

export interface CreatedRepo {
  id: string;
  name: string;
  remote: string;
  // token shape: "art_v1_<secret>?expires=<unix_seconds>"
  token: string;
}

export interface RepoSummary {
  id: string;
  name: string;
  remote: string;
}

export interface ListReposOptions {
  cursor?: string;
  limit?: number;
}

export interface ArtifactsRepo {
  name: string;
  remote: string;
  createToken(scope?: "read" | "write", ttlSeconds?: number): Promise<TokenResult>;
  listTokens(): Promise<TokenSummary[]>;
  revokeToken(tokenOrId: string): Promise<void>;
  fork(name: string, opts?: { branch?: string }): Promise<CreatedRepo>;
}

export interface TokenResult {
  token: string;
  expires: number;
}

export interface TokenSummary {
  id: string;
  scope: "read" | "write";
  expires: number;
}

// Helper: strip the "?expires=..." suffix to get the password for git Basic auth.
export function tokenSecret(token: string): string {
  const i = token.indexOf("?expires=");
  return i === -1 ? token : token.slice(0, i);
}
