// Gather the versions of one file along the first-parent chain of a (shallow)
// isomorphic-git clone, in the shape `computeBlame` wants. Bounded: it walks at
// most `maxCommits` commits (the clone depth should match), and refuses files
// over `maxBytes` / `maxLines` — Workers have tight CPU and memory budgets.

import * as git from "isomorphic-git";
import type { BlameCommit, BlameVersion } from "./algorithm";
import { splitLines } from "./algorithm";

export interface HistoryLimits {
  maxCommits: number;
  maxBytes: number;
  maxLines: number;
}

export const DEFAULT_BLAME_LIMITS: HistoryLimits = {
  maxCommits: 100,
  maxBytes: 256 * 1024,
  maxLines: 8000,
};

export type TruncatedReason =
  /** Walked `maxCommits` commits (or hit the shallow clone's edge) without reaching the file's creation. */
  | { kind: "depth"; commits: number }
  /** An older version of the file is over the size cap, so the walk stopped there. */
  | { kind: "size"; commits: number; sha: string };

export type FileHistory =
  | { kind: "missing" }
  | { kind: "directory" }
  | { kind: "binary"; size: number }
  | { kind: "too-large"; size: number; lines?: number }
  | {
      kind: "ok";
      versions: BlameVersion[];
      /** Commits examined on the first-parent chain. */
      commitsWalked: number;
      truncated: TruncatedReason | null;
    };

type GitFs = Parameters<typeof git.readCommit>[0]["fs"];

interface Ctx {
  fs: GitFs;
  dir: string;
  cache: object;
  trees: Map<string, Array<{ path: string; oid: string; type: string }>>;
}

async function readTreeCached(ctx: Ctx, oid: string) {
  let t = ctx.trees.get(oid);
  if (!t) {
    t = (await git.readTree({ fs: ctx.fs, dir: ctx.dir, oid, cache: ctx.cache })).tree;
    ctx.trees.set(oid, t);
  }
  return t;
}

/** The blob oid at `segments` under `treeOid`; "tree" for a directory; null if absent. */
async function entryAt(ctx: Ctx, treeOid: string, segments: string[]): Promise<string | "tree" | null> {
  let oid = treeOid;
  for (let i = 0; i < segments.length; i++) {
    const e = (await readTreeCached(ctx, oid)).find((x) => x.path === segments[i]);
    if (!e) return null;
    const last = i === segments.length - 1;
    if (last) return e.type === "blob" ? e.oid : e.type === "tree" ? "tree" : null;
    if (e.type !== "tree") return null;
    oid = e.oid;
  }
  return null;
}

function toBlameCommit(oid: string, c: git.CommitObject): BlameCommit {
  return {
    sha: oid,
    subject: (c.message.split("\n")[0] ?? "").trim(),
    authorName: c.author.name,
    authorEmail: c.author.email,
    timestamp: c.author.timestamp * 1000,
  };
}

export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(8000, bytes.byteLength));
  for (const b of sample) if (b === 0) return true;
  return false;
}

export async function collectFileHistory(params: {
  fs: GitFs;
  dir: string;
  headSha: string;
  path: string;
  limits?: Partial<HistoryLimits>;
}): Promise<FileHistory> {
  const limits = { ...DEFAULT_BLAME_LIMITS, ...params.limits };
  const ctx: Ctx = { fs: params.fs, dir: params.dir, cache: {}, trees: new Map() };
  const segments = params.path.split("/").filter(Boolean);
  if (segments.length === 0) return { kind: "directory" };

  const readCommit = async (oid: string): Promise<git.CommitObject | null> => {
    try {
      return (await git.readCommit({ fs: ctx.fs, dir: ctx.dir, oid, cache: ctx.cache })).commit;
    } catch {
      return null; // outside the shallow window
    }
  };
  const readText = async (oid: string): Promise<{ bytes: Uint8Array; text: string | null }> => {
    const { blob } = await git.readBlob({ fs: ctx.fs, dir: ctx.dir, oid, cache: ctx.cache });
    return { bytes: blob, text: looksBinary(blob) ? null : new TextDecoder().decode(blob) };
  };

  let commitOid = params.headSha;
  let commit = await readCommit(commitOid);
  if (!commit) throw new Error(`commit ${commitOid.slice(0, 8)} is not in the clone`);
  const head = await entryAt(ctx, commit.tree, segments);
  if (head === null) return { kind: "missing" };
  if (head === "tree") return { kind: "directory" };

  // Head version gets the strict checks; it's the one the user sees.
  const headBlob = await readText(head);
  if (headBlob.text === null) return { kind: "binary", size: headBlob.bytes.byteLength };
  if (headBlob.bytes.byteLength > limits.maxBytes) return { kind: "too-large", size: headBlob.bytes.byteLength };
  const headLines = splitLines(headBlob.text).length;
  if (headLines > limits.maxLines) return { kind: "too-large", size: headBlob.bytes.byteLength, lines: headLines };

  const versions: BlameVersion[] = [];
  let curOid = head;
  let curText = headBlob.text;
  let introducer = toBlameCommit(commitOid, commit);
  let walked = 1;
  let truncated: TruncatedReason | null = null;

  for (;;) {
    const parentOid = commit.parent[0];
    if (!parentOid) {
      versions.push({ commit: introducer, text: curText }); // root commit: creation
      break;
    }
    if (walked >= limits.maxCommits) {
      versions.push({ commit: introducer, text: curText });
      truncated = { kind: "depth", commits: walked };
      break;
    }
    const parent = await readCommit(parentOid);
    if (!parent) {
      versions.push({ commit: introducer, text: curText });
      truncated = { kind: "depth", commits: walked };
      break;
    }
    walked++;
    const parentEntry = parent.tree === commit.tree ? curOid : await entryAt(ctx, parent.tree, segments);
    if (parentEntry === curOid) {
      // Unchanged across this commit: the content is older than `introducer`.
      introducer = toBlameCommit(parentOid, parent);
      commit = parent;
      commitOid = parentOid;
      continue;
    }
    versions.push({ commit: introducer, text: curText });
    if (parentEntry === null || parentEntry === "tree") break; // file created by `introducer`

    const blob = await readText(parentEntry);
    // A binary predecessor counts as "no text before": every line is new.
    if (blob.text === null) break;
    if (blob.bytes.byteLength > limits.maxBytes || splitLines(blob.text).length > limits.maxLines) {
      // Can't afford to diff it: the lines still unattributed stay with
      // `introducer` as boundary lines ("this commit or earlier").
      truncated = { kind: "size", commits: walked, sha: parentOid };
      break;
    }
    curOid = parentEntry;
    curText = blob.text;
    introducer = toBlameCommit(parentOid, parent);
    commit = parent;
    commitOid = parentOid;
  }

  return { kind: "ok", versions, commitsWalked: walked, truncated };
}
