/**
 * Booting writes nothing into the vault but the documented id stamp (audit
 * AI-013, OPS-009). It used to create `.mcp.json` — a slot for a full-power
 * API token, in the folder Obsidian syncs and backs up, aimed at a hard-coded
 * port — and a `CLAUDE.md`, every boot either was missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-untouched-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";
const vault = process.env.BASALT_VAULT_DIR;
fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
fs.writeFileSync(path.join(vault, "Notes", "a.md"), "# A\n\nSome text.\n");

const { buildServer } = await import("../src/main.js");
afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

/** Every file in the vault, hidden ones included, with its bytes, keyed by its `/` path. */
const snapshot = (dir = vault, out: Record<string, string> = {}) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) snapshot(abs, out);
    else out[path.relative(vault, abs).split(path.sep).join("/")] = fs.readFileSync(abs, "base64");
  }
  return out;
};

describe("booting", () => {
  it("creates no .mcp.json or CLAUDE.md in the vault root", async () => {
    const { app } = await buildServer();
    await app.close();
    expect(fs.existsSync(path.join(vault, ".mcp.json"))).toBe(false);
    expect(fs.existsSync(path.join(vault, "CLAUDE.md"))).toBe(false);
    expect(Object.keys(snapshot()).sort()).toEqual(["Notes/a.md"]);
  });

  it("a vault-root CLAUDE.md stays the user's: byte-identical and out of the index, at boot and when edited while running", async () => {
    // The watcher's half is the one Windows broke: chokidar spells the path
    // C:/…/CLAUDE.md there, and a string compare let it be indexed and
    // id-stamped (OPS-003). windows.yml runs this file on Windows.
    const guide = path.join(vault, "CLAUDE.md");
    fs.writeFileSync(guide, "# How I work\n\nShort answers.\n");
    const { app, store } = await buildServer();
    try {
      expect(store.index.getByPath("CLAUDE.md")).toBeUndefined();
      fs.writeFileSync(guide, "# How I work\n\nShort answers. Dates as words.\n");
      // A note written beside it is the watcher's proof of life: once that is
      // indexed, the guide's own event has been seen and settled too.
      fs.writeFileSync(path.join(vault, "Notes", "b.md"), "# B\n");
      for (let i = 0; i < 200 && !store.index.getByPath("Notes/b.md"); i++) await new Promise((r) => setTimeout(r, 50));
      expect(store.index.getByPath("Notes/b.md")).toBeDefined();
      await new Promise((r) => setTimeout(r, 400));
      expect(store.index.getByPath("CLAUDE.md")).toBeUndefined();
      expect(fs.readFileSync(guide, "utf8")).toBe("# How I work\n\nShort answers. Dates as words.\n");
    } finally {
      await app.close();
      fs.rmSync(guide);
      fs.rmSync(path.join(vault, "Notes", "b.md"));
    }
  });

  it("leaves an already-indexed vault byte-identical", async () => {
    const before = snapshot();
    const { app } = await buildServer();
    await app.close();
    expect(snapshot()).toEqual(before);
  });
});
