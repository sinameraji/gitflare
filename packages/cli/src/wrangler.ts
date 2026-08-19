import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

// The sandbox container image the CI feature runs jobs in. The tag must match
// the worker's @cloudflare/sandbox dependency version.
const SANDBOX_IMAGE = "docker.io/cloudflare/sandbox:0.12.3";

export interface RepoMapEntry {
  name: string;
  remote: string;
}

export interface DeployParams {
  cloudflareApiToken: string;
  accountId: string;
  workerName: string;
  artifactsNamespace: string;
  repoMap: Record<string, RepoMapEntry>;
  // Cloudflare Access (set by `gitflare access enable`). Both present → the
  // Worker gates its dashboard/API behind Access; both absent → public mirror.
  accessAud?: string;
  accessTeamDomain?: string;
  // Continuous deploy (set by `gitflare deploy enable`). Emits CD_ENABLED="1".
  cdEnabled?: boolean;
  // CI on Cloudflare Sandboxes (set by `gitflare ci enable`). `provisioned`
  // emits the SANDBOX binding + containers block; `enabled` emits CI_ENABLED.
  ci?: { provisioned: boolean; enabled: boolean; instanceType: string };
  // Mirror-push sync (set by `gitflare sync enable`, M9). `provisioned` emits
  // the [[queues.consumers]] block for the Artifacts-events queue; `enabled`
  // emits SYNC_ENABLED (reverse pushes + event-driven dispatch).
  sync?: { provisioned: boolean; enabled: boolean; queueName: string };
  // The Worker's own public URL, once known (every redeploy). The queue
  // consumer has no request to derive it from and needs it for status links.
  workerUrl?: string;
}

/**
 * The queue that receives this Worker's Artifacts `pushed` events. Queue names
 * accept `--` (verified live), so the worker name is used as-is.
 */
export function queueNameFor(workerName: string): string {
  return `${workerName}-events`;
}

