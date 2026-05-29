// Minimal parser for `.gitflare/deploy.yml`. We intentionally do NOT pull a
// full YAML library — the schema is fixed and small, and the worker bundle
// ships inside the CLI. This understands exactly the v0.2 shape:
//
//   on: push
//   branches: [main]
//   steps:
//     - cloudflare/deploy:
//         project: my-worker
//         kind: worker
//         entry: dist/worker.js
//
// Anything outside this shape is reported as an error rather than guessed at.

export interface DeployStep {
  type: "cloudflare/deploy";
  project: string;
  kind: "worker" | "pages";
  entry: string;
}

export interface DeployWorkflow {
  on: string[]; // e.g. ["push"]
  branches: string[]; // empty = every branch
  steps: DeployStep[];
}

export interface ParseResult {
  workflow?: DeployWorkflow;
  error?: string;
}

function stripComment(line: string): string {
  // Naive: drop a trailing " # ..." comment. Good enough for this schema —
  // values here are identifiers/paths, not strings containing '#'.
  const i = line.indexOf(" #");
  return i === -1 ? line : line.slice(0, i);
}

function parseInlineList(value: string): string[] | null {
  const m = value.match(/^\[(.*)\]$/);
  if (!m) return null;
  return m[1]!
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

export function parseDeployWorkflow(src: string): ParseResult {
  const rawLines = src.split(/\r?\n/);
  const on: string[] = [];
  let branches: string[] = [];
  const steps: DeployStep[] = [];

  // Index lines with their indentation, skipping blanks/comment-only lines.
  const lines: Array<{ indent: number; text: string }> = [];
  for (const raw of rawLines) {
    if (raw.trim().startsWith("#")) continue; // full-line comment
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ indent, text: noComment.trim() });
  }

  let i = 0;
  while (i < lines.length) {
    const { indent, text } = lines[i]!;
    if (indent !== 0) {
      return { error: `unexpected indentation at: "${text}"` };
    }

    if (text.startsWith("on:")) {
      const v = text.slice(3).trim();
      const inline = parseInlineList(v);
      if (inline) on.push(...inline);
      else if (v) on.push(unquote(v));
      i++;
    } else if (text.startsWith("branches:")) {
      const v = text.slice("branches:".length).trim();
      const inline = parseInlineList(v);
      if (inline) branches = inline;
      else if (v) branches = [unquote(v)];
      else {
        // Block list form.
        i++;
        while (i < lines.length && lines[i]!.indent > 0 && lines[i]!.text.startsWith("- ")) {
          branches.push(unquote(lines[i]!.text.slice(2)));
          i++;
        }
        continue;
      }
      i++;
    } else if (text === "steps:") {
      i++;
      const r = parseSteps(lines, i, steps);
      if (r.error) return { error: r.error };
      i = r.next;
    } else {
      return { error: `unknown top-level key: "${text}"` };
    }
  }

  if (on.length === 0) return { error: "missing `on:`" };
  if (steps.length === 0) return { error: "no steps defined" };

  return { workflow: { on, branches, steps } };
}

function parseSteps(
  lines: Array<{ indent: number; text: string }>,
  start: number,
  out: DeployStep[],
): { next: number; error?: string } {
  let i = start;
  while (i < lines.length && lines[i]!.indent > 0) {
    const line = lines[i]!;
    const m = line.text.match(/^-\s*cloudflare\/deploy:\s*$/);
    if (!m) {
      return { next: i, error: `unsupported step: "${line.text}" (only cloudflare/deploy)` };
    }
    const stepIndent = line.indent;
    i++;
    const fields: Record<string, string> = {};
    while (i < lines.length && lines[i]!.indent > stepIndent) {
      const kv = lines[i]!.text.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (kv) fields[kv[1]!] = unquote(kv[2]!);
      i++;
    }
    const project = fields.project;
    const kind = (fields.kind ?? "worker") as DeployStep["kind"];
    const entry = fields.entry;
    if (!project) return { next: i, error: "step missing `project`" };
    if (!entry) return { next: i, error: "step missing `entry`" };
    if (kind !== "worker" && kind !== "pages") {
      return { next: i, error: `unsupported kind: "${kind}" (worker only in v0.2 MVP)` };
    }
    out.push({ type: "cloudflare/deploy", project, kind, entry });
  }
  return { next: i };
}

/** Does this workflow run for a push to `ref` (e.g. "refs/heads/main")? */
export function matchesPush(wf: DeployWorkflow, ref: string): boolean {
  if (!wf.on.includes("push")) return false;
  if (wf.branches.length === 0) return true;
  const branch = ref.replace(/^refs\/heads\//, "");
  return wf.branches.includes(branch);
}
