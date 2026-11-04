// Pure blame: given the successive versions of one file along a first-parent
// chain (newest first), attribute every line of the newest version to the
// commit that introduced it. No I/O — `history.ts` gathers the versions from
// an isomorphic-git clone; this module only diffs text.
//
// Model (same as `git blame --first-parent`, plus a light `-M`):
//   versions[0]     the file as shown, introduced by versions[0].commit
//   versions[i + 1] the content versions[i].commit replaced (its parent's copy)
// A line of versions[i] that the diff against versions[i + 1] marks as new is
// blamed on versions[i].commit; an unchanged (or moved) line is traced into
// versions[i + 1] and the walk continues. Lines that survive to the last
// version belong to its commit — the file's creation, unless the history was
// cut short (`truncated`), in which case they are "boundary" lines: their true
// origin is somewhere older than the window we fetched (git prints `^sha`).

export interface BlameCommit {
  sha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Author time, ms since epoch. */
  timestamp: number;
}

export interface BlameVersion {
  /** The commit that produced this content. */
  commit: BlameCommit;
  text: string;
}

export interface BlameLine {
  /** Index into BlameResult.commits. */
  commit: number;
  /** True when the line predates the fetched history window. */
  boundary: boolean;
  /** 1-based line number in the version that introduced it. */
  origLine: number;
}

export interface BlameHunk {
  /** 0-based index of the first line in the final file. */
  start: number;
  length: number;
  commit: number;
  boundary: boolean;
}

export interface BlameResult {
  /** Commits referenced by lines, in first-appearance order. */
  commits: BlameCommit[];
  lines: BlameLine[];
}

export interface BlameOptions {
  /** History ended at the window edge rather than at the file's creation. */
  truncated?: boolean;
  /** Edit-distance budget per diff; past it a version is treated as a rewrite. */
  maxEditDistance?: number;
  /** Minimum alphanumeric characters for a moved block to keep its origin. */
  moveMinAlnum?: number;
}

const DEFAULT_MAX_EDIT_DISTANCE = 2000;
// git blame -M uses 20 alnum chars as its "is this a real move" threshold.
const DEFAULT_MOVE_MIN_ALNUM = 20;

/** Split into lines the way git counts them (a trailing newline ends the last line). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function computeBlame(versions: BlameVersion[], opts: BlameOptions = {}): BlameResult {
  if (versions.length === 0) return { commits: [], lines: [] };
  const maxD = opts.maxEditDistance ?? DEFAULT_MAX_EDIT_DISTANCE;
  const moveMin = opts.moveMinAlnum ?? DEFAULT_MOVE_MIN_ALNUM;

  const finalLines = splitLines(versions[0]!.text);
  const n = finalLines.length;
  // owner[k] = version index the final line k is blamed on; pos[k] = its index in that version.
  const owner = new Int32Array(n).fill(-1);
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[k] = k;
  let pending: number[] = Array.from({ length: n }, (_, k) => k);

  let cur = finalLines;
  for (let i = 0; i < versions.length - 1 && pending.length > 0; i++) {
    const parent = splitLines(versions[i + 1]!.text);
    const map = mapLines(cur, parent, maxD, moveMin);
    const next: number[] = [];
    for (const k of pending) {
      const p = map[pos[k]!]!;
      if (p === -1) owner[k] = i;
      else {
        pos[k] = p;
        next.push(k);
      }
    }
    pending = next;
    cur = parent;
  }
  const last = versions.length - 1;
  const boundary = new Uint8Array(n);
  for (const k of pending) {
    owner[k] = last;
    if (opts.truncated) boundary[k] = 1;
  }

  const commits: BlameCommit[] = [];
  const indexOf = new Map<string, number>();
  const lines: BlameLine[] = [];
  for (let k = 0; k < n; k++) {
    const c = versions[owner[k]!]!.commit;
    let ci = indexOf.get(c.sha);
    if (ci === undefined) {
      ci = commits.length;
      commits.push(c);
      indexOf.set(c.sha, ci);
    }
    lines.push({ commit: ci, boundary: boundary[k] === 1, origLine: pos[k]! + 1 });
  }
  return { commits, lines };
}

/** Group consecutive lines blamed on the same commit. */
export function toHunks(lines: BlameLine[]): BlameHunk[] {
  const out: BlameHunk[] = [];
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    const prev = out[out.length - 1];
    if (prev && prev.commit === l.commit && prev.boundary === l.boundary) prev.length++;
    else out.push({ start: k, length: 1, commit: l.commit, boundary: l.boundary });
  }
  return out;
}

