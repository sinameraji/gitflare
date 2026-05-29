import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

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
  return out;
}

function tomlFor(main: string, p: DeployParams, version: string): string {
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

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RepoDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["DeployDO"]

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
