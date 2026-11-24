/**
 * A note from a mail in one click (N1, Jules 10 Nov). The note lands in `Personal/<you>/`,
 * named after the subject without its `Re:`, with the vault's front matter and a reference to
 * the message; making it twice opens the first; the sender links to their contact page; the
 * text can't add a task, a tag or a link; attachments are listed by name; a project is offered
 * (the sender's, or the thread's), never decided. The mailbox is faked (no IMAP in a test).
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Msg = { uid: number; from: string; fromName: string; to: string; subject: string; date: string | null; text: string; html: string | null; messageId: string | null; references: string | null; attachments: { filename: string; contentType: string; size: number }[] };
  const boxes: Record<string, Msg[]> = {};
  return { boxes };
});

vi.mock("../src/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail.js")>()),
  verifyConnection: async () => {},
  listInbox: async () => [],
  getMessage: async (c: { email: string }, uid: number) => fake.boxes[c.email]?.find((m) => m.uid === uid) ?? null,
}));

process.env.ORRAMA_FETCH_ALLOW = "127.0.0.1";
const { bootAi } = await import("./helpers/aiServer.js");
const s = await bootAi("mail-note");
afterAll(() => s.close());

const HOME = "sam@personal.example";
const WORK = "sam@work.example";
const make = (uid: number, account?: string, who = "jules") => s.call(who, "POST", "/api/mail/note", { uid, ...(account ? { account } : {}) });
const file = (rel: string) => fs.readFileSync(path.join(s.vault, rel), "utf8");
const note = (id: string) => s.built.store.index.get(id)!;
const msg = (over: Partial<(typeof fake.boxes)[string][number]>) => ({
  uid: 1,
  from: "ines@oakline.example",
  fromName: "Ines Vermaat",
  to: HOME,
  subject: "Site visit",
  date: "2026-11-21T08:05:00.000Z",
  text: "See you there.",
  html: null,
  messageId: "<w1@oakline.example>",
  references: null,
  attachments: [],
  ...over,
});

beforeAll(async () => {
  for (const email of [HOME, WORK]) {
    const r = await s.call("jules", "POST", "/api/mail/account", { email, appPassword: "abcd efgh ijkl mnop", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", ...(email === WORK ? { label: "Work" } : {}) });
    if (r.status !== 200) throw new Error(r.body);
  }
  fake.boxes[HOME] = [
    msg({ uid: 1, subject: "Re: Fwd: Site visit", attachments: [{ filename: "Plan rev C.pdf", contentType: "application/pdf", size: 4000 }, { filename: "[ ] odd name.png", contentType: "image/png", size: 10 }] }),
    msg({ uid: 2, subject: "Site visit", messageId: "<other@oakline.example>", text: "A second mail, same subject." }),
    msg({ uid: 3, subject: "RE: [External] Newsletter", from: "news@shop.example", fromName: "Shop", messageId: "<n3@shop.example>", text: "- [ ] buy milk #sale [[Secret plans]]\n# Big heading\nRead it: https://shop.example/a/b?utm=x\n[https://cdn.shop.example/hero.png]" }),
    msg({ uid: 4, subject: "", messageId: null, from: "nobody@example.com", fromName: "", text: "" }),
    msg({ uid: 5, subject: "Re: Site visit", messageId: "<w5@oakline.example>", references: "<w1@oakline.example>", from: "someone@else.example", fromName: "Someone" }),
  ];
  fake.boxes[WORK] = [msg({ uid: 1, subject: "Quay drawings", from: "thijs@kade.example", fromName: "Thijs", messageId: "<q1@kade.example>", to: WORK })];
  // Ines is a contact of the Atlas project.
  const put = await s.call("jules", "PUT", "/api/vault/note", { path: "Contacts/Ines Vermaat.md", content: "---\ntitle: Ines Vermaat\ntags: [contact, project/atlas]\nemail: \"Ines@Oakline.example\"\n---\n# Ines Vermaat\n", create: true });
  if (put.status !== 200) throw new Error(put.body);
});

describe("Make a note", () => {
  it("writes Personal/<you>/<subject without Re:>.md with the vault's front matter, the sender's page and the attachments by name", async () => {
    const r = await make(1);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: true, path: "Personal/jules/Site visit.md", title: "Site visit" });
    const text = file("Personal/jules/Site visit.md");
    expect(text).toMatch(/^---\n(?:id: n-[\w-]+\n)?title: "Site visit"\ntags: \[mail\]\ndomain: personal\nfrom: "Ines Vermaat <ines@oakline\.example>"\ndate: 2026-11-21\nmessage-id: "<w1@oakline\.example>"\nmail: "\/mail\/1"\n/);
    expect(note(r.json.id).frontmatter["id"]).toBe(r.json.id);
    expect(text).toContain("From [[Contacts/Ines Vermaat|Ines Vermaat]] (ines@oakline.example)");
    expect(text).toMatch(/\n---\nFrom \[\[Contacts\/Ines Vermaat\|Ines Vermaat\]\] \(ines@oakline\.example\) · Sat 21 Nov 2026, \d\d:05\n\nSee you there\./);
    expect(text).toContain("See you there.");
    expect(text).toContain("## Attachments\n\n- Plan rev C.pdf\n- \\[ ] odd name.png");
    // The sender's page links back to the note.
    expect(s.built.store.index.backlinks(s.built.store.index.getByPath("Contacts/Ines Vermaat.md")!.id).map((b) => b.fromPath)).toContain("Personal/jules/Site visit.md");
  });

  it("a second click opens the note already made, and writes nothing", async () => {
    const before = fs.readdirSync(path.join(s.vault, "Personal/jules")).sort();
    const r = await make(1);
    expect(r.json).toMatchObject({ created: false, path: "Personal/jules/Site visit.md" });
    expect(fs.readdirSync(path.join(s.vault, "Personal/jules")).sort()).toEqual(before);
  });

  it("another mail with the same subject gets a name of its own", async () => {
    const r = await make(2);
    expect(r.json).toMatchObject({ created: true, path: "Personal/jules/Site visit (2).md" });
  });

  it("the mail's text adds no task, tag, link or heading to the vault", async () => {
    const r = await make(3);
    expect(r.json.path).toBe("Personal/jules/Newsletter.md");
    const n = note(r.json.id);
    expect(n.tasks).toEqual([]);
    expect(n.tags.map((t) => t.tag)).toEqual(["mail"]);
    expect(n.links).toEqual([]);
    expect(n.headings).toEqual([]);
    const text = file(r.json.path);
    expect(text).toContain("- \\[ ] buy milk \\#sale \\[\\[Secret plans\\]\\]");
    // Read as Mail's reader shows it: links by their host, image-only lines gone.
    expect(text).toContain("Read it: [shop.example](https://shop.example/a/b?utm=x)");
    expect(text).not.toContain("hero.png");
  });

  it("a mail with no subject and no Message-ID is still named, and still found again", async () => {
    const r = await make(4);
    expect(r.json).toMatchObject({ created: true, title: "Mail from nobody@example.com" });
    expect(file(r.json.path)).toContain(`message-id: "uid:4@${HOME}"`);
    expect((await make(4)).json).toMatchObject({ created: false, path: r.json.path });
  });

  it("a mail of another account says that account in its address", async () => {
    const r = await make(1, "Work");
    expect(r.json.path).toBe("Personal/jules/Quay drawings.md");
    const acct = ((await s.call("jules", "GET", "/api/mail/accounts")).json as { id: string; label: string }[]).find((a) => a.label === "Work")!;
    expect(file(r.json.path)).toContain(`mail: "/mail/${acct.id.replace(/^mail-/, "")}.1"`);
  });
});

describe("the project it may belong with is offered, never decided", () => {
  it("the sender's contact note's project", async () => {
    const r = await make(1);
    expect(r.json.projects).toEqual([{ slug: "atlas", name: "Atlas Architecture" }]);
    expect(note(r.json.id).tags.map((t) => t.tag)).toEqual(["mail"]);
  });

  it("the project a note of the same thread is in", async () => {
    // The first note joins Acme by hand; a reply in its thread from someone else is offered Acme.
    const first = await make(1);
    expect((await s.call("jules", "POST", "/api/projects/acme/notes", { noteId: first.json.id })).status).toBe(200);
    const reply = await make(5);
    expect(reply.json.created).toBe(true);
    expect(reply.json.projects).toEqual([{ slug: "acme", name: "Acme Relaunch Brief" }]);
    // A project the note is in already is not offered again.
    expect((await make(1)).json.projects).toEqual([{ slug: "atlas", name: "Atlas Architecture" }]);
  });

  it("nothing is offered for a sender nobody knows", async () => {
    expect((await make(4)).json.projects).toEqual([]);
  });
});

describe("Undo and boundaries", () => {
  it("Undo puts the note in the trash; making it again then writes a new one", async () => {
    const r = await make(2);
    expect((await s.call("jules", "POST", "/api/vault/trash", { path: r.json.path })).status).toBe(200);
    expect(fs.existsSync(path.join(s.vault, r.json.path))).toBe(false);
    const again = await make(2);
    expect(again.json).toMatchObject({ created: true, path: "Personal/jules/Site visit (2).md" });
  });

  it("a message that isn't there is a 404; with no account, a 400", async () => {
    expect((await make(99)).status).toBe(404);
    expect((await make(1, undefined, "erin")).status).toBe(400);
  });
});
