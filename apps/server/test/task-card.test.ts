/**
 * Stage 1, 1B: a step is changed from its card (`GET /api/tasks/card`, `POST /api/tasks/edit`,
 * `/move`, `/delete`). Every change is the line a person would have typed, every other byte of
 * the note kept; a step that moved since the card opened is a 409; a move can't lose the line,
 * even cut short between its two writes; and a promoted step's object and booked time follow
 * it to its new note, through a rebuild too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-task-card-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables, createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
const vault = process.env.ORRAMA_VAULT_DIR!;
const dbFile = path.join(process.env.ORRAMA_DATA_DIR!, "basalt.db");
let built: Built;
let token = "";

const api = async (method: string, url: string, body?: unknown) => {
  const res = await built.app.inject({ method: method as "GET", url, headers: signedIn(token), ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}) });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};
const boot = async () => {
  built = await buildServer();
  token = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
};
const put = async (rel: string, content: string) => {
  const r = await api("PUT", "/api/vault/note", { path: rel, content });
  expect(r.status).toBe(200);
  return r.json.id as string;
};
const file = (rel: string) => fs.readFileSync(path.join(vault, rel), "utf8");
const tags = (slug: string) => `---\ntitle: ${slug[0]!.toUpperCase()}${slug.slice(1)}\ntags: [project/${slug}]\n---\n`;
/** A project note of its own (writing it registers the project), so its place is a file this test knows. */
async function project(slug: string, body: string) {
  return put(`04-Projects/${slug}.md`, `${tags(slug)}${body}`);
}
const stepOf = (noteId: string, text: string) => {
  const t = built.store.index.get(noteId)!.tasks.find((x) => x.text === text);
  if (!t) throw new Error(`no step "${text}"`);
  return t;
};
const refOf = (noteId: string, text: string) => {
  const t = stepOf(noteId, text);
  return { noteId, line: t.line, text: t.text, ...(t.blockId ? { blockId: t.blockId } : {}) };
};

beforeAll(boot);
afterAll(async () => {
  await built.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the card reads a step", () => {
  it("with its words, its section, its project and every place it can go", async () => {
    const id = await project("garden", "# Garden\n\n## Spring\n- [/] Sow **tomatoes** !p2 due:2026-04-01 #deadline\n\n## Prompt\nBe brief.\n");
    await project("kitchen", "# Kitchen\n\n## Paint\n- [ ] Buy paint\n");
    const r = await api("GET", `/api/tasks/card?noteId=${id}&text=${encodeURIComponent("Sow tomatoes")}`);
    expect(r.status).toBe(200);
    expect(r.json.task).toMatchObject({ words: "Sow **tomatoes**", status: "in-progress", due: "2026-04-01", priority: 2, key: true, notePath: "04-Projects/garden.md" });
    expect(r.json.section).toBe("Spring");
    expect(r.json.project).toEqual({ slug: "garden", name: "Garden" });
    expect(r.json.canEdit).toBe(true);
    const places = Object.fromEntries((r.json.places as { slug: string; sections: string[] }[]).map((p) => [p.slug, p.sections]));
    expect(places["garden"]).toEqual(["Spring", "Tasks"]); // the workspace's own slots are no place for a step
    expect(places["kitchen"]).toEqual(["Paint", "Tasks"]);
    expect(r.json.inInbox).toBe(false);
  });

  it("answers 409 for a step that is gone, 400 for a line alone", async () => {
    const id = await put("Notes/card-gone.md", "- [ ] here\n");
    expect((await api("GET", `/api/tasks/card?noteId=${id}&text=never`)).status).toBe(409);
    expect((await api("GET", `/api/tasks/card?noteId=${id}&line=0`)).status).toBe(400);
  });
});