export interface DeployResult {
  workerUrl: string;
  workDir: string;
  raw: string;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locate the worker source. Two modes:
 *  - **Published** (most users): a pre-bundled `worker-bundle.js` ships in
 *    the CLI's `dist/` and is the entry wrangler sees.
 *  - **Monorepo dev**: when running from a checkout of the gitflare repo,
 *    we point wrangler at the sibling `packages/worker/src/index.tsx`.
 *
 * Returns the absolute path to either the bundle or the source dir.
 */
async function locateWorker(): Promise<
  | { kind: "bundle"; path: string }
  | { kind: "source"; dir: string }
> {
  // dist/worker-bundle.js relative to either dist/wrangler.js (compiled)
  // or src/wrangler.ts (tsx dev mode)
  const candidates = [
    join(HERE, "worker-bundle.js"),          // compiled: dist/wrangler.js → dist/worker-bundle.js
    join(HERE, "..", "dist", "worker-bundle.js"), // dev under src/
  ];
  for (const c of candidates) {
    if (await fileExists(c)) return { kind: "bundle", path: c };
  }
  // Monorepo source fallback.
  const sourceDir = join(HERE, "..", "..", "worker");
  if (await fileExists(join(sourceDir, "src", "index.tsx"))) {
    return { kind: "source", dir: sourceDir };
  }
  throw new Error(
    "Could not find the worker. Tried bundle at dist/worker-bundle.js " +
      "and source at ../worker. Run `pnpm build` if you're in a checkout.",
  );
}

function varsBlock(p: DeployParams, version: string): string {
  let out = `[vars]
GITFLARE_VERSION = "${version}"
ACCOUNT_ID = "${p.accountId}"
REPO_MAP = ${JSON.stringify(JSON.stringify(p.repoMap))}
`;
  if (p.accessAud && p.accessTeamDomain) {
    out += `ACCESS_AUD = ${JSON.stringify(p.accessAud)}
ACCESS_TEAM_DOMAIN = ${JSON.stringify(p.accessTeamDomain)}
`;
  }
  if (p.cdEnabled) {
    out += `CD_ENABLED = "1"
`;
  }
  if (p.ci?.enabled) {
    out += `CI_ENABLED = "1"
`;
  }
  if (p.sync?.enabled) {
    out += `SYNC_ENABLED = "1"
`;
  }
  if (p.workerUrl) {
    out += `WORKER_URL = ${JSON.stringify(p.workerUrl)}
`;
  }
  return out;
}

export function tomlFor(main: string, p: DeployParams, version: string): string {
  // The SANDBOX binding + containers block are only emitted once CI has been
  // provisioned (paid-plan Containers). The v3/v4 migrations below are always
  // emitted regardless.
  // The container application name must be a valid Cloudflare namespace label:
  // no consecutive dashes. wrangler otherwise derives it as `${workerName}-sandbox`,
  // and workerName carries `--` from the `owner--repo` Artifacts convention, so
  // we set an explicit collapsed name (stable across redeploys — it identifies
  // the container application; don't change it once created).
  const containerName = `${p.workerName}-sandbox`.replace(/-+/g, "-");
  const sandbox = p.ci?.provisioned
    ? `[[durable_objects.bindings]]
name = "SANDBOX"
class_name = "Sandbox"

[[containers]]
name = "${containerName}"
class_name = "Sandbox"
image = "${SANDBOX_IMAGE}"
instance_type = "${p.ci.instanceType}"
max_instances = 5

`
    : "";
  // The Artifacts-events queue consumer (M9). Only once `sync enable` has
  // created the queue — wrangler refuses to bind a consumer to a queue that
  // doesn't exist. Stays after `sync disable` (SYNC_ENABLED is what gates
  // behaviour); `sync disable --purge` drops it.
  const consumer = p.sync?.provisioned
    ? `[[queues.consumers]]
queue = "${p.sync.queueName}"
max_batch_size = 10
max_batch_timeout = 2
max_retries = 5

`
    : "";
  // v3/v4 are unconditional ON PURPOSE: migrations are free-plan-safe, and
  // gating them on local config would hard-fail redeploys from a second
  // machine once they've been applied remotely.
  return `name = "${p.workerName}"
main = "${main}"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]
account_id = "${p.accountId}"

[[artifacts]]
binding = "ARTIFACTS"
namespace = "${p.artifactsNamespace}"

[[durable_objects.bindings]]
name = "REPO"
class_name = "RepoDO"

[[durable_objects.bindings]]
name = "DEPLOY"
class_name = "DeployDO"

[[durable_objects.bindings]]
name = "CI"
class_name = "CiDO"

${sandbox}${consumer}[[migrations]]
tag = "v1"
new_sqlite_classes = ["RepoDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["DeployDO"]

[[migrations]]
tag = "v3"
new_sqlite_classes = ["CiDO"]

[[migrations]]
tag = "v4"
new_sqlite_classes = ["Sandbox"]

${varsBlock(p, version)}`;
}

function bundledToml(p: DeployParams, version: string): string {
  return tomlFor("worker.js", p, version);
}

function sourceToml(p: DeployParams, version: string): string {
  return tomlFor("src/index.tsx", p, version);
}

async function getCliVersion(): Promise<string> {
  try {
    const pkgPath = join(HERE, "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Stage a working directory wrangler can deploy from. */
async function prepareWorkDir(p: DeployParams): Promise<string> {
  const loc = await locateWorker();
  const version = await getCliVersion();
  if (loc.kind === "bundle") {
    const dir = await mkdtemp(join(tmpdir(), "gitflare-deploy-"));
    await copyFile(loc.path, join(dir, "worker.js"));
    await writeFile(join(dir, "wrangler.toml"), bundledToml(p, version), "utf8");
    return dir;
  }
  // Source mode: write wrangler.toml in place; wrangler builds from there.
  await writeFile(join(loc.dir, "wrangler.toml"), sourceToml(p, version), "utf8");
  return loc.dir;
}

function findWranglerBin(): string {
  const pkgPath = requireFromHere.resolve("wrangler/package.json");
  const wranglerDir = dirname(pkgPath);
  const pkg = requireFromHere(pkgPath) as { bin?: string | Record<string, string> };
  const binRel =
    typeof pkg.bin === "string"
      ? pkg.bin
      : pkg.bin?.["wrangler"] ?? "bin/wrangler.js";
  return join(wranglerDir, binRel);
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runWrangler(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin?: string },
): Promise<RunResult> {
  const bin = findWranglerBin();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}

export async function wranglerDeploy(p: DeployParams): Promise<DeployResult> {
  const workDir = await prepareWorkDir(p);
  const res = await runWrangler(["deploy"], {
    cwd: workDir,
    env: { CLOUDFLARE_API_TOKEN: p.cloudflareApiToken },
  });
  if (res.code !== 0) {
    throw new Error(
      `wrangler deploy failed (exit ${res.code}):\n${res.stdout}\n${res.stderr}`,
    );
  }
  const urlMatch = res.stdout.match(
    /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i,
  );
  if (!urlMatch) {
    throw new Error(`Could not find Worker URL in wrangler output:\n${res.stdout}`);
  }
  return { workerUrl: urlMatch[0], workDir, raw: res.stdout };
}

export async function wranglerSecret(
  workDir: string,
  apiToken: string,
  name: string,
  value: string,
): Promise<void> {
  const res = await runWrangler(["secret", "put", name], {
    cwd: workDir,
    env: { CLOUDFLARE_API_TOKEN: apiToken },
    stdin: value + "\n",
  });
  if (res.code !== 0) {
    throw new Error(`wrangler secret put ${name} failed:\n${res.stderr}`);
  }
}
