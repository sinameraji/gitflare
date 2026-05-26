export type RepoVisibility = "public" | "private-single" | "private-mesh";

export interface RepoBinding {
  owner: string;
  name: string;
  githubFullName: string;
  visibility: RepoVisibility;
  artifactsRepoId: string;
  createdAt: string;
}

export interface SyncStatus {
  lastSyncedAt: string | null;
  lastSyncSha: string | null;
  lagSeconds: number | null;
  githubReachable: boolean;
  lastError: string | null;
}

export interface WebhookPushPayload {
  ref: string;
  before: string;
  after: string;
  repository: { full_name: string; clone_url: string };
  pusher: { name: string; email: string };
}
