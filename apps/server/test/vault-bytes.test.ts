/**
 * Never rewrite what was not parsed (audit root cause #3, session S01). Each
 * test here checks the BYTES a vault file holds after Orrama has touched it —
 * a save, a boot, a watcher ingest — against what the user wrote.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-vault-bytes-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

const VAULT = process.env.ORRAMA_VAULT_DIR;
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
  token = (await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
};

const restart = async () => {
  await built.app.close();
  await boot();
};
const idAt = (rel: string) => built.store.index.getByPath(rel)?.id;
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await sleep(50);
};

/** Files that are on disk before the first boot — what first index meets. */
const AT_BOOT: Record<string, Buffer> = {
  // STO-002: valid YAML that is not a mapping.
  "Import/Rules.md": Buffer.from("---\nMeeting notes from Monday\n---\nMore text below.\n"),
  "Import/List.md": Buffer.from("---\n- first idea\n- second idea\n---\nBody\n"),
  // STO-003: front matter that does not parse, with a promoted task; a numeric id.
  "Import/Q3 Review.md": Buffer.from("---\ntitle: Q3 Review: Ops\ntags: [work]\n---\n# Q3\n\n- [ ] send the deck ^t-deck01\n"),
  "Import/Zettel.md": Buffer.from("---\nid: 202310021230\ntitle: Zettel\n---\n# Zettel\n"),
  // STO-011: not UTF-8. "Réunion du 3 février — éléments à préparer" in Windows-1252, and UTF-16LE with a BOM.
  "Import/Old 1252.md": Buffer.from("# R\xe9union du 3 f\xe9vrier\n\n\xc9l\xe9ments \xe0 pr\xe9parer : caf\xe9.\n", "latin1"),
  "Import/Notepad.md": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# Notes \u00e9t\u00e9\r\n\u00e0 faire\r\n", "utf16le")]),
  // STO-005 / STO-007: CRLF, untouched YAML, a BOM.
  "Import/Windows.md": Buffer.from("---\r\ntitle: Hello\r\nstatus: active\r\ntags: [a, b]\r\n---\r\nBody\r\n"),
  "Import/Long.md": Buffer.from("---\ntitle: Long\ndescription: This is a very long single-line description that goes well past eighty characters in width for sure\ntags: [ a,b ]\naliases:\n- x\n---\nBody\n"),
  "Import/Bom.md": Buffer.from("\uFEFF# Title\nBody\n"),
};
/** What a stamp may do: one `id:` line right after the opening fence. */
const withIdLine = (before: string, id: string, eol = "\n") => {
  const nl = before.indexOf("\n") + 1;
  return before.slice(0, nl) + `id: ${id}${eol}` + before.slice(nl);
};

