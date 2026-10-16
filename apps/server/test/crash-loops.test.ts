/**
 * Nothing a user can do to the vault may stop the server booting.
 *
 * The server runs under launchd with KeepAlive, so a throw out of boot is not
 * an error page: the agent restarts, meets the same state, and throws again —
 * the whole app is down until someone edits SQLite by hand. Each test here
 * reaches a state that used to do that, then boots a fresh server on the same
 * data and asserts it comes up with the right notes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POSIX_MODES } from "./helpers/platform.js";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-boot-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

const VAULT = process.env.ORRAMA_VAULT_DIR;
type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({
    method: method as "GET",
    url,
    headers: signedIn(token),
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};

/** Stop this server and boot a new one on the same data — what launchd does. */
const reboot = async () => {
  await built.app.close();
  built = await buildServer();
};

const idAt = (rel: string) => /^id: (n-\S+)$/m.exec(fs.readFileSync(path.join(VAULT, rel), "utf8"))?.[1];
const inTree = async (rel: string) => ((await api("GET", "/api/vault/tree")).json as { path: string }[]).some((n) => n.path === rel);

beforeAll(async () => {
  await import("../src/seed.js");
  built = await buildServer();
  const r = await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } });
  token = sessionOf(r);
});

afterAll(async () => {
  await built.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("boot survives what the vault can do", () => {
  it("a note deleted in Obsidian and recreated under the same name", async () => {
    const rel = "Engineering/Untitled.md";
    await api("PUT", "/api/vault/note", { path: rel, content: "# first\n" });
    await sleep(700);
    const first = idAt(rel);

    fs.unlinkSync(path.join(VAULT, rel)); // Obsidian: delete
    await sleep(700);
    fs.writeFileSync(path.join(VAULT, rel), "# second, a new note\n"); // Obsidian: new note, same name
    await sleep(900);
    const second = idAt(rel);
    expect(second).toBeDefined();
    expect(second).not.toBe(first); // a genuinely different note at that path

    await reboot();
    expect(await inTree(rel)).toBe(true);
    const row = built.db.select().from(tables.notes).where(eq(tables.notes.path, rel)).get();
    expect(row?.id).toBe(second);
  });

  // The state the live database is actually in: rows the old code left
  // flagged deleted. A different note arriving at one of those paths must
  // not stop the next boot.
  it("a path still held by an old deleted row, under a different id", async () => {
    const rel = "Engineering/Old Name.md";
    built.db.insert(tables.notes).values({ id: "n-ghost000000000", path: rel, title: "Old", contentHash: "x", mtimeMs: 1, deleted: true }).run();
    fs.writeFileSync(path.join(VAULT, rel), "---\nid: n-newnote00000001\n---\n# New\n");

    await reboot();
    expect(await inTree(rel)).toBe(true);
    const rows = built.db.select().from(tables.notes).where(eq(tables.notes.path, rel)).all();
    expect(rows.map((r) => r.id)).toEqual(["n-newnote00000001"]);
  });

  it("moving a note onto one that exists is refused, and both survive", async () => {
    await api("PUT", "/api/vault/note", { path: "Engineering/Keep Me.md", content: "# Keep me\nIMPORTANT\n" });
    await api("PUT", "/api/vault/note", { path: "Engineering/Draft.md", content: "# Draft\nscratch\n" });
    await sleep(700);
    const keep = fs.readFileSync(path.join(VAULT, "Engineering/Keep Me.md"), "utf8");
    const draft = fs.readFileSync(path.join(VAULT, "Engineering/Draft.md"), "utf8");

    const r = await api("POST", "/api/vault/move", { fromPath: "Engineering/Draft.md", toPath: "Engineering/Keep Me.md" });
    expect(r.status).toBe(409);
    expect(fs.readFileSync(path.join(VAULT, "Engineering/Keep Me.md"), "utf8")).toBe(keep);
    expect(fs.readFileSync(path.join(VAULT, "Engineering/Draft.md"), "utf8")).toBe(draft);

    await reboot();
    expect(await inTree("Engineering/Keep Me.md")).toBe(true);
    expect(await inTree("Engineering/Draft.md")).toBe(true);
  });

  it("moving onto a file that exists on disk but is not indexed yet is refused too", async () => {
    await api("PUT", "/api/vault/note", { path: "Engineering/Mover.md", content: "# Mover\n" });
    fs.writeFileSync(path.join(VAULT, "Engineering/Just Saved.md"), "# written by Obsidian a moment ago\n");
    const r = await api("POST", "/api/vault/move", { fromPath: "Engineering/Mover.md", toPath: "Engineering/Just Saved.md" });
    expect(r.status).toBe(409);
    expect(fs.readFileSync(path.join(VAULT, "Engineering/Just Saved.md"), "utf8")).toContain("written by Obsidian");
    await sleep(700);
  });

  it("an ordinary rename still works", async () => {
    await api("PUT", "/api/vault/note", { path: "Engineering/Before.md", content: "# Before\n" });
    const r = await api("POST", "/api/vault/move", { fromPath: "Engineering/Before.md", toPath: "Engineering/After.md" });
    expect(r.status).toBe(200);
    expect(fs.existsSync(path.join(VAULT, "Engineering/After.md"))).toBe(true);
    await sleep(700);
  });

  // chmod 000 locks nothing out as root, or on Windows (POSIX modes).
  it.skipIf(process.getuid?.() === 0 || !POSIX_MODES)("a folder the server cannot read costs that folder, not the boot", async () => {
    const dir = path.join(VAULT, "Sealed");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Inside.md"), "---\nid: n-sealed0000000001\n---\n# Inside\n");
    await sleep(700);
    fs.chmodSync(dir, 0o000);
    try {
      await reboot();
      expect(await inTree("Engineering/Keep Me.md")).toBe(true);
      expect(await inTree("Sealed/Inside.md")).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it.skipIf(process.getuid?.() === 0 || !POSIX_MODES)("a file the server cannot read costs that file, not the boot", async () => {
    const rel = "Engineering/Locked.md";
    const abs = path.join(VAULT, rel);
    fs.writeFileSync(abs, "---\nid: n-locked0000000001\n---\n# Locked\n");
    await sleep(700);
    fs.chmodSync(abs, 0o000);
    try {
      await reboot();
      expect(await inTree("Engineering/Keep Me.md")).toBe(true); // everything else is there
      expect(await inTree(rel)).toBe(false);
    } finally {
      fs.chmodSync(abs, 0o644);
    }
  });
});