describe("each change is the line a person would type, nothing else", () => {
  const BEFORE = "# Plan\r\n\r\nIntro with - [ ] in prose.\r\n```\r\n- [ ] Write intro !p1\r\n```\r\n- [ ] Write intro !p1 due:2026-10-30 ^t-aaa111\r\n- [ ] Other step\r\n";
  const edit = async (id: string, change: object) => {
    const r = await api("POST", "/api/tasks/edit", { noteId: id, blockId: "t-aaa111", ...change });
    expect(r.status).toBe(200);
    return r.json;
  };
  it.each([
    [{ words: "Write the intro" }, "- [ ] Write the intro !p1 due:2026-10-30 ^t-aaa111"],
    [{ due: "2026-11-02" }, "- [ ] Write intro !p1 due:2026-11-02 ^t-aaa111"],
    [{ due: null }, "- [ ] Write intro !p1 ^t-aaa111"],
    [{ start: "2026-10-26" }, "- [ ] Write intro !p1 due:2026-10-30 start:2026-10-26 ^t-aaa111"],
    [{ priority: 3 }, "- [ ] Write intro !p3 due:2026-10-30 ^t-aaa111"],
    [{ priority: null }, "- [ ] Write intro due:2026-10-30 ^t-aaa111"],
    [{ key: true }, "- [ ] Write intro !p1 due:2026-10-30 #deadline ^t-aaa111"],
    [{ status: "blocked" }, "- [b] Write intro !p1 due:2026-10-30 ^t-aaa111"],
    [{ status: "done" }, "- [x] Write intro !p1 due:2026-10-30 ^t-aaa111"],
  ])("%j", async (change, line) => {
    const rel = `Notes/edit-${Object.keys(change)[0]}-${JSON.stringify(Object.values(change)[0])}.md`.replace(/"/g, "");
    const id = await put(rel, BEFORE);
    const before = file(rel);
    const card = await edit(id, change);
    // The fenced copy and every other line keep their bytes; the note stays CRLF.
    expect(file(rel)).toBe(before.replace("- [ ] Write intro !p1 due:2026-10-30 ^t-aaa111", line));
    expect(card.task.raw).toBe(line);
  });

  it("refuses a step that moved since the card opened (409), and changes nothing", async () => {
    const id = await put("Notes/edit-409.md", "- [ ] Call the bank\n- [ ] Pay rent\n");
    const ref = refOf(id, "Call the bank");
    await put("Notes/edit-409.md", "- [ ] Pay rent\n- [ ] Call the bank about the loan\n"); // edited elsewhere
    const before = file("Notes/edit-409.md");
    expect((await api("POST", "/api/tasks/edit", { ...ref, due: "2026-11-01" })).status).toBe(409);
    expect((await api("POST", "/api/tasks/edit", { noteId: id, blockId: "t-nope00", due: "2026-11-01" })).status).toBe(409);
    expect(file("Notes/edit-409.md")).toBe(before);
  });

  it("refuses a day that does not exist and words that are no step", async () => {
    const id = await put("Notes/edit-400.md", "- [ ] Thing\n");
    expect((await api("POST", "/api/tasks/edit", { noteId: id, text: "Thing", due: "2026-02-30" })).status).toBe(400);
    expect((await api("POST", "/api/tasks/edit", { noteId: id, text: "Thing", words: "  " })).status).toBe(400);
    expect((await api("POST", "/api/tasks/edit", { noteId: id, text: "Thing", words: "two\nlines" })).status).toBe(400);
    expect(file("Notes/edit-400.md")).toContain("- [ ] Thing\n");
  });
});

describe("delete", () => {
  it("takes the line out and nothing else; a second delete is a 409", async () => {
    const id = await put("Notes/del.md", "intro\n- [ ] Keep me\n- [ ] Drop me due:2026-10-01\n- [ ] Keep me too\n");
    const before = file("Notes/del.md");
    const ref = refOf(id, "Drop me");
    expect((await api("POST", "/api/tasks/delete", ref)).status).toBe(200);
    expect(file("Notes/del.md")).toBe(before.replace("- [ ] Drop me due:2026-10-01\n", ""));
    expect((await api("POST", "/api/tasks/delete", ref)).status).toBe(409);
  });
});

describe("move", () => {
  it("to another project's section: out of one note, last under the section in the other", async () => {
    const src = await project("bikes", "# Bikes\n\n## Repair\n- [ ] Fix the chain due:2026-10-29 !p2\n- [ ] Pump tyres\n");
    const dst = await project("boats", "# Boats\n\n## Hull\n- [ ] Sand it\n\n## Sails\n- [ ] Stitch\n");
    const srcBefore = file("04-Projects/bikes.md");
    const r = await api("POST", "/api/tasks/move", { ...refOf(src, "Fix the chain"), to: { project: "boats", section: "Hull" } });
    expect(r.status).toBe(200);
    expect(file("04-Projects/bikes.md")).toBe(srcBefore.replace("- [ ] Fix the chain due:2026-10-29 !p2\n", ""));
    expect(file("04-Projects/boats.md")).toContain("## Hull\n- [ ] Sand it\n- [ ] Fix the chain due:2026-10-29 !p2\n\n## Sails\n");
    expect(r.json.task.noteId).toBe(dst);
    expect(r.json.section).toBe("Hull");
  });

  it("to another section of its own note, in one write", async () => {
    const id = await project("house", "# House\n\n## Now\n- [/] Paint the door\n- [ ] Oil hinges\n\n## Later\n- [ ] Roof\n");
    const writes = vi.spyOn(built.store, "write");
    const r = await api("POST", "/api/tasks/move", { ...refOf(id, "Paint the door"), to: { project: "house", section: "Later" } });
    expect(r.status).toBe(200);
    expect(writes).toHaveBeenCalledTimes(1);
    writes.mockRestore();
    expect(file("04-Projects/house.md")).toContain("## Now\n- [ ] Oil hinges\n\n## Later\n- [ ] Roof\n- [/] Paint the door\n");
  });

  it("to your inbox, made the way capture makes it", async () => {
    const id = await put("Notes/to-inbox.md", "- [ ] Someday maybe\n");
    const r = await api("POST", "/api/tasks/move", { ...refOf(id, "Someday maybe"), to: { inbox: true } });
    expect(r.status).toBe(200);
    expect(file("Personal/jules/Inbox.md")).toMatch(/# Inbox\n- \[ \] Someday maybe\n$/);
    expect(file("Notes/to-inbox.md")).not.toContain("Someday");
    expect(r.json.inInbox).toBe(true);
  });

  it("refuses the project's own slots and a project you can't see", async () => {
    const id = await put("Notes/slots.md", "- [ ] Nowhere\n");
    const before = file("Notes/slots.md");
    expect((await api("POST", "/api/tasks/move", { ...refOf(id, "Nowhere"), to: { project: "boats", section: "Decisions" } })).status).toBe(400);
    expect((await api("POST", "/api/tasks/move", { ...refOf(id, "Nowhere"), to: { project: "no-such-project" } })).status).toBe(404);
    expect(file("Notes/slots.md")).toBe(before);
  });

  it("cut short between its two writes, the line is in both notes, never in neither; run again, it ends where it was sent", async () => {
    const src = await project("plain", "# Plain\n\n## Steps\n- [ ] Unpromoted one\n- [ ] Promoted one ^t-cut001\n");
    await project("target", "# Target\n");
    const realWrite = built.store.write.bind(built.store);
    const kill = vi.spyOn(built.store, "write").mockImplementation((user, rel, ...rest) => {
      if (rel === "04-Projects/plain.md") throw new Error("killed between the two writes");
      return realWrite(user, rel, ...rest);
    });
    for (const text of ["Unpromoted one", "Promoted one"]) {
      expect((await api("POST", "/api/tasks/move", { ...refOf(src, text), to: { project: "target" } })).status).toBe(500);
      expect(file("04-Projects/plain.md")).toContain(`- [ ] ${text}`);
      expect(file("04-Projects/target.md")).toContain(`- [ ] ${text}`);
    }
    kill.mockRestore();
    // Run again: the promoted step finds itself there already and only leaves the source.
    expect((await api("POST", "/api/tasks/move", { ...refOf(src, "Promoted one"), to: { project: "target" } })).status).toBe(200);
    expect(file("04-Projects/plain.md")).not.toContain("Promoted one");
    expect(file("04-Projects/target.md").match(/Promoted one/g)).toHaveLength(1);
  });

  it("a promoted step keeps its id, its object and its booked time, through a rebuild too", async () => {
    const src = await project("thesis", "# Thesis\n\n## Chapter 3\n- [ ] Draft chapter 3 due:2026-10-30\n");
    const dst = await project("paper", "# Paper\n\n## Writing\n- [ ] Abstract\n");
    const booked = await api("POST", "/api/tasks/blocks", { ...refOf(src, "Draft chapter 3"), date: "2026-10-27", startMin: 540, durationMin: 120 });
    expect(booked.status).toBe(200);
    const { blockId } = stepOf(src, "Draft chapter 3");
    const obj = built.store.taskObjectByBlock(src, blockId!)!;
    const cal = "Personal/jules/Calendar/2026-10.md";
    expect(file(cal)).toContain(`[[04-Projects/thesis#^${blockId}]]`);
    const calBefore = file(cal);

    const r = await api("POST", "/api/tasks/move", { noteId: src, blockId, to: { project: "paper", section: "Writing" } });
    expect(r.status).toBe(200);
    expect(file("04-Projects/paper.md")).toContain(`## Writing\n- [ ] Abstract\n- [ ] Draft chapter 3 due:2026-10-30 ^${blockId}\n`);
    expect(r.json.task.blockId).toBe(blockId);
    // The same object, now on the new note; the block's row names the new note and nothing else changed on it.
    expect(built.store.taskObjectByBlock(dst, blockId!)?.id).toBe(obj.id);
    expect(file(cal)).toBe(calBefore.replace(`[[04-Projects/thesis#^${blockId}]]`, `[[04-Projects/paper#^${blockId}]]`));
    const blocks = () => built.db.select().from(tables.taskBlocks).all().filter((b) => b.taskObjectId === built.store.taskObjectByBlock(dst, blockId!)?.id);
    expect(blocks().map((b) => [b.date, b.startMin, b.durationMin])).toEqual([["2026-10-27", 540, 120]]);

    // Delete the database, re-index: the block is still booked on the step, in its new note.
    await built.app.close();
    wipeIndex();
    await boot();
    expect(built.store.index.get(dst)!.tasks.some((t) => t.blockId === blockId)).toBe(true);
    expect(blocks().map((b) => [b.date, b.startMin, b.durationMin])).toEqual([["2026-10-27", 540, 120]]);
  });
});

/** Drop the index, keep the accounts — the way a real rebuild would (rebuild.test.ts). */
function wipeIndex() {
  const old = new Database(dbFile, { readonly: true });
  const keep = ["users", "teams", "memberships", "folder_grants", "workspace", "projects"].map((t) => ({ t, rows: old.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[] }));
  old.close();
  for (const f of ["basalt.db", "basalt.db-wal", "basalt.db-shm"]) fs.rmSync(path.join(process.env.ORRAMA_DATA_DIR!, f), { force: true });
  closeDb(createDb());
  const fresh = new Database(dbFile);
  for (const { t, rows } of keep) {
    for (const r of rows) {
      const cols = Object.keys(r);
      fresh.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => r[c] as never));
    }
  }
  fresh.close();
}
