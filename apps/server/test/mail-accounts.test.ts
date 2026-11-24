/**
 * More than one mail account (N1, schema 7: "connect more than one email account").
 *
 * One inbox across the accounts, newest first, each message marked with its account; a filter
 * to one; a message read from its own account; a reply sent from the account the mail came to
 * and new mail from the default; drafts that keep their account; Orr's and the MCP tools naming
 * an account by its address or label; and every account going with its owner. The mailboxes are
 * faked per address (no IMAP server in a test): `listInbox`, `getMessage`, `sendMail` and
 * `verifyConnection` answer from `fake`, everything else in mail.js is the real code.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  type Item = { uid: number; from: string; fromName: string; subject: string; date: string | null; seen: boolean; messageId: string | null; category: "primary" };
  const boxes: Record<string, Item[]> = {};
  const sent: { from: string; to: string; subject: string; inReplyTo?: string }[] = [];
  const down = new Set<string>();
  return { boxes, sent, down };
});

vi.mock("../src/mail.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/mail.js")>()),
  verifyConnection: async () => {},
  listInbox: async (c: { email: string }) => {
    if (fake.down.has(c.email)) throw new Error(`${c.email} is down`);
    return (fake.boxes[c.email] ?? []).map((m) => ({ ...m }));
  },
  getMessage: async (c: { email: string }, uid: number) => {
    const m = (fake.boxes[c.email] ?? []).find((x) => x.uid === uid);
    return m ? { ...m, to: c.email, text: `Body of ${m.subject}`, html: null, references: null, attachments: [] } : null;
  },
  sendMail: async (c: { email: string }, input: { to: string; subject: string; inReplyTo?: string }) => {
    fake.sent.push({ from: c.email, to: input.to, subject: input.subject, inReplyTo: input.inReplyTo });
    return { messageId: `<sent-${fake.sent.length}@test>` };
  },
}));

process.env.ORRAMA_FETCH_ALLOW = "127.0.0.1";
const { bootAi } = await import("./helpers/aiServer.js");
const { ask, toolOutputs } = await import("./helpers/fakeChat.js");
const s = await bootAi("mail-accounts");
// After bootAi: these read the environment it sets.
const { mcpClient } = await import("./helpers/mcp.js");
const { tables } = await import("../src/db.js");
const { removeAccount } = await import("../src/removeAccount.js");
const { exportOrrama } = await import("../src/exportData.js");
afterAll(() => s.close());

const PERSONAL = "sam@personal.example";
const WORK = "sam@work.example";
const connect = (who: string, email: string, label?: string) =>
  s.call(who, "POST", "/api/mail/account", { email, appPassword: "abcd efgh ijkl mnop", imapHost: "127.0.0.1", smtpHost: "127.0.0.1", ...(label ? { label } : {}) });
type Row = { id: string; email: string; label: string; isDefault: boolean };
const accounts = async (who = "jules") => (await s.call(who, "GET", "/api/mail/accounts")).json as Row[];

beforeAll(async () => {
  fake.boxes[PERSONAL] = [
    { uid: 1, from: "mum@example.com", fromName: "Mum", subject: "Sunday lunch", date: "2026-11-20T10:00:00.000Z", seen: false, messageId: "<p1@example.com>", category: "primary" },
    { uid: 2, from: "club@example.com", fromName: "Club", subject: "Training moved", date: "2026-11-22T09:00:00.000Z", seen: true, messageId: "<p2@example.com>", category: "primary" },
  ];
  fake.boxes[WORK] = [
    { uid: 1, from: "ines@oakline.example", fromName: "Ines", subject: "Site visit", date: "2026-11-21T08:00:00.000Z", seen: false, messageId: "<w1@oakline.example>", category: "primary" },
  ];
});

describe("connecting accounts", () => {
  it("the first account is the default, as one account always was; a second joins after it", async () => {
    expect((await connect("jules", PERSONAL)).status).toBe(200);
    expect((await connect("jules", WORK, "Work")).status).toBe(200);
    const list = await accounts();
    expect(list.map((a) => [a.email, a.label, a.isDefault])).toEqual([
      [PERSONAL, PERSONAL, true],
      [WORK, "Work", false],
    ]);
    const one = (await s.call("jules", "GET", "/api/mail/account")).json;
    expect(one).toMatchObject({ connected: true, email: PERSONAL, accounts: 2 });
    expect(JSON.stringify(list)).not.toMatch(/password|abcd/i);
  });

  it("connecting an address again gives it the new password, not a second row", async () => {
    const before = await accounts();
    expect((await connect("jules", WORK.toUpperCase())).status).toBe(200);
    const after = await accounts();
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
    expect(after[1]!.label).toBe("Work");
  });

  it("each person sees only their own accounts, and can't change another's", async () => {
    expect(await accounts("erin")).toEqual([]);
    const work = (await accounts()).find((a) => a.email === WORK)!;
    expect((await s.call("erin", "PATCH", `/api/mail/accounts/${work.id}`, { label: "Mine" })).status).toBe(404);
    expect((await s.call("erin", "DELETE", `/api/mail/accounts/${work.id}`)).status).toBe(404);
    expect((await accounts()).find((a) => a.id === work.id)!.label).toBe("Work");
  });
});

describe("reading", () => {
  it("one inbox across the accounts, newest first, each message marked with its account", async () => {
    const r = await s.call("jules", "GET", "/api/mail/inbox");
    expect(r.status).toBe(200);
    const [p, w] = await accounts();
    expect(r.json.messages.map((m: { subject: string; account: string }) => [m.subject, m.account])).toEqual([
      ["Training moved", p!.id],
      ["Site visit", w!.id],
      ["Sunday lunch", p!.id],
    ]);
    expect(r.json.accounts.map((a: { label: string; failed: boolean }) => [a.label, a.failed])).toEqual([
      [PERSONAL, false],
      ["Work", false],
    ]);
  });

  it("a filter shows one account, named by id, address or label", async () => {
    const [, w] = await accounts();
    for (const ref of [w!.id, WORK, "work"]) {
      const r = await s.call("jules", "GET", `/api/mail/inbox?account=${encodeURIComponent(ref)}`);
      expect(r.json.messages.map((m: { subject: string }) => m.subject)).toEqual(["Site visit"]);
    }
    const none = await s.call("jules", "GET", "/api/mail/inbox?account=School");
    expect(none.status).toBe(400);
    expect(none.json.error).toMatch(/no mail account called "School" — the accounts are sam@personal\.example, Work \(sam@work\.example\)/);
  });

  it("an account that can't be read is said, and the others still show", async () => {
    fake.down.add(WORK);
    try {
      const r = await s.call("jules", "GET", "/api/mail/inbox");
      expect(r.status).toBe(200);
      expect(r.json.messages.map((m: { subject: string }) => m.subject)).toEqual(["Training moved", "Sunday lunch"]);
      expect(r.json.accounts.find((a: { label: string }) => a.label === "Work").failed).toBe(true);
      expect((await s.call("jules", "GET", "/api/mail/inbox?account=Work")).status).toBe(502);
    } finally {
      fake.down.delete(WORK);
    }
  });

  it("a message is read from its own account: uid 1 is a different message in each", async () => {
    const [p, w] = await accounts();
    const work = await s.call("jules", "GET", `/api/mail/message/1?account=${w!.id}`);
    expect([work.json.subject, work.json.account]).toEqual(["Site visit", w!.id]);
    const personal = await s.call("jules", "GET", "/api/mail/message/1");
    expect([personal.json.subject, personal.json.account]).toEqual(["Sunday lunch", p!.id]);
  });
});

describe("sending", () => {
  it("a reply goes from the account the mail came to; new mail from the default", async () => {
    const [, w] = await accounts();
    fake.sent.length = 0;
    const reply = await s.call("jules", "POST", "/api/mail/send", { to: "ines@oakline.example", subject: "Re: Site visit", body: "Thursday.", inReplyTo: "<w1@oakline.example>", account: w!.id });
    expect(reply.json.account).toBe(w!.id);
    await s.call("jules", "POST", "/api/mail/send", { to: "mum@example.com", subject: "Hi", body: "x" });
    expect(fake.sent.map((m) => m.from)).toEqual([WORK, PERSONAL]);
  });

  it("making another account the default moves new mail to it", async () => {
    const [p, w] = await accounts();
    const list = (await s.call("jules", "PATCH", `/api/mail/accounts/${w!.id}`, { default: true })).json as Row[];
    expect(list.map((a) => a.isDefault)).toEqual([false, true]);
    fake.sent.length = 0;
    await s.call("jules", "POST", "/api/mail/send", { to: "x@example.com", subject: "Hi", body: "x" });
    expect(fake.sent[0]!.from).toBe(WORK);
    await s.call("jules", "PATCH", `/api/mail/accounts/${p!.id}`, { default: true });
  });

  it("a draft keeps its account, and says it", async () => {
    const [, w] = await accounts();
    const d = await s.call("jules", "POST", "/api/mail/drafts", { to: "ines@oakline.example", subject: "Re: Site visit", body: "Thursday.", account: "Work" });
    expect(d.json).toMatchObject({ account: w!.id, from: WORK });
    const listed = (await s.call("jules", "GET", "/api/mail/drafts")).json as { id: string; account: string | null }[];
    expect(listed.find((x) => x.id === d.json.id)!.account).toBe(w!.id);
    expect((await s.call("jules", "POST", "/api/mail/drafts", { to: "x@example.com", subject: "s", body: "b", account: "nope" })).status).toBe(400);
    await s.call("jules", "DELETE", `/api/mail/drafts/${d.json.id}`);
  });
});

describe("renaming, ordering and removing", () => {
  it("a label can be changed and cleared back to the address", async () => {
    const [p] = await accounts();
    let list = (await s.call("jules", "PATCH", `/api/mail/accounts/${p!.id}`, { label: "Home" })).json as Row[];
    expect(list[0]!.label).toBe("Home");
    list = (await s.call("jules", "PATCH", `/api/mail/accounts/${p!.id}`, { label: "" })).json as Row[];
    expect(list[0]!.label).toBe(PERSONAL);
    expect((await s.call("jules", "PATCH", `/api/mail/accounts/${p!.id}`, { colour: "red" })).status).toBe(400);
  });

  it("an account moves in the list", async () => {
    const [p, w] = await accounts();
    const list = (await s.call("jules", "PATCH", `/api/mail/accounts/${w!.id}`, { position: 0 })).json as Row[];
    expect(list.map((a) => a.id)).toEqual([w!.id, p!.id]);
    await s.call("jules", "PATCH", `/api/mail/accounts/${p!.id}`, { position: 0 });
  });

  it("removing the default makes the next one the default; its drafts then go from that one", async () => {
    await connect("jules", "sam@third.example", "Third");
    const [p, w, t] = await accounts();
    const d = await s.call("jules", "POST", "/api/mail/drafts", { to: "x@example.com", subject: "s", body: "b" });
    expect(d.json.account).toBe(p!.id);
    const list = (await s.call("jules", "DELETE", `/api/mail/accounts/${p!.id}`)).json as Row[];
    expect(list.map((a) => [a.id, a.isDefault])).toEqual([
      [w!.id, true],
      [t!.id, false],
    ]);
    // It stays the default when another is moved above it.
    const moved = (await s.call("jules", "PATCH", `/api/mail/accounts/${t!.id}`, { position: 0 })).json as Row[];
    expect(moved.map((a) => [a.id, a.isDefault])).toEqual([
      [t!.id, false],
      [w!.id, true],
    ]);
    const drafts = (await s.call("jules", "GET", "/api/mail/drafts")).json as { id: string; account: string | null }[];
    expect(drafts.find((x) => x.id === d.json.id)!.account).toBe(null);
    await s.call("jules", "DELETE", `/api/mail/drafts/${d.json.id}`);
    await s.call("jules", "DELETE", `/api/mail/accounts/${t!.id}`);
    await connect("jules", PERSONAL);
    await s.call("jules", "PATCH", `/api/mail/accounts/${(await accounts())[1]!.id}`, { position: 0, default: true });
    expect((await accounts()).map((a) => [a.email, a.isDefault])).toEqual([
      [PERSONAL, true],
      [WORK, false],
    ]);
  });

  it("API tokens can't rename, reorder or remove an account", async () => {
    const tok = (await s.call("jules", "POST", "/api/tokens", { label: "t" })).json.token as string;
    const [, w] = await accounts();
    expect((await s.call(tok, "PATCH", `/api/mail/accounts/${w!.id}`, { label: "x" })).status).toBe(403);
    expect((await s.call(tok, "DELETE", `/api/mail/accounts/${w!.id}`)).status).toBe(403);
  });
});

describe("Orr names the account", () => {
  it("list_email reads every account and says which each message came to; read_email and draft_email take the account", async () => {
    s.queue.push(
      { tool: "list_email", args: {} },
      { tool: "read_email", args: { uid: 1, account: "Work" } },
      { tool: "draft_email", args: { to: "ines@oakline.example", subject: "Re: Site visit", body: "Thursday works.", inReplyTo: "<w1@oakline.example>", account: "Work" } },
      { text: "Drafted." },
    );
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("answer Ines"));
    const [listed, read, drafted] = toolOutputs(r.body);
    expect(listed.messages.map((m: { subject: string; account: string }) => [m.subject, m.account])).toEqual([
      ["Training moved", PERSONAL],
      ["Site visit", "Work"],
      ["Sunday lunch", PERSONAL],
    ]);
    expect([read.subject, read.account]).toEqual(["Site visit", "Work"]);
    expect(drafted).toMatchObject({ status: "awaiting_confirmation", account: "Work", from: WORK });
    const drafts = (await s.call("jules", "GET", "/api/mail/drafts")).json as { id: string; account: string }[];
    const w = (await accounts())[1]!;
    expect(drafts.find((d) => d.id === drafted.draftId)!.account).toBe(w.id);
    await s.call("jules", "DELETE", `/api/mail/drafts/${drafted.draftId}`);
  });

  it("an account that isn't there is said, never answered from another", async () => {
    s.queue.push({ tool: "list_email", args: { account: "School" } }, { text: "ok" });
    const [out] = toolOutputs((await s.call("jules", "POST", "/api/ai/ask", ask("school mail?"))).body);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no mail account called "School"/);
  });
});

describe("the MCP tools name the account", () => {
  it("list_email, read_email and draft_email take an account and say it", async () => {
    const c = await mcpClient(s.built.app, s.tokens.jules!, s.built.db);
    const [, w] = await accounts();
    const all = await c.tool("list_email", {});
    expect(all.json.messages.map((m: { account: string }) => m.account)).toContain(w!.id);
    const one = await c.tool("list_email", { account: "Work" });
    expect(one.json.messages.map((m: { subject: string }) => m.subject)).toEqual(["Site visit"]);
    const read = await c.tool("read_email", { uid: 1, account: WORK });
    expect([read.json.subject, read.json.account]).toEqual(["Site visit", w!.id]);
    const d = await c.tool("draft_email", { to: "ines@oakline.example", subject: "Re", body: "b", account: "Work", voiceRead: true });
    expect(d.json).toMatchObject({ status: "awaiting_confirmation", account: w!.id, from: WORK });
    await s.call("jules", "DELETE", `/api/mail/drafts/${d.json.id}`);
  });
});

describe("every account goes with its owner", () => {
  it("export lists every account with its label and which is the default, never a password", async () => {
    const { dir } = await exportOrrama({ into: `${s.dir}/exports-test` });
    const text = (await import("node:fs")).readFileSync(`${dir}/export.json`, "utf8");
    const data = JSON.parse(text);
    expect(data.mailAccounts.filter((m: { email: string }) => m.email.startsWith("sam@")).map((m: { email: string; label: string | null; default: boolean }) => [m.email, m.label, m.default])).toEqual([
      [WORK, "Work", false],
      [PERSONAL, null, true],
    ]);
    expect(text).not.toMatch(/abcdefghijklmnop|passwordEncrypted|password_encrypted/);
  });

  it("removing a person removes all their accounts and drafts", async () => {
    await connect("erin", "erin@one.example");
    await connect("erin", "erin@two.example");
    await s.call("erin", "POST", "/api/mail/drafts", { to: "x@example.com", subject: "s", body: "b" });
    const erin = s.built.db.select().from(tables.users).all().find((u) => u.username === "erin")!;
    const rows = () => s.built.db.select().from(tables.mailAccounts).all().filter((a) => a.userId === erin.id);
    expect(rows()).toHaveLength(2);
    removeAccount(s.built.db, { id: erin.id, username: erin.username });
    expect(rows()).toHaveLength(0);
    expect(s.built.db.select().from(tables.mailDrafts).all().filter((d) => d.userId === erin.id)).toHaveLength(0);
    // Jules's are untouched.
    expect(await accounts()).toHaveLength(2);
  });
});
