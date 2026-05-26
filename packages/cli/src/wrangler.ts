import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the @gitflare/worker package directory. In the monorepo it lives at
 * ../../worker relative to packages/cli/src; once packaged we'd ship the
 * worker template alongside. For YOLO M2 we use the monorepo path.
 */
export function workerPackageDir(): string {
  // dist/index.js → packages/cli/dist; src/wrangler.ts → packages/cli/src
  // Either way, climb to packages/, then into worker.
  // From src: ../../worker. From dist: ../../worker (because cli/dist is one deeper)
  // Simplest: try both.
  const candidates = [
    join(HERE, "..", "..", "worker"),       // from packages/cli/src or cli/dist
    join(HERE, "..", "..", "..", "worker"), // safety
  ];
  return candidates[0]!;
}

export interface RepoMapEntry {
  name: string;
  remote: string;
}

export interface DeployParams {
  workerPackageDir: string;
  cloudflareApiToken: string;
  accountId: string;
  workerName: string;
  artifactsNamespace: string;
  repoMap: Record<string, RepoMapEntry>;
}

export async function writeWranglerToml(p: DeployParams): Promise<void> {
  const toml = `name = "${p.workerName}"
main = "src/index.tsx"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]
account_id = "${p.accountId}"

[[artifacts]]
binding = "ARTIFACTS"
namespace = "${p.artifactsNamespace}"

[[durable_objects.bindings]]
name = "REPO"
class_name = "RepoDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RepoDO"]

[vars]
GITFLARE_VERSION = "0.0.0"
REPO_MAP = ${JSON.stringify(JSON.stringify(p.repoMap))}
`;
  await fs.writeFile(join(p.workerPackageDir, "wrangler.toml"), toml, "utf8");
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export async function wranglerDeploy(p: DeployParams): Promise<{ workerUrl: string; raw: string }> {
  const env = { CLOUDFLARE_API_TOKEN: p.cloudflareApiToken };
  const res = await run("pnpm", ["exec", "wrangler", "deploy"], {
    cwd: p.workerPackageDir,
    env,
  });
  if (res.code !== 0) {
    throw new Error(
      `wrangler deploy failed (exit ${res.code}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  // Wrangler prints lines like: "Uploaded gitflare (X sec)" and a workers.dev URL.
  const urlMatch = res.stdout.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  if (!urlMatch) {
    throw new Error(`Could not find Worker URL in wrangler output:\n${res.stdout}`);
  }
  return { workerUrl: urlMatch[0], raw: res.stdout };
}

export async function wranglerSecret(
  workerPackageDir: string,
  apiToken: string,
  name: string,
  value: string,
): Promise<void> {
  const child = spawn(
    "pnpm",
    ["exec", "wrangler", "secret", "put", name],
    {
      cwd: workerPackageDir,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: apiToken },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdin.write(value + "\n");
  child.stdin.end();
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? -1));
  });
  if (code !== 0) {
    throw new Error(`wrangler secret put ${name} failed:\n${stderr}`);
  }
}
