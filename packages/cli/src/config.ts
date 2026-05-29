import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface LocalConfig {
  version: 1;
  repos: Array<{
    githubFullName: string;
    cloudflareAccountId: string;
    artifactsNamespace: string;
    artifactsRepoName: string;
    workerName: string;
    workerUrl: string;
    createdAt: string;
    // Set by `gitflare access enable`; cleared by `disable`.
    access?: {
      appId: string;
      aud: string;
      teamDomain: string;
      allowedEmails: string[];
    };
    // Set by `gitflare deploy enable`; cleared by `disable`.
    deploy?: {
      enabledAt: string;
      // Bearer secret the CLI presents to the Worker's /control/* endpoints.
      controlSecret: string;
    };
  }>;
  // Tokens — kept local, never sent to gitflare servers.
  github?: { token: string };
  cloudflare?: { token: string };
}

const PATH = join(homedir(), ".gitflare", "credentials.json");

export function configPath(): string {
  return PATH;
}

export async function loadConfig(): Promise<LocalConfig> {
  try {
    const raw = await fs.readFile(PATH, "utf8");
    return JSON.parse(raw) as LocalConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, repos: [] };
    }
    throw err;
  }
}

export async function saveConfig(cfg: LocalConfig): Promise<void> {
  await fs.mkdir(dirname(PATH), { recursive: true, mode: 0o700 });
  await fs.writeFile(PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
