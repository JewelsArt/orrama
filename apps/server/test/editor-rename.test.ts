/**
 * A note renamed outside Basalt while it is open in the editor (WEB-005). The editor's NoteSync
 * used to keep the path it opened with and save there forever: rename the note in Obsidian,
 * type a word, and the PUT went to the old path, where the server — finding nothing — made a new
 * file holding the whole buffer. The old name came back with the newest text and the renamed
 * note never got it. This drives the exact NoteSync the web app uses against the real server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NoteSync, type SyncedNote } from "@basalt/sync/client";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-editor-rename-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");

const VAULT = process.env.BASALT_VAULT_DIR;
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let store: Awaited<ReturnType<typeof buildServer>>["store"];
let token = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status and body, so a test can see a 404 as an answer rather than an exception. */
const send = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, body: res.json() };
};
const call = async (method: string, url: string, body?: unknown) => {
  const r = await send(method, url, body);
  if (r.status !== 200) throw Object.assign(new Error(`${method} ${url} → ${r.status}`), { status: r.status });
  return r.body;
};

/**
 * What the watcher does with a change on disk, done now. Under a loaded machine the watcher can
 * take many seconds to report (or, on this Mac with many sessions, not at all), and what is
 * under test is the editor's answer to the index, not chokidar's latency.
 */
const watcherSees = (event: "add" | "unlink", rel: string) =>
  (store as unknown as { handleExternalChange(e: string, rel: string, abs: string): void }).handleExternalChange(event, rel, path.join(VAULT, rel));

/** The editor's sync, as noteSync.ts builds it: saves by path, loads by id. */
const openSync = async (id: string) => {
  const initial = await call("GET", `/api/vault/note/${id}`);
  const moved: string[] = [];
  let gone = 0;
  const sync = new NoteSync(
    initial.path,
    initial as SyncedNote,
    {
      save: (body) => call("PUT", "/api/vault/note", body),
      load: () => call("GET", `/api/vault/note/${id}`),
    },
    { moved: (p) => moved.push(p), gone: () => gone++ },
    60_000, // the test flushes; the debounce never fires on its own
  );
  return { sync, moved, gone: () => gone, initial };
};

beforeAll(async () => {
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  store = built.store;
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } });
  token = r.json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("a note renamed outside Basalt while open (WEB-005)", () => {
  it("the next save lands in the renamed file, and the old name does not come back", async () => {
    const created = await call("PUT", "/api/vault/note", { path: "Engineering/Draft.md", content: "# Draft\n\nfirst line\n" });
    await sleep(700);
    const { sync, moved } = await openSync(created.id);

    // Obsidian renames it. The live-sync event makes the editor refresh.
    fs.renameSync(path.join(VAULT, "Engineering/Draft.md"), path.join(VAULT, "Engineering/Thesis outline.md"));
    watcherSees("unlink", "Engineering/Draft.md");
    watcherSees("add", "Engineering/Thesis outline.md");
    expect((await call("GET", `/api/vault/note/${created.id}`)).path).toBe("Engineering/Thesis outline.md");
    await sync.refresh();
    expect(moved).toEqual(["Engineering/Thesis outline.md"]);

    sync.edit(sync.content + "typed after the rename\n");
    await sync.flush();
    expect(sync.dirty).toBe(false);
    await sleep(700);

    expect(fs.readFileSync(path.join(VAULT, "Engineering/Thesis outline.md"), "utf8")).toContain("typed after the rename");
    expect(fs.existsSync(path.join(VAULT, "Engineering/Draft.md"))).toBe(false);
    sync.close();
  }, 30_000);

  it("a note deleted while open is not recreated by the next save; the typing stays in the editor", async () => {
    const created = await call("PUT", "/api/vault/note", { path: "Engineering/Scratch.md", content: "# Scratch\n" });
    await sleep(700);
    const { sync, gone } = await openSync(created.id);
    sync.edit(sync.content + "half a thought\n");

    fs.rmSync(path.join(VAULT, "Engineering/Scratch.md"));
    watcherSees("unlink", "Engineering/Scratch.md");
    expect((await send("GET", `/api/vault/note/${created.id}`)).status).toBe(404);
    await sync.refresh();
    expect(gone()).toBe(1);

    await sync.flush();
    await sleep(700);
    expect(fs.existsSync(path.join(VAULT, "Engineering/Scratch.md"))).toBe(false);
    expect(sync.content).toContain("half a thought");
    sync.close();
  }, 30_000);
});
