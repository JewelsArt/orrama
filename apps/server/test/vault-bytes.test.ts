/**
 * Never rewrite what was not parsed (audit root cause #3, session S01). Each
 * test here checks the BYTES a vault file holds after Basalt has touched it —
 * a save, a boot, a watcher ingest — against what the user wrote.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-vault-bytes-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

const VAULT = process.env.BASALT_VAULT_DIR;
type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
let token = "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const abs = (rel: string) => path.join(VAULT, rel);
const bytes = (rel: string) => fs.readFileSync(abs(rel));

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const boot = async () => {
  built = await buildServer();
  token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@basalt.dev", password: "basalt-demo" } })).json().token;
};

beforeAll(boot);
afterAll(async () => {
  await built.app.close();
});

describe("emoji edits (STO-001)", () => {
  it("a save replacing 🔴 with 🟢 leaves exactly the typed text on disk", async () => {
    const rel = "Notes/Status.md";
    const first = await api("PUT", "/api/vault/note", { path: rel, content: "# Status\n\nThesis: 🔴 blocked on data\n" });
    expect(first.status).toBe(200);
    await sleep(500);
    const opened = (await api("GET", `/api/vault/note/${first.json.id}`)).json;
    const typed = opened.content.replace("🔴", "🟢");
    const saved = await api("PUT", "/api/vault/note", { path: rel, content: typed, baseHash: opened.hash, baseContent: opened.content });
    expect(saved.status).toBe(200);
    expect(saved.json.content).toBe(typed);
    expect(bytes(rel).equals(Buffer.from(typed, "utf8"))).toBe(true);
  });

  it("an Obsidian save swapping 😀 for 😃 is recorded as written, history included", async () => {
    const rel = "Notes/Mood.md";
    const first = await api("PUT", "/api/vault/note", { path: rel, content: "mood 😀 today\n" });
    await sleep(500);
    const before = fs.readFileSync(abs(rel), "utf8");
    fs.writeFileSync(abs(rel), before.replace("😀", "😃"));
    let now = (await api("GET", `/api/vault/note/${first.json.id}`)).json;
    for (let i = 0; i < 100 && now.content === before; i++) {
      await sleep(50); // the watcher's 300ms debounce, and then some on a busy machine
      now = (await api("GET", `/api/vault/note/${first.json.id}`)).json;
    }
    expect(now.content).toBe(before.replace("😀", "😃"));
    const history = (await api("GET", `/api/vault/note/${first.json.id}/history?content=1`)).json;
    const texts: string[] = history.revisions.map((r: { content: string }) => r.content);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.some((t) => t.includes("\uFFFD"))).toBe(false);
  });

  it("a save whose splice does not land as asked writes nothing and answers 500", async () => {
    const rel = "Notes/Backstop.md";
    const first = await api("PUT", "/api/vault/note", { path: rel, content: "abc\n" });
    await sleep(500);
    const before = bytes(rel);
    const opened = (await api("GET", `/api/vault/note/${first.json.id}`)).json;
    // Knock the live doc out of step with its string, as a splice bug would.
    built.store.doc(first.json.id).getText("content").insertEmbed(0, { x: 1 });
    const typed = opened.content.replace("abc", "abXc");
    const saved = await api("PUT", "/api/vault/note", { path: rel, content: typed, baseHash: opened.hash, baseContent: opened.content });
    expect(saved.status).toBe(500);
    expect(bytes(rel).equals(before)).toBe(true);
    // The damaged doc was dropped: the same save goes through on a clean one.
    const again = await api("PUT", "/api/vault/note", { path: rel, content: typed, baseHash: opened.hash, baseContent: opened.content });
    expect(again.status).toBe(200);
    expect(bytes(rel).toString("utf8")).toBe(typed);
  });
});
