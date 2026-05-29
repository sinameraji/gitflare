import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemFs } from "../sync/memfs";
import { tokenSecret, type ArtifactsRepo } from "../types";

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
  oid: string;
}

export interface RepoContent {
  defaultBranch: string;
  headSha: string;
  tree: TreeEntry[];      // top-level entries only
  readme?: { path: string; text: string };
  totalBytes: number;
}

export interface ShallowRepo {
  fs: MemFs;
  dir: string;
  headSha: string;
  branchName: string;
}

export interface BlobAtPath {
  path: string;
  bytes: Uint8Array;
  size: number;
  isBinary: boolean;
  text?: string;
}

const README_NAMES = [
  "README.md",
  "Readme.md",
  "readme.md",
  "README.MD",
  "README",
  "README.rst",
  "README.txt",
];

/**
 * Shallow-clone the default branch tip from Artifacts. Used by every
 * browsing route (home, tree, blob). The clone fetches the full snapshot
 * at depth=1 — all trees + blobs for that commit — so subsequent
 * read* calls are local memfs operations.
 */
export async function cloneRepoShallow(
  repo: ArtifactsRepo,
  remote: string,
): Promise<ShallowRepo> {
  const tokenResult = (await repo.createToken("read", 180)) as {
    plaintext?: string;
    token?: string;
  };
  const rawToken = tokenResult.plaintext ?? tokenResult.token;
  if (!rawToken) throw new Error("createToken returned no token");
  const password = tokenSecret(rawToken);

  const refs = await git.listServerRefs({
    http,
    url: remote,
    onAuth: () => ({ username: "x", password }),
  });
  const head = refs.find((r) => r.ref === "HEAD");
  if (!head) throw new Error("remote has no HEAD ref");

  const defaultRef = refs.find(
    (r) => r.ref !== "HEAD" && r.ref.startsWith("refs/heads/") && r.oid === head.oid,
  );
  const branchName = defaultRef
    ? defaultRef.ref.replace(/^refs\/heads\//, "")
    : "main";

  const fs = new MemFs();
  const dir = "/repo";
  await git.clone({
    fs,
    http,
    dir,
    url: remote,
    ref: branchName,
    singleBranch: true,
    depth: 1,
    noCheckout: true,
    noTags: true,
    onAuth: () => ({ username: "x", password }),
  });

  return { fs, dir, headSha: head.oid, branchName };
}

/** Walk to a path in the tree and return entries (for directories) or null (for blobs/missing). */
async function resolveTree(
  shallow: ShallowRepo,
  path: string,
): Promise<{ entries: Array<{ path: string; oid: string; type: string; mode: string }> } | null> {
  const commit = await git.readCommit({ fs: shallow.fs, dir: shallow.dir, oid: shallow.headSha });
  let treeOid = commit.commit.tree;
  const segments = path.split("/").filter(Boolean);
  for (const seg of segments) {
    const tree = await git.readTree({ fs: shallow.fs, dir: shallow.dir, oid: treeOid });
    const next = tree.tree.find((e) => e.path === seg);
    if (!next || next.type !== "tree") return null;
    treeOid = next.oid;
  }
  const tree = await git.readTree({ fs: shallow.fs, dir: shallow.dir, oid: treeOid });
  return { entries: tree.tree };
}

/** List entries at a path. Returns null if the path doesn't exist or is a file. */
export async function listTreeAt(
  shallow: ShallowRepo,
  path: string,
): Promise<TreeEntry[] | null> {
  const t = await resolveTree(shallow, path);
  if (!t) return null;
  const out: TreeEntry[] = [];
  for (const e of t.entries) {
    const isBlob = e.type === "blob";
    let size: number | undefined;
    if (isBlob) {
      try {
        const blob = await git.readBlob({ fs: shallow.fs, dir: shallow.dir, oid: e.oid });
        size = blob.blob.byteLength;
      } catch {
        // ignore
      }
    }
    out.push({
      path: e.path,
      type: isBlob ? "blob" : "tree",
      ...(size !== undefined ? { size } : {}),
      oid: e.oid,
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return out;
}

/** Read a single blob at a path. Returns null if path doesn't exist or is a directory. */
export async function readBlobAt(
  shallow: ShallowRepo,
  path: string,
): Promise<BlobAtPath | null> {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const parent = segments.slice(0, -1).join("/");
  const leaf = segments[segments.length - 1]!;
  const parentTree = await resolveTree(shallow, parent);
  if (!parentTree) return null;
  const entry = parentTree.entries.find((e) => e.path === leaf);
  if (!entry || entry.type !== "blob") return null;
  const blob = await git.readBlob({ fs: shallow.fs, dir: shallow.dir, oid: entry.oid });
  const bytes = blob.blob;
  const isBinary = looksBinary(bytes);
  return {
    path: segments.join("/"),
    bytes,
    size: bytes.byteLength,
    isBinary,
    ...(isBinary ? {} : { text: new TextDecoder().decode(bytes) }),
  };
}

function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(8000, bytes.byteLength));
  for (const b of sample) {
    if (b === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deploy helpers (v0.2): read a directory of files, and read at a given commit.
// ---------------------------------------------------------------------------

export interface FileAtPath {
  path: string; // relative to the requested dir
  bytes: Uint8Array;
}

async function treeOidAtPath(
  shallow: ShallowRepo,
  commitOid: string,
  path: string,
): Promise<string | null> {
  const commit = await git.readCommit({ fs: shallow.fs, dir: shallow.dir, oid: commitOid });
  let treeOid = commit.commit.tree;
  for (const seg of path.split("/").filter(Boolean)) {
    const tree = await git.readTree({ fs: shallow.fs, dir: shallow.dir, oid: treeOid });
    const next = tree.tree.find((e) => e.path === seg);
    if (!next || next.type !== "tree") return null;
    treeOid = next.oid;
  }
  return treeOid;
}

/**
 * Recursively list every blob under `dirPath` (default branch tip), with paths
 * relative to `dirPath`. Used to upload a Pages static directory. Bounded by
 * `maxFiles` to avoid unbounded work.
 */
export async function listFilesUnder(
  shallow: ShallowRepo,
  commitOid: string,
  dirPath: string,
  maxFiles = 5000,
): Promise<FileAtPath[] | null> {
  const rootTreeOid = await treeOidAtPath(shallow, commitOid, dirPath);
  if (rootTreeOid === null) return null;
  const out: FileAtPath[] = [];
  const walk = async (treeOid: string, prefix: string): Promise<void> => {
    const tree = await git.readTree({ fs: shallow.fs, dir: shallow.dir, oid: treeOid });
    for (const e of tree.tree) {
      if (out.length >= maxFiles) return;
      const rel = prefix ? `${prefix}/${e.path}` : e.path;
      if (e.type === "tree") await walk(e.oid, rel);
      else if (e.type === "blob") {
        const blob = await git.readBlob({ fs: shallow.fs, dir: shallow.dir, oid: e.oid });
        out.push({ path: rel, bytes: blob.blob });
      }
    }
  };
  await walk(rootTreeOid, "");
  return out;
}

/** Read a blob at an explicit commit oid (used by rollback). */
export async function readBlobAtCommit(
  shallow: ShallowRepo,
  commitOid: string,
  path: string,
): Promise<BlobAtPath | null> {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const parent = segments.slice(0, -1).join("/");
  const leaf = segments[segments.length - 1]!;
  const parentTreeOid = await treeOidAtPath(shallow, commitOid, parent);
  if (parentTreeOid === null) return null;
  const parentTree = await git.readTree({ fs: shallow.fs, dir: shallow.dir, oid: parentTreeOid });
  const entry = parentTree.tree.find((e) => e.path === leaf);
  if (!entry || entry.type !== "blob") return null;
  const blob = await git.readBlob({ fs: shallow.fs, dir: shallow.dir, oid: entry.oid });
  const bytes = blob.blob;
  const isBinary = looksBinary(bytes);
  return {
    path: segments.join("/"),
    bytes,
    size: bytes.byteLength,
    isBinary,
    ...(isBinary ? {} : { text: new TextDecoder().decode(bytes) }),
  };
}

/**
 * Full clone (no depth limit) of the default branch, so any historical commit
 * is reachable. Heavier than cloneRepoShallow — used only for rollback.
 */
export async function cloneRepoFull(
  repo: ArtifactsRepo,
  remote: string,
): Promise<ShallowRepo> {
  const tokenResult = (await repo.createToken("read", 180)) as {
    plaintext?: string;
    token?: string;
  };
  const rawToken = tokenResult.plaintext ?? tokenResult.token;
  if (!rawToken) throw new Error("createToken returned no token");
  const password = tokenSecret(rawToken);

  const refs = await git.listServerRefs({
    http,
    url: remote,
    onAuth: () => ({ username: "x", password }),
  });
  const head = refs.find((r) => r.ref === "HEAD");
  if (!head) throw new Error("remote has no HEAD ref");
  const defaultRef = refs.find(
    (r) => r.ref !== "HEAD" && r.ref.startsWith("refs/heads/") && r.oid === head.oid,
  );
  const branchName = defaultRef ? defaultRef.ref.replace(/^refs\/heads\//, "") : "main";

  const fs = new MemFs();
  const dir = "/repo";
  await git.clone({
    fs,
    http,
    dir,
    url: remote,
    ref: branchName,
    singleBranch: true,
    noCheckout: true,
    noTags: true,
    onAuth: () => ({ username: "x", password }),
  });
  return { fs, dir, headSha: head.oid, branchName };
}

/**
 * Top-level tree + README. Convenience wrapper for the home dashboard.
 */
export async function getRepoContent(
  repo: ArtifactsRepo,
  remote: string,
): Promise<RepoContent> {
  const shallow = await cloneRepoShallow(repo, remote);
  const commit = await git.readCommit({ fs: shallow.fs, dir: shallow.dir, oid: shallow.headSha });
  const rootTree = await git.readTree({ fs: shallow.fs, dir: shallow.dir, oid: commit.commit.tree });

  const tree: TreeEntry[] = [];
  let readme: RepoContent["readme"];
  let totalBytes = 0;

  for (const entry of rootTree.tree) {
    const isBlob = entry.type === "blob";
    let size: number | undefined;
    if (isBlob) {
      try {
        const blob = await git.readBlob({ fs: shallow.fs, dir: shallow.dir, oid: entry.oid });
        size = blob.blob.byteLength;
        totalBytes += size;
        if (!readme && README_NAMES.includes(entry.path)) {
          readme = {
            path: entry.path,
            text: new TextDecoder().decode(blob.blob),
          };
        }
      } catch {
        // ignore — we'll still list the entry without a size
      }
    }
    tree.push({
      path: entry.path,
      type: isBlob ? "blob" : "tree",
      ...(size !== undefined ? { size } : {}),
      oid: entry.oid,
    });
  }

  tree.sort((a, b) => {
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return {
    defaultBranch: shallow.branchName,
    headSha: shallow.headSha,
    tree,
    totalBytes,
    ...(readme ? { readme } : {}),
  };
}
