/**
 * A note is replaced whole or not at all (atomicWrite.ts). Every vault write
 * used to truncate the note and then write it, so a failure in between left it
 * empty or half-written in the folder Obsidian has open.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canSymlink, POSIX_MODES } from "./helpers/platform.js";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-atomic-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { writeFileAtomic } = await import("../src/atomicWrite.js");
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-atomic-files-"));
const VAULT = process.env.BASALT_VAULT_DIR;
afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});
const leftovers = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeFileAtomic", () => {
  it("a write that fails part-way leaves the old file exactly as it was", () => {
    const f = path.join(scratch, "note.md");
    fs.writeFileSync(f, "# the old note\nevery line of it\n");
    // Fail after the bytes are written, before they are committed — where a
    // crash or a full disk would land.
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => writeFileAtomic(f, "# the new")).toThrow("disk full");
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(f, "utf8")).toBe("# the old note\nevery line of it\n");
    expect(leftovers(scratch)).toEqual([]);
  });

  it("replaces the contents, keeps the file's permissions, leaves no temp file", () => {
    // 0o664 is the one the umask would quietly narrow.
    for (const mode of [0o600, 0o664]) {
      const f = path.join(scratch, `mode-${mode.toString(8)}.md`);
      fs.writeFileSync(f, "old");
      fs.chmodSync(f, mode);
      writeFileAtomic(f, "new");
      expect(fs.readFileSync(f, "utf8")).toBe("new");
      if (POSIX_MODES) expect(fs.statSync(f).mode & 0o777).toBe(mode);
    }
    expect(leftovers(scratch)).toEqual([]);
  });

  it.skipIf(!canSymlink(scratch))("writes a symlinked note at its target, so the link survives (skipped where symlinks need admin: Windows)", () => {
    const real = path.join(scratch, "real.md");
    const link = path.join(scratch, "link.md");
    fs.writeFileSync(real, "old");
    fs.symlinkSync(real, link);
    writeFileAtomic(link, "new");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, "utf8")).toBe("new");
  });
});

describe("the vault is written atomically", () => {
  type Built = Awaited<ReturnType<typeof buildServer>>;
  let built: Built;
  let token = "";
  const put = async (rel: string, content: string) =>
    (await built.app.inject({ method: "PUT", url: "/api/vault/note", headers: { authorization: `Bearer ${token}` }, payload: { path: rel, content } })).statusCode;

  beforeAll(async () => {
    built = await buildServer();
    token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
  });
  afterAll(async () => built.app.close());

  it("a save replaces the note's file instead of truncating it in place", async () => {
    const rel = "Engineering/Atlas Roadmap.md";
    const abs = path.join(VAULT, rel);
    const before = fs.statSync(abs).ino;
    expect(await put(rel, `${built.store.index.getByPath(rel)!.content}\nOne more line.\n`)).toBe(200);
    expect(fs.statSync(abs).ino).not.toBe(before);
    expect(fs.readFileSync(abs, "utf8")).toContain("One more line.");
    expect(leftovers(path.dirname(abs))).toEqual([]);
  });

  it("a burst of saves never drops the note from the index", async () => {
    // Each save is a rename over the note, which the watcher can see as
    // unlink + add; the unlink must not be taken for a deletion.
    const rel = "Engineering/Burst.md";
    for (let i = 0; i < 12; i++) {
      expect(await put(rel, `# burst\n\nsave ${i}\n`)).toBe(200);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, 900));
    const note = built.store.index.getByPath(rel);
    expect(note?.content).toContain("save 11");
    expect(fs.readFileSync(path.join(VAULT, rel), "utf8")).toContain("save 11");
  });

  it("an unlink event for a file that is still there is a change, not a deletion", async () => {
    // Here chokidar reported every rename-over as "change"; editors that save
    // by rename (and other platforms) can report unlink + add, and the two
    // share a debounce, so the unlink may be the event that fires. Driven by
    // hand, so the case is pinned whatever this machine's watcher does.
    const rel = "Engineering/Burst.md";
    const id = built.store.index.getByPath(rel)!.id;
    fs.writeFileSync(path.join(VAULT, rel), fs.readFileSync(path.join(VAULT, rel), "utf8").replace("save 11", "edited elsewhere"));
    (built.store as unknown as { handleExternalChange(e: string, r: string, a: string): void }).handleExternalChange("unlink", rel, path.join(VAULT, rel));
    expect(built.store.index.get(id)?.path).toBe(rel);
    expect(built.store.index.get(id)?.content).toContain("edited elsewhere");
  });
});
