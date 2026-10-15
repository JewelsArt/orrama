/** Mail's pure parts: list dates, the tabs and More, who a sender is, and the composer's address. */
import { describe, expect, it } from "vitest";
import type { Company, Contact, InboxItem, MailMessage } from "@orrama/schema/responses";
import { composeHref, composeOf, forwardDraft, replyDraft } from "./compose.js";
import { addressOf, entitySlug, hostOf, matchSender } from "./people.js";
import { fitTabs, mailTabs, splitTabs, validTab } from "./tabs.js";
import { listWhen } from "./when.js";

const NOW = new Date(2026, 9, 8, 12, 0); // Thu 8 Oct 2026, 12:00 local

describe("listWhen", () => {
  it("says the time today, Yesterday, then the date", () => {
    expect(listWhen(new Date(2026, 9, 8, 10, 1).toISOString(), NOW)).toBe("10:01");
    expect(listWhen(new Date(2026, 9, 7, 23, 50).toISOString(), NOW)).toBe("Yesterday");
    expect(listWhen(new Date(2026, 9, 6, 9, 0).toISOString(), NOW)).toBe("Tue 6 Oct");
    expect(listWhen(new Date(2025, 11, 30, 9, 0).toISOString(), NOW)).toBe("Tue 30 Dec 2025");
    expect(listWhen(null, NOW)).toBe("");
  });
});

const item = (category: InboxItem["category"], seen = true): InboxItem => ({ uid: 1, from: "a@b", fromName: "A", subject: "s", date: null, seen, messageId: null, category });

describe("the tabs", () => {
  it("All and Primary always; others once mail lands there; counts are unread", () => {
    const tabs = mailTabs([item("updates", false), item("updates"), item("primary", false)]);
    expect(tabs.map((t) => [t.id, t.unread])).toEqual([
      ["all", 2],
      ["primary", 1],
      ["updates", 1],
    ]);
  });

  it("puts what doesn't fit into More, never All", () => {
    const tabs = mailTabs(["primary", "promotions", "social", "updates", "forums"].map((c) => item(c as InboxItem["category"])));
    const { row, more } = splitTabs(tabs);
    expect(row.map((t) => t.id)).toEqual(["all", "primary", "promotions", "social"]);
    expect(more.map((t) => t.id)).toEqual(["updates", "forums"]);
    expect(splitTabs(tabs, 6).more).toEqual([]);
  });

  it("the current tab stays in the row: one picked from More takes the last place", () => {
    const tabs = mailTabs(["primary", "promotions", "social", "updates", "forums"].map((c) => item(c as InboxItem["category"])));
    const { row, more } = splitTabs(tabs, 4, "forums");
    expect(row.map((t) => t.id)).toEqual(["all", "primary", "promotions", "forums"]);
    expect(more.map((t) => t.id)).toEqual(["social", "updates"]);
    expect(splitTabs(tabs, 4, "primary").row.map((t) => t.id)).toEqual(["all", "primary", "promotions", "social"]);
  });

  it("measures what fits: all when they do, else as many as fit beside More, never none", () => {
    expect(fitTabs([40, 70, 100, 60], 90, 300, 2)).toBe(4);
    expect(fitTabs([40, 70, 100, 60, 70, 60], 90, 300, 2)).toBe(2);
    expect(fitTabs([40, 70, 100], 90, 100, 2)).toBe(1);
    expect(fitTabs([0, 0, 0], 0, 300)).toBeNull();
  });

  it("a stored tab the inbox no longer offers falls back to All", () => {
    const tabs = mailTabs([item("primary")]);
    expect(validTab("forums", tabs)).toBe("all");
    expect(validTab("primary", tabs)).toBe("primary");
    expect(validTab(null, tabs)).toBe("all");
  });
});

const contact = (over: Partial<Contact>): Contact => ({ id: "c1", name: "Ines Vermaat", path: "Contacts/Ines Vermaat.md", sector: "School", role: "", company: "", email: "", phone: "", linkedin: "", personal: false, ...over });
const company = (over: Partial<Company>): Company => ({ id: "co1", name: "Westerdok", path: "Contacts/Companies/Westerdok.md", description: "", sector: "School", linkedin: "", website: "", careers: "", location: "", positions: [], personal: false, ...over });

