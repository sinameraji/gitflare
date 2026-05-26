import { describe, it, expect } from "vitest";
import { MemFs } from "../src/sync/memfs";

describe("MemFs", () => {
  it("writes and reads a file", async () => {
    const fs = new MemFs();
    await fs.promises.writeFile("/a.txt", "hello");
    const out = (await fs.promises.readFile("/a.txt")) as Uint8Array;
    expect(new TextDecoder().decode(out)).toBe("hello");
  });

  it("mkdir -p", async () => {
    const fs = new MemFs();
    await fs.promises.mkdir("/a/b/c", { recursive: true });
    const st = await fs.promises.stat("/a/b/c");
    expect(st.isDirectory()).toBe(true);
  });

  it("readdir lists immediate children only", async () => {
    const fs = new MemFs();
    await fs.promises.mkdir("/d", { recursive: true });
    await fs.promises.writeFile("/d/a.txt", "x");
    await fs.promises.writeFile("/d/b.txt", "y");
    await fs.promises.mkdir("/d/sub", { recursive: true });
    await fs.promises.writeFile("/d/sub/c.txt", "z");
    const names = (await fs.promises.readdir("/d")).sort();
    expect(names).toEqual(["a.txt", "b.txt", "sub"]);
  });

  it("ENOENT on missing file", async () => {
    const fs = new MemFs();
    await expect(fs.promises.readFile("/missing")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stat returns size for files", async () => {
    const fs = new MemFs();
    await fs.promises.writeFile("/x", "hello");
    const st = await fs.promises.stat("/x");
    expect(st.size).toBe(5);
    expect(st.isFile()).toBe(true);
  });
});