const warnings: string[] = [];
beforeAll(async () => {
  for (const [rel, b] of Object.entries(AT_BOOT)) {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), b);
  }
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
  await boot();
});
afterAll(async () => {
  await built.app.close();
  vi.restoreAllMocks();
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

describe("a --- block that is not a mapping is never replaced by an id (STO-002)", () => {
  it("is unchanged on disk after first index, and still indexed", () => {
    for (const rel of ["Import/Rules.md", "Import/List.md"]) {
      expect(bytes(rel).equals(AT_BOOT[rel]!)).toBe(true);
      expect(idAt(rel)).toMatch(/^n-/);
    }
  });

  it("is unchanged after a watcher ingest and after a save through the API", async () => {
    const rel = "Import/Rules dropped.md";
    const text = "---\n# Agenda\nDiscuss the budget and the hire\n---\nBody\n";
    fs.writeFileSync(abs(rel), text);
    await until(() => !!idAt(rel));
    await sleep(400);
    expect(bytes(rel).toString("utf8")).toBe(text);
    const put = await api("PUT", "/api/vault/note", { path: "Import/Rules put.md", content: text });
    expect(put.status).toBe(200);
    expect(bytes("Import/Rules put.md").toString("utf8")).toBe(text);
  });
});

describe("a note that cannot be stamped keeps one id (STO-003)", () => {
  const rel = "Import/Q3 Review.md";

  it("across an Orrama write, an Obsidian save and a restart, with its task's comment and description", async () => {
    const id = idAt(rel)!;
    expect(bytes(rel).equals(AT_BOOT[rel]!)).toBe(true);
    const obj = built.store.ensureTaskObject(id, "t-deck01");
    const me = (await api("GET", "/api/me")).json.id as string;
    built.db.insert(tables.taskComments).values({ id: "c-q3", taskId: obj.id, authorId: me, body: "ask Marc first", createdAt: Date.now() }).run();
    built.db.update(tables.taskObjects).set({ description: "the long description" }).where(eq(tables.taskObjects.id, obj.id)).run();

    // 1. An Orrama write (a checkbox ticked from the Dashboard).
    const line = fs.readFileSync(abs(rel), "utf8").split("\n").findIndex((l) => l.includes("^t-deck01"));
    const text = fs.readFileSync(abs(rel), "utf8").split("\n")[line]!;
    expect((await api("POST", "/api/tasks/check", { noteId: id, line, text, checked: true })).status).toBe(200);
    expect(idAt(rel)).toBe(id);
    expect((await api("GET", `/api/vault/note/${id}`)).status).toBe(200);
    await sleep(500);

    // 2. An Obsidian save.
    fs.appendFileSync(abs(rel), "more text\n");
    await until(() => built.store.index.getByPath(rel)!.content.includes("more text"));
    expect(idAt(rel)).toBe(id);

    // 3. A restart.
    await restart();
    expect(idAt(rel)).toBe(id);
    const after = built.store.taskObjectByBlock(id, "t-deck01");
    expect(after?.id).toBe(obj.id);
    expect(after?.description).toBe("the long description");
    expect(after?.status).toBe("done");
    expect(built.db.select().from(tables.taskComments).where(eq(tables.taskComments.taskId, obj.id)).all()).toHaveLength(1);
    // Still the user's YAML, unquoted colon and all.
    expect(fs.readFileSync(abs(rel), "utf8").startsWith("---\ntitle: Q3 Review: Ops\n")).toBe(true);
  });

  it("an autosave of half-typed YAML does not change the note's id", async () => {
    const made = await api("PUT", "/api/vault/note", { path: "Notes/Typing.md", content: "---\ntitle: Typing\n---\n# Typing\n" });
    await sleep(500);
    const cur = (await api("GET", `/api/vault/note/${made.json.id}`)).json;
    const midTyping = cur.content.replace("title: Typing", "title: Typing\ntags: [work, ");
    const w = await api("PUT", "/api/vault/note", { path: "Notes/Typing.md", content: midTyping, baseHash: cur.hash, baseContent: cur.content });
    expect(w.status).toBe(200);
    expect(w.json.id).toBe(made.json.id);
    expect(bytes("Notes/Typing.md").toString("utf8")).toBe(midTyping);
    expect((await api("GET", `/api/vault/note/${made.json.id}`)).status).toBe(200);
  });

  it("a numeric id: is left as the user wrote it, and the note keeps an Orrama id across boots", async () => {
    const rel2 = "Import/Zettel.md";
    const id = idAt(rel2);
    expect(id).toMatch(/^n-/);
    await restart();
    expect(idAt(rel2)).toBe(id);
    expect(bytes(rel2).equals(AT_BOOT[rel2]!)).toBe(true);
  });

  it("a note whose id: line was removed gets its id back", async () => {
    const made = await api("PUT", "/api/vault/note", { path: "Notes/Lost id.md", content: "# Lost\n" });
    await sleep(500);
    fs.writeFileSync(abs("Notes/Lost id.md"), "---\ntitle: Lost\n---\n# Lost\n");
    await until(() => built.store.index.getByPath("Notes/Lost id.md")!.content.includes("title: Lost"));
    expect(idAt("Notes/Lost id.md")).toBe(made.json.id);
    expect(fs.readFileSync(abs("Notes/Lost id.md"), "utf8")).toBe(`---\nid: ${made.json.id}\ntitle: Lost\n---\n# Lost\n`);
  });
});

describe("notes that are not UTF-8 are read, never written (STO-011)", () => {
  it("first index leaves a Windows-1252 and a UTF-16LE note byte-identical, and says why", () => {
    for (const rel of ["Import/Old 1252.md", "Import/Notepad.md"]) {
      expect(bytes(rel).equals(AT_BOOT[rel]!)).toBe(true);
      expect(idAt(rel)).toMatch(/^n-/); // still searchable and linkable
      expect(warnings.some((w) => w.includes(rel) && w.includes("not UTF-8"))).toBe(true);
    }
  });

  it("a watcher ingest leaves one byte-identical too", async () => {
    const rel = "Import/Dropped 1252.md";
    const b = Buffer.from("Caf\xe9 cr\xe8me\n", "latin1");
    fs.writeFileSync(abs(rel), b);
    await until(() => !!idAt(rel));
    await sleep(400);
    expect(bytes(rel).equals(b)).toBe(true);
  });

  it("a save over one is refused, and the file is untouched", async () => {
    const rel = "Import/Old 1252.md";
    const id = idAt(rel)!;
    const opened = (await api("GET", `/api/vault/note/${id}`)).json;
    const r = await api("PUT", "/api/vault/note", { path: rel, content: opened.content + "more\n", baseHash: opened.hash, baseContent: opened.content });
    expect(r.status).toBe(409);
    expect(r.json.message ?? r.json.error).toMatch(/UTF-8/);
    expect(bytes(rel).equals(AT_BOOT[rel]!)).toBe(true);
  });

  it("a UTF-8 note with a BOM is stamped normally, the BOM kept at byte 0", () => {
    const text = bytes("Import/Bom.md").toString("utf8");
    expect(text).toBe(`\uFEFF---\nid: ${idAt("Import/Bom.md")}\n---\n# Title\nBody\n`);
  });
});

describe("a stamp changes one line (STO-005, STO-007)", () => {
  it("a CRLF note stays CRLF, with nothing escaped", () => {
    const before = AT_BOOT["Import/Windows.md"]!.toString("utf8");
    expect(bytes("Import/Windows.md").toString("utf8")).toBe(withIdLine(before, idAt("Import/Windows.md")!, "\r\n"));
    // and its last-line flow list is read, not called malformed
    expect(built.store.index.getByPath("Import/Windows.md")!.tags.map((t) => t.tag)).toEqual(["a", "b"]);
  });

  it("long values, flow spacing and flush lists are not reformatted", () => {
    const before = AT_BOOT["Import/Long.md"]!.toString("utf8");
    expect(bytes("Import/Long.md").toString("utf8")).toBe(withIdLine(before, idAt("Import/Long.md")!));
  });
});

describe("merging at a last line with no newline (STO-004)", () => {
  it("a quick capture racing an Obsidian edit of the last line keeps both on their own lines", async () => {
    const rel = "Personal/jules/Inbox.md";
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), "---\ntitle: Inbox\n---\n# Inbox\n- [ ] milk"); // Obsidian writes no final newline
    await until(() => !!idAt(rel));
    await sleep(500);
    const before = fs.readFileSync(abs(rel), "utf8");
    // Obsidian saves, and the capture lands inside the watcher's debounce.
    fs.writeFileSync(abs(rel), before.replace("- [ ] milk", "- [ ] oat milk"));
    expect((await api("POST", "/api/capture", { text: "pay rent" })).status).toBe(200);
    const lines = fs.readFileSync(abs(rel), "utf8").split("\n");
    expect(lines).toContain("- [ ] oat milk");
    expect(lines.some((l) => /^- \[ \] pay rent/.test(l))).toBe(true);
    expect(lines.filter((l) => l.includes("milk"))).toEqual(["- [ ] oat milk"]);
  });
});