describe("who sent it", () => {
  it("finds the contact by address, whatever the case, and their company by name", () => {
    const s = matchSender("I.Vermaat@Westerdok.example", "Ines", [contact({ email: "i.vermaat@westerdok.example", company: "[[Westerdok]]" })], [company({})]);
    expect(s.kind).toBe("person");
    expect(s.contact?.id).toBe("c1");
    expect(s.company?.id).toBe("co1");
  });

  it("falls back to the contact's name, and keeps an unmatched company as words", () => {
    const s = matchSender("ines@elsewhere.example", "Ines Vermaat", [contact({ company: "Polder Capital" })], [company({})]);
    expect(s.contact?.id).toBe("c1");
    expect(s.company).toBeUndefined();
    expect(s.companyName).toBe("Polder Capital");
  });

  it("an unknown sender at a company's domain is someone there; a role address is the company", () => {
    const co = company({ website: "https://www.westerdok.example/" });
    expect(matchSender("y.haddad@westerdok.example", "Yara Haddad", [], [co])).toEqual({ kind: "person", company: co });
    expect(matchSender("careers@mail.westerdok.example", "Westerdok Careers", [], [co]).kind).toBe("company");
    expect(matchSender("noreply@oostrunners.example", "Oost Runners", [], []).kind).toBe("company");
    expect(matchSender("emma@student.example", "Emma Jansen", [], [co])).toEqual({ kind: "person", company: undefined });
  });

  it("reads addresses and hosts", () => {
    expect(addressOf("Ines <I.V@x.example>")).toBe("i.v@x.example");
    expect(hostOf("westerdok.example/careers")).toBe("westerdok.example");
    expect(hostOf("")).toBe("");
  });

  it("slugs come from the file name", () => {
    expect(entitySlug("Contacts/Ines Vermaat.md")).toBe("ines-vermaat");
    expect(entitySlug("Contacts/Companies/Café Noël & Co.md")).toBe("cafe-noel-co");
  });
});

const msg: MailMessage = {
  uid: 7,
  from: "i.vermaat@westerdok.example",
  fromName: "Ines Vermaat",
  to: "jules@orrama.dev",
  subject: "Research plan",
  date: new Date(2026, 9, 8, 10, 1).toISOString(),
  text: "Two things before Friday.",
  html: null,
  messageId: "<b@x>",
  references: "<a@x>",
};

describe("composing", () => {
  it("the composer's address round-trips", () => {
    expect(composeOf("?write=reply")).toEqual({ kind: "reply" });
    expect(composeOf("?draft=draft-1a2b")).toEqual({ kind: "draft", id: "draft-1a2b" });
    expect(composeOf("?write=delete")).toBeNull();
    expect(composeOf("")).toBeNull();
    expect(composeHref("/mail/7", { kind: "forward" })).toBe("/mail/7?write=forward");
    expect(composeOf(composeHref("/mail/waiting", { kind: "draft", id: "d 1" }).split("?")[1]!)).toEqual({ kind: "draft", id: "d 1" });
  });

  it("a reply threads under the message, and Re: is not doubled", () => {
    expect(replyDraft(msg)).toMatchObject({ to: msg.from, subject: "Re: Research plan", inReplyTo: "<b@x>", references: "<a@x> <b@x>" });
    expect(replyDraft({ ...msg, subject: "RE: x" }).subject).toBe("RE: x");
  });

  it("a forward goes to nobody yet and carries the message under a header", () => {
    const f = forwardDraft(msg, NOW);
    expect(f.to).toBe("");
    expect(f.subject).toBe("Fwd: Research plan");
    expect(f.inReplyTo).toBeUndefined();
    expect(f.body).toContain("From: Ines Vermaat <i.vermaat@westerdok.example>");
    expect(f.body).toContain("Date: Thu 8 Oct, 10:01");
    expect(f.body.endsWith("Two things before Friday.")).toBe(true);
  });
});
