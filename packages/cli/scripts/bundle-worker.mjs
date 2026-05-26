#!/usr/bin/env node
// Bundle the Cloudflare Worker (packages/worker/src/index.tsx) into a single
// ESM file that ships inside the CLI's npm package. After install, the CLI
// writes this bundle to a temp directory plus a generated wrangler.toml and
// runs `wrangler deploy` against it — no monorepo needed at runtime.

import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, stat } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = join(HERE, "..");
const WORKER_ENTRY = join(CLI_DIR, "..", "worker", "src", "index.tsx");
const OUT_DIR = join(CLI_DIR, "dist");
const OUT_FILE = join(OUT_DIR, "worker-bundle.js");

await mkdir(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: [WORKER_ENTRY],
  bundle: true,
  outfile: OUT_FILE,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "hono/jsx",
  conditions: ["workerd", "worker", "browser"],
  mainFields: ["browser", "module", "main"],
  external: ["cloudflare:*", "node:*"],
  minify: false, // keep readable so wrangler errors point at useful lines
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

const s = await stat(OUT_FILE);
console.log(`✓ worker bundle: ${OUT_FILE} (${(s.size / 1024).toFixed(1)} KB)`);
if (result.warnings.length) {
  console.warn(`(${result.warnings.length} warnings — see above)`);
}
