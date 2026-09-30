/**
 * A write must not erase an edit that is on disk but not yet in the index.
 *
 * The watcher debounces 300ms, and every route that edits a note builds its new
 * text from the index. An Obsidian save followed inside that window by any
 * Basalt write — here a checkbox toggle — used to be overwritten with the stale
 * text plus the toggle, and our own write then matched the watcher's pending
 * event, so nothing ever re-read the file. The edit was gone from disk, from the
 * index and from history.
 *
 * Each test asserts, right before the write, that the index still does NOT hold
 * the disk edit. Without that check a slow run could let the watcher win the
 * race and the test would pass without exercising anything.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-drift-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { hash } = await import("../src/vaultStore.js");

const VAULT = process.env.BASALT_VAULT_DIR;
let app: Awaited<ReturnType<typeof buildServer>>["app"];
let store: Awaited<ReturnType<typeof buildServer>>["store"];
let token = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};

/** Create a note through the API and let our own watcher echo settle. */
const create = async (rel: string, content: string) => {
  const r = await api("PUT", "/api/vault/note", { path: rel, content });
  expect(r.status).toBe(200);
  await sleep(700);
  return { id: r.json.id as string, abs: path.join(VAULT, rel) };
};

/** What Obsidian does: rewrite the whole file, behind the index's back. */
const obsidianSave = (abs: string, next: (s: string) => string) => fs.writeFileSync(abs, next(fs.readFileSync(abs, "utf8")));

beforeAll(async () => {
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  store = built.store;
  const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } });
  expect(r.statusCode).toBe(200);
  token = r.json().token;
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("a write while the disk is ahead of the index", () => {
  it("keeps an Obsidian edit made just before a checkbox toggle", async () => {
    const { id, abs } = await create("Engineering/Drift Toggle.md", "- [ ] task one\n");
    obsidianSave(abs, (s) => s + "OBSIDIAN-EDIT\n");
    expect(store.index.get(id)!.content).not.toContain("OBSIDIAN-EDIT"); // inside the window

    const line = store.index.get(id)!.tasks[0]!.line;
    expect((await api("POST", "/api/tasks/check", { noteId: id, line, checked: true })).status).toBe(200);

    const disk = fs.readFileSync(abs, "utf8");
    expect(disk).toContain("- [x] task one\nOBSIDIAN-EDIT\n");
    expect(store.index.get(id)!.content).toBe(disk);

    // The watcher's pending event must not undo anything when it fires.
    await sleep(900);
    expect(fs.readFileSync(abs, "utf8")).toBe(disk);
  });

  it("keeps an Obsidian edit when the editor saves from the hash it was given", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const { id, abs } = await create("Engineering/Drift Editor.md", lines);
    const opened = store.index.get(id)!.content; // what the editor loaded

    obsidianSave(abs, (s) => s.replace("line 30\n", "line 30 from Obsidian\n"));
    expect(store.index.get(id)!.content).toBe(opened); // inside the window

    const typed = opened.replace("line 5\n", "line 5 typed in Basalt\n");
    const r = await api("PUT", "/api/vault/note", { path: "Engineering/Drift Editor.md", content: typed, baseHash: hash(opened) });
    expect(r.status).toBe(200);

    const disk = fs.readFileSync(abs, "utf8");
    expect(disk).toContain("line 5 typed in Basalt\n");
    expect(disk).toContain("line 30 from Obsidian\n");
  });

  it("records the disk edit as its own revision, as the watcher would", async () => {
    const { id, abs } = await create("Engineering/Drift History.md", "one\n");
    const changed: (string | null)[] = [];
    const onChange = (e: { noteId: string; authorId: string | null }) => e.noteId === id && changed.push(e.authorId);
    store.events.on("note-changed", onChange);

    obsidianSave(abs, (s) => s + "two\n");
    expect(store.index.get(id)!.content).not.toContain("two"); // inside the window
    await api("PUT", "/api/vault/note", { path: "Engineering/Drift History.md", content: store.index.get(id)!.content + "three\n" });
    store.events.off("note-changed", onChange);

    // One event for the outside edit (nobody), one for ours.
    expect(changed).toHaveLength(2);
    expect(changed[0]).toBeNull();
    expect(changed[1]).not.toBeNull();
    const history = (await api("GET", `/api/vault/note/${id}/history?content=1&limit=100`)).json.revisions as { authorId: string | null; content: string }[];
    const outside = history.filter((h) => h.content.includes("two\n") && !h.content.includes("three\n"));
    expect(outside).toHaveLength(1);
    expect(outside[0]!.authorId).toBeNull();
    expect(fs.readFileSync(abs, "utf8")).toMatch(/one\ntwo\nthree\n$/);
  });

  it("leaves a write alone when the disk already matches the index", async () => {
    const { id, abs } = await create("Engineering/Drift None.md", "a\n");
    const changed: string[] = [];
    const onChange = (e: { noteId: string }) => e.noteId === id && changed.push(e.noteId);
    store.events.on("note-changed", onChange);
    await api("PUT", "/api/vault/note", { path: "Engineering/Drift None.md", content: store.index.get(id)!.content + "b\n" });
    store.events.off("note-changed", onChange);
    expect(changed).toHaveLength(1);
    expect(fs.readFileSync(abs, "utf8")).toMatch(/a\nb\n$/);
  });
});