/**
 * For each line of `cur`, the index of the line it came from in `parent`, or
 * -1 if `cur` introduced it. Myers diff for the in-place matches, then a move
 * pass that re-links inserted blocks to identical deleted blocks.
 */
export function mapLines(cur: string[], parent: string[], maxD = DEFAULT_MAX_EDIT_DISTANCE, moveMinAlnum = DEFAULT_MOVE_MIN_ALNUM): Int32Array {
  const map = new Int32Array(cur.length).fill(-1);
  const used = new Uint8Array(parent.length);

  // Common prefix / suffix are free and cover most real edits.
  let pre = 0;
  while (pre < cur.length && pre < parent.length && cur[pre] === parent[pre]) {
    map[pre] = pre;
    used[pre] = 1;
    pre++;
  }
  let suf = 0;
  while (
    suf < cur.length - pre &&
    suf < parent.length - pre &&
    cur[cur.length - 1 - suf] === parent[parent.length - 1 - suf]
  ) {
    map[cur.length - 1 - suf] = parent.length - 1 - suf;
    used[parent.length - 1 - suf] = 1;
    suf++;
  }

  const a = parent.slice(pre, parent.length - suf);
  const b = cur.slice(pre, cur.length - suf);
  const matches = myers(a, b, maxD);
  if (matches) {
    for (const [ai, bi] of matches) {
      map[pre + bi] = pre + ai;
      used[pre + ai] = 1;
    }
  }
  // matches === null: edit distance over budget → treat the middle as rewritten;
  // the move pass below still recovers identical blocks.

  if (moveMinAlnum >= 0) detectMoves(cur, parent, map, used, moveMinAlnum);
  return map;
}

/**
 * Myers O((N+M)·D) shortest edit script; returns matched index pairs (a, b),
 * or null if the edit distance exceeds `maxD` (bounds CPU and the O(D²) trace).
 */
function myers(a: string[], b: string[], maxD: number): Array<[number, number]> | null {
  const N = a.length;
  const M = b.length;
  if (N === 0 || M === 0) return [];
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)) x = v[off + k + 1]!;
      else x = v[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break outer;
      }
    }
  }
  if (found === -1) return null;

  // Backtrack. trace[d] holds v[-d-1 .. d+1] as it was *before* step d.
  const out: Array<[number, number]> = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const t = trace[d]!;
    const at = (k: number): number => t[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push([x, y]);
    }
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push([x, y]);
  }
  return out;
}

function alnumCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n++;
  }
  return n;
}

/**
 * Re-link blocks the diff saw as delete + insert but that are really a move:
 * a run of inserted lines identical to a run of not-yet-matched parent lines
 * keeps the parent's origin when it carries enough real content.
 */
function detectMoves(cur: string[], parent: string[], map: Int32Array, used: Uint8Array, minAlnum: number): void {
  const byText = new Map<string, number[]>();
  for (let p = 0; p < parent.length; p++) {
    if (used[p]) continue;
    const list = byText.get(parent[p]!);
    if (list) list.push(p);
    else byText.set(parent[p]!, [p]);
  }
  if (byText.size === 0) return;

  let j = 0;
  while (j < cur.length) {
    if (map[j] !== -1) {
      j++;
      continue;
    }
    let best = 0;
    let bestP = -1;
    for (const p of byText.get(cur[j]!) ?? []) {
      if (used[p]) continue;
      let len = 0;
      while (
        j + len < cur.length &&
        p + len < parent.length &&
        map[j + len] === -1 &&
        !used[p + len] &&
        cur[j + len] === parent[p + len]
      )
        len++;
      if (len > best) {
        best = len;
        bestP = p;
      }
    }
    if (best > 0) {
      let chars = 0;
      for (let t = 0; t < best; t++) chars += alnumCount(cur[j + t]!);
      if (chars >= minAlnum) {
        for (let t = 0; t < best; t++) {
          map[j + t] = bestP + t;
          used[bestP + t] = 1;
        }
        j += best;
        continue;
      }
    }
    j++;
  }
}
