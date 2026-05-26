// Minimal in-memory filesystem compatible with the subset of node:fs that
// isomorphic-git invokes. Implements the LightningFS-style "promises" surface
// plus a tiny `Stats`-like return. We intentionally keep this small — it is
// not a general-purpose fs.
//
// isomorphic-git calls (per its source):
//   readFile, writeFile, unlink, readdir, mkdir, rmdir, stat, lstat, readlink,
//   symlink, chmod.

type FileEntry = { kind: "file"; data: Uint8Array; mode: number };
type DirEntry = { kind: "dir"; mode: number };
type Entry = FileEntry | DirEntry;

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

class MemStats {
  constructor(
    private entry: Entry,
    private size_: number,
  ) {}
  isFile() { return this.entry.kind === "file"; }
  isDirectory() { return this.entry.kind === "dir"; }
  isSymbolicLink() { return false; }
  get size() { return this.size_; }
  get mode() { return this.entry.mode; }
  get mtimeMs() { return 0; }
  get ctimeMs() { return 0; }
}

class MemFsPromises {
  constructor(private entries: Map<string, Entry>) {}

  private norm(p: string): string {
    const out = p.replace(/\/+/g, "/").replace(/\/$/, "");
    return out.length === 0 ? "/" : out;
  }

  private ensureParent(p: string): void {
    const parent = dirname(p);
    if (parent === "/" || this.entries.has(parent)) return;
    throw Object.assign(new Error(`ENOENT: ${parent}`), { code: "ENOENT" });
  }

  async readFile(path: string, opts?: { encoding?: string }): Promise<Uint8Array | string> {
    const e = this.entries.get(this.norm(path));
    if (!e) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    if (e.kind !== "file") throw Object.assign(new Error(`EISDIR: ${path}`), { code: "EISDIR" });
    if (opts?.encoding === "utf8") return new TextDecoder().decode(e.data);
    return e.data;
  }

  async writeFile(path: string, data: Uint8Array | string, _opts?: unknown): Promise<void> {
    const p = this.norm(path);
    this.ensureParent(p);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.entries.set(p, { kind: "file", data: bytes, mode: 0o100644 });
  }

  async unlink(path: string): Promise<void> {
    this.entries.delete(this.norm(path));
  }

  async readdir(path: string): Promise<string[]> {
    const p = this.norm(path);
    const prefix = p === "/" ? "/" : p + "/";
    const names = new Set<string>();
    for (const key of this.entries.keys()) {
      if (key === p) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }

  async mkdir(path: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = this.norm(path);
    if (opts?.recursive) {
      const parts = p.split("/").filter(Boolean);
      let cur = "";
      for (const part of parts) {
        cur = cur + "/" + part;
        if (!this.entries.has(cur)) {
          this.entries.set(cur, { kind: "dir", mode: 0o040755 });
        }
      }
      return;
    }
    this.ensureParent(p);
    this.entries.set(p, { kind: "dir", mode: 0o040755 });
  }

  async rmdir(path: string): Promise<void> {
    this.entries.delete(this.norm(path));
  }

  async stat(path: string): Promise<MemStats> {
    const p = this.norm(path);
    const e = this.entries.get(p);
    if (!e) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    const size = e.kind === "file" ? e.data.byteLength : 0;
    return new MemStats(e, size);
  }

  async lstat(path: string): Promise<MemStats> {
    return this.stat(path);
  }

  async readlink(_path: string): Promise<string> {
    throw Object.assign(new Error("ENOSYS: symlinks not supported"), { code: "ENOSYS" });
  }

  async symlink(_target: string, _path: string): Promise<void> {
    throw Object.assign(new Error("ENOSYS: symlinks not supported"), { code: "ENOSYS" });
  }

  async chmod(path: string, mode: number): Promise<void> {
    const e = this.entries.get(this.norm(path));
    if (!e) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    e.mode = mode;
  }
}

export class MemFs {
  promises: MemFsPromises;
  constructor() {
    const entries = new Map<string, Entry>();
    entries.set("/", { kind: "dir", mode: 0o040755 });
    this.promises = new MemFsPromises(entries);
  }
}
