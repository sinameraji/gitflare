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
 * Shallow-fetch the default branch tip from Artifacts and return the
 * top-level tree + README content. Designed for one dashboard render —
 * fits in Worker CPU limits for repos up to a few thousand top-level entries.
 *
 * Heavier features (full tree walk, file viewer per blob) should be split
 * into separate routes that fetch only what they need.
 */
export async function getRepoContent(
  repo: ArtifactsRepo,
  remote: string,
): Promise<RepoContent> {
  const tokenResult = (await repo.createToken("read", 180)) as {
    plaintext?: string;
    token?: string;
  };
  const rawToken = tokenResult.plaintext ?? tokenResult.token;
  if (!rawToken) {
    throw new Error("createToken returned no token");
  }
  const password = tokenSecret(rawToken);

  // Discover the default branch via remote ref listing first.
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

  // Shallow clone (depth 1, no checkout) — this gets us the tip commit's
  // tree + blobs without setting up a working directory or needing to
  // configure a refspec the way bare git.fetch() does.
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

  const headSha = head.oid;
  const commit = await git.readCommit({ fs, dir, oid: headSha });
  const treeOid = commit.commit.tree;
  const rootTree = await git.readTree({ fs, dir, oid: treeOid });

  const tree: TreeEntry[] = [];
  let readme: RepoContent["readme"];
  let totalBytes = 0;

  for (const entry of rootTree.tree) {
    const isBlob = entry.type === "blob";
    let size: number | undefined;
    if (isBlob) {
      try {
        const blob = await git.readBlob({ fs, dir, oid: entry.oid });
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
    defaultBranch: branchName,
    headSha,
    tree,
    totalBytes,
    ...(readme ? { readme } : {}),
  };
}
