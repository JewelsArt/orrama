/**
 * A new note's name must be one every disk holds (OPS-003; Jules, 14 Oct 2026).
 *
 * Uploads refused `" * : < > ? |`, a trailing dot or space and Windows's
 * device names; notes did not. New note, Capture, the agent's write_note, MCP
 * edit_note and moves all take any name, and on Windows a note named
 * `Why now?.md` failed as a 500 while `re: v2.md` wrote into a hidden stream
 * of a file called `re`. Now VaultStore.write and move refuse a new name, or
 * a new folder, Windows cannot hold, on every platform, as Obsidian does.
 * Notes already in the vault under such a name keep reading, saving and
 * moving under it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-note-names-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(VAULT, { recursive: true });
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

/** Whether this volume can hold `?` and `:` in a name at all: APFS and ext4 can, NTFS cannot. */
const HOLDS_WINDOWS_ILLEGAL = (() => {
  const probe = path.join(process.env.ORRAMA_DATA_DIR!, "probe?:.md");
  try {
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
})();

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
let token = "";
const abs = (rel: string) => path.join(VAULT, rel);
/** Every name in the vault, so "wrote nothing" means nothing anywhere. */
const everything = () => (fs.readdirSync(VAULT, { recursive: true }) as string[]).map((p) => p.split(path.sep).join("/")).sort();

const call = async (method: "PUT" | "POST" | "GET", url: string, payload?: Record<string, unknown>) => {
  const res = await b.app.inject({ method, url, headers: signedIn(token), ...(payload ? { payload } : {}) });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const put = (p: string, content: string, create = true) => call("PUT", "/api/vault/note", { path: p, content, create });

beforeAll(async () => {
  b = await buildServer();
  const res = await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } });
  token = sessionOf(res);
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const BAD: [string, RegExp][] = [
  ["Why now?.md", /can't contain/],
  ["re: v2.md", /can't contain/],
  ['Say "hi".md', /can't contain/],
  ["a*b.md", /can't contain/],
  ["x<y>z.md", /can't contain/],
  ["this|that.md", /can't contain/],
  ["NUL.md", /Windows keeps the name "NUL"/],
  ["con.txt.md", /Windows keeps the name "con"/],
  ["COM1.md", /Windows keeps the name "COM1"/],
];

describe("a new note", () => {
  it("is refused under a name Windows cannot hold, with the reason, and nothing is written", async () => {
    for (const [name, why] of BAD) {
      for (const create of [true, false]) {
        const before = everything();
        const res = await put(`Ideas/${name}`, "# x\n", create);
        expect(res.status, `${name} (create: ${create})`).toBe(400);
        expect(res.json.error).toMatch(why);
        expect(res.json.error).toMatch(/note name|Windows keeps/);
        expect(everything()).toEqual(before);
      }
    }
  });

  it("is refused in a new folder Windows cannot hold, and the folder is not made", async () => {
    for (const folder of ["Drafts.", "Drafts ", "Q&A?", "aux"]) {
      const before = everything();
      const res = await put(`${folder}/Idea.md`, "# Idea\n");
      expect(res.status, folder).toBe(400);
      expect(res.json.error).toMatch(/folder name|Windows keeps/);
      expect(everything()).toEqual(before);
    }
  });

  it("takes every name a disk holds", async () => {
    for (const name of ["Console.md", "Rapport – v2.md", "say 'hi' (draft) 100%.md", "Mémoire.md", "nullable.md", "Q&A.md"]) {
      expect((await put(`Ideas/${name}`, "# ok\n")).status, name).toBe(200);
      expect(fs.existsSync(abs(`Ideas/${name}`))).toBe(true);
    }
  });
});

describe("a move", () => {
  it("is refused to a name or a new folder Windows cannot hold, and the note stays", async () => {
    const created = await put("Ideas/Movable.md", "# Movable\n");
    expect(created.status).toBe(200);
    for (const to of ["Ideas/Why now?.md", "Ideas/NUL.md", "Ideas/a<b.md", "Later./Movable.md"]) {
      const before = everything();
      const res = await call("POST", "/api/vault/move", { fromPath: "Ideas/Movable.md", toPath: to });
      expect(res.status, to).toBe(400);
      expect(everything()).toEqual(before);
    }
    expect(fs.existsSync(abs("Ideas/Movable.md"))).toBe(true);
    expect((await call("POST", "/api/vault/move", { fromPath: "Ideas/Movable.md", toPath: "Later/Moved.md" })).status).toBe(200);
  });
});

describe.skipIf(!HOLDS_WINDOWS_ILLEGAL)("a note already in the vault under such a name", () => {
  const OLD = "Ideas/Why now?.md";

  it("still reads, saves and moves under its own name", async () => {
    fs.mkdirSync(abs("Ideas"), { recursive: true });
    fs.writeFileSync(abs(OLD), "# Why now\n\nfirst\n");
    // A save by path: the file is on disk, so this is an edit of it, not a new name.
    const saved = await put(OLD, "# Why now\n\nsecond\n", false);
    expect(saved.status).toBe(200);
    expect(saved.json.path).toBe(OLD);
    expect(fs.readFileSync(abs(OLD), "utf8")).toContain("second");

    const read = await call("GET", `/api/vault/note/${saved.json.id}`);
    expect(read.status).toBe(200);
    expect(read.json.content).toContain("second");

    // A move that keeps its name, into a folder that exists: allowed.
    fs.mkdirSync(abs("Later"), { recursive: true });
    const moved = await call("POST", "/api/vault/move", { fromPath: OLD, toPath: "Later/Why now?.md" });
    expect(moved.status).toBe(200);
    expect(fs.existsSync(abs("Later/Why now?.md"))).toBe(true);

    // A create-only on it is still "taken", not a name problem.
    const again = await put("Later/Why now?.md", "# again\n");
    expect(again.status).toBe(409);
  });

  it("a folder already there under such a name takes new notes", async () => {
    fs.mkdirSync(abs("Q&A?"), { recursive: true });
    const res = await put("Q&A?/Reading list.md", "# Reading list\n");
    expect(res.status).toBe(200);
    expect(fs.existsSync(abs("Q&A?/Reading list.md"))).toBe(true);
  });
});
