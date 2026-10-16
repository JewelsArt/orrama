/**
 * Mail's composer and the drafts Orr stages (WEB-006). Opening a second staged draft while the
 * composer was open kept the first draft's text under the second draft's id and headers: Send
 * mailed A's words threaded to B's message, deleted B unsent, and left A waiting to go twice.
 * And reading another message while writing threw the reply away without asking.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { Mail } from "./Mail.js";
import { Toaster } from "./ui/overlays.js";
import type { Company, Contact } from "@orrama/schema/responses";
import { INBOX, json, stubMailbox } from "./test/mail-fixture.js";

const me = { id: "u1", email: "jules@orrama.dev", displayName: "Jules" } as unknown as Me;

beforeEach(() => history.replaceState(null, "", "/mail"));

afterEach(() => {
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The staged draft's row in "Waiting for you", by its subject. */
const draftRow = (subject: string) => screen.findByRole("link", { name: `Review the draft ${subject}` });
const composer = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
/**
 * A message's row, by its sender. The link itself, not the name inside it: happy-dom follows a
 * link clicked through a child element even when the click was prevented (a browser does not).
 */
const row = (sender: string) =>
  waitFor(() => {
    const a = [...document.querySelectorAll<HTMLAnchorElement>("a.mr")].find((r) => r.textContent?.includes(sender));
    if (!a) throw new Error(`no row from ${sender}`);
    return a;
  });

describe("Mail: staged drafts in the composer (WEB-006)", () => {
  it("each staged draft opens with its own To, Subject and text", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await draftRow("Agenda for Friday's review"));
    expect(composer().value).toBe("Draft A: the agenda, three points.");
    await user.click(await draftRow("Re: Research plan — section 3"));
    expect(field("To").value).toBe("i.vermaat@westerdok.example");
    expect(field("Subject").value).toBe("Re: Research plan — section 3");
    expect(composer().value).toBe("Draft B: thank you, Ines. Both are in section 3 now.");
  });

  it("Send mails the text on screen, with its own headers, and clears exactly that staged row", async () => {
    const { sent } = stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await draftRow("Agenda for Friday's review"));
    await user.click(await draftRow("Re: Research plan — section 3"));
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    const post = sent.find((r) => r.method === "POST" && r.url === "/api/mail/send")!;
    expect(post.body).toMatchObject({
      to: "i.vermaat@westerdok.example",
      subject: "Re: Research plan — section 3",
      body: "Draft B: thank you, Ines. Both are in section 3 now.",
      inReplyTo: "<rp-3@westerdok.example>",
    });
    expect(sent.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual(["/api/mail/drafts/d-b"]);
  });

  it("Write after a staged draft starts an empty message", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await draftRow("Agenda for Friday's review"));
    await user.click(screen.getByRole("button", { name: /^(compose|write)$/i }));
    expect(composer().value).toBe("");
    expect(field("To").value).toBe("");
  });

  it("opening a message while the composer holds text asks first, and Keep it keeps the text", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await screen.findByText("Camille Dubois");
    await user.click(screen.getByRole("button", { name: /^(compose|write)$/i }));
    await user.type(composer(), "Half a thought");
    await user.click(await row("Camille Dubois"));
    const ask = await screen.findByRole("alertdialog");
    await user.click(within(ask).getByRole("button", { name: "Keep it" }));
    expect(composer().value).toBe("Half a thought");
  });

  it("…and Discard leaves the text and opens the message", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await screen.findByText("Camille Dubois");
    await user.click(screen.getByRole("button", { name: /^(compose|write)$/i }));
    await user.type(composer(), "Half a thought");
    await user.click(await row("Camille Dubois"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("One question about BE reach before Friday.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("Write over an edited draft asks first, and the edit stays if you keep it", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await draftRow("Agenda for Friday's review"));
    await user.type(composer(), " And a fourth.");
    await user.click(screen.getByRole("button", { name: /^(compose|write)$/i }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Keep it" }));
    expect(composer().value).toBe("Draft A: the agenda, three points. And a fourth.");
  });

  it("another staged draft over an edited one asks first", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await draftRow("Agenda for Friday's review"));
    await user.type(composer(), " And a fourth.");
    await user.click(await draftRow("Re: Research plan — section 3"));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    expect(composer().value).toBe("Draft B: thank you, Ines. Both are in section 3 now.");
  });

  it("an untouched composer gives way without asking", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await draftRow("Agenda for Friday's review"));
    await user.click(await row("Camille Dubois"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => {});
    expect(await screen.findByText("One question about BE reach before Friday.")).toBeTruthy();
  });
});

/* ---- the redesign (structure.md §2.8): addresses, names that open their things, errors ---- */

const INES: Contact = {
  id: "n-ines",
  name: "Ines Vermaat",
  path: "Contacts/Ines Vermaat.md",
  sector: "School",
  role: "Thesis supervisor",
  company: "Westerdok",
  email: "i.vermaat@westerdok.example",
  phone: "",
  linkedin: "",
  personal: false,
};
const WESTERDOK: Company = {
  id: "n-westerdok",
  name: "Westerdok",
  path: "Contacts/Companies/Westerdok.md",
  description: "",
  sector: "School",
  linkedin: "",
  website: "westerdok.example",
  careers: "",
  location: "",
  positions: [],
  personal: false,
};
const people = {
  "GET /api/contacts": () => json([INES]),
  "GET /api/companies": () => json([WESTERDOK]),
};

describe("Mail at its addresses", () => {
  it("a message's address opens it, on a reload as well as from the list", async () => {
    history.replaceState(null, "", "/mail/102");
    stubMailbox();
    render(<Mail me={me} />);
    expect(await screen.findByText("One question about BE reach before Friday.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "October report: one question about BE reach" })).toBeTruthy();
  });

  it("a row is a link to its message, and opening it marks it read", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const r = await row("Camille Dubois");
    expect(r.getAttribute("href")).toBe("/mail/102");
    expect(r.className).toContain("unread");
    await user.click(r);
    expect(location.pathname).toBe("/mail/102");
    await screen.findByText("One question about BE reach before Friday.");
    expect((await row("Camille Dubois")).className).not.toContain("unread");
  });

  it("Reply opens its own screen, threaded, and Back closes it", async () => {
    history.replaceState(null, "", "/mail/101");
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await screen.findByText("Thanks for the draft. Section 3 reads much better now.");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(location.pathname + location.search).toBe("/mail/101?write=reply");
    expect(field("To").value).toBe("i.vermaat@westerdok.example");
    expect(field("Subject").value).toBe("Re: Research plan — section 3");
    await act(async () => {
      history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(location.search).toBe("");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("Forward starts a message to nobody with the text below", async () => {
    history.replaceState(null, "", "/mail/102");
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await screen.findByText("One question about BE reach before Friday.");
    await user.click(screen.getByRole("button", { name: "Forward" }));
    expect(field("To").value).toBe("");
    expect(field("Subject").value).toBe("Fwd: October report: one question about BE reach");
    expect(composer().value).toContain("One question about BE reach before Friday.");
  });

  it("the sender's name opens their page, with how you know them under it", async () => {
    history.replaceState(null, "", "/mail/101");
    stubMailbox(people);
    render(<Mail me={me} />);
    const name = await screen.findByRole("link", { name: "Ines Vermaat" });
    expect(name.getAttribute("href")).toBe("/people/ines-vermaat");
    const company = await screen.findByRole("link", { name: "Westerdok" });
    expect(company.getAttribute("href")).toBe("/companies/westerdok");
    expect(company.closest(".mrel")?.textContent).toBe("Thesis supervisor at Westerdok");
    // In the list, the contact's company follows the name.
    expect(await screen.findByText("Ines Vermaat · Westerdok")).toBeTruthy();
  });

  it("Orr's reply waits under the message it answers, and Send there sends exactly that", async () => {
    history.replaceState(null, "", "/mail/101");
    const { sent } = stubMailbox(people);
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const card = await screen.findByRole("article", { name: "Draft: Re: Research plan — section 3" });
    expect(within(card).getByText(/Orr drafted a reply/)).toBeTruthy();
    expect(within(card).getByText("i.vermaat@westerdok.example")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.some((r) => r.method === "DELETE")).toBe(true));
    expect(sent.find((r) => r.method === "POST")!.body).toEqual({
      to: "i.vermaat@westerdok.example",
      subject: "Re: Research plan — section 3",
      body: "Draft B: thank you, Ines. Both are in section 3 now.",
      inReplyTo: "<rp-3@westerdok.example>",
      references: "<rp-1@westerdok.example> <rp-3@westerdok.example>",
    });
    expect(sent.filter((r) => r.method === "DELETE").map((r) => r.url)).toEqual(["/api/mail/drafts/d-b"]);
    await waitFor(() => expect(screen.queryByRole("article", { name: /^Draft:/ })).toBeNull());
  });

  it("Waiting for you is a page of its own, and its count leads there", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await screen.findByRole("link", { name: "Waiting for you · 2" }));
    expect(location.pathname).toBe("/mail/waiting");
    expect(screen.getAllByRole("article", { name: /^Draft:/ })).toHaveLength(2);
  });
});

describe("Mail when something is missing", () => {
  it("a mailbox that doesn't answer says so in words, keeps Settings a click away, and retries", async () => {
    let fail = true;
    const { sent } = stubMailbox({ "GET /api/mail/inbox": () => (fail ? json({ error: "could not read inbox: AUTHENTICATIONFAILED Invalid credentials (Failure)" }, 502) : json({ email: "jules@orrama.dev", messages: [] })) });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Couldn't reach Gmail.");
    expect(notice.textContent).not.toMatch(/AUTHENTICATIONFAILED|could not read/);
    expect(within(notice).getByRole("link", { name: "Settings → Mail" }).getAttribute("href")).toBe("/settings/connections");
    fail = false;
    await user.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(sent.filter((r) => r.url.startsWith("/api/mail/inbox"))).toHaveLength(2);
  });

  it("a message that won't open says so and offers Retry, never the server's text", async () => {
    history.replaceState(null, "", "/mail/101");
    stubMailbox({ "GET /api/mail/message/101": () => json({ error: "could not read message: socket hang up" }, 502) });
    render(<Mail me={me} />);
    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toContain("Couldn't open this message.");
    expect(notice.textContent).not.toContain("socket");
    expect(within(notice).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("no account: Connect Gmail opens Settings → Connections", async () => {
    stubMailbox({ "GET /api/mail/account": () => json({ connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null }) });
    render(<Mail me={me} />);
    const link = await screen.findByRole("link", { name: "Connect Gmail" });
    expect(link.getAttribute("href")).toBe("/settings/connections");
  });
});

describe("Mail's tabs", () => {
  it("All first; tabs that don't fit go into More; the choice is remembered", async () => {
    const cats = ["primary", "promotions", "social", "updates", "forums"] as const;
    const inbox = cats.map((category, i) => ({ ...INBOX[0]!, uid: 200 + i, subject: `In ${category}`, category, seen: category !== "forums" }));
    stubMailbox({ "GET /api/mail/inbox": () => json({ email: "jules@orrama.dev", messages: inbox }) });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const tabs = await screen.findByRole("tablist", { name: "Categories" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All", "Primary", "Promotions", "Social"]);
    await user.click(within(tabs).getByRole("button", { name: /More/ }));
    await user.click(screen.getByRole("menuitem", { name: "Forums · 1" }));
    expect(screen.getByText("In forums")).toBeTruthy();
    expect(screen.queryByText("In primary")).toBeNull();
    // The tab you picked comes into the row; the one it displaced goes into More.
    expect(within(tabs).getByRole("tab", { selected: true }).textContent).toBe("Forums1");
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["All", "Primary", "Promotions", "Forums1"]);
    expect(localStorage.getItem("orrama-mail-tab")).toBe("forums");
  });
});

describe("after Send", () => {
  it("a composer that is gone no longer closes itself: leaving within the moment Sent shows keeps your place", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubMailbox();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Mail me={me} />);
    await user.click(await screen.findByRole("button", { name: "Write" }));
    await user.type(field("To"), "thijs@tulp.example");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await screen.findByRole("button", { name: "Sent" });
    // Straight on to a message, before the composer's moment is up.
    await user.click(await row("Camille Dubois"));
    expect(location.pathname).toBe("/mail/102");
    const back = vi.spyOn(history, "back");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(back).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/mail/102");
  });
});

describe("Mail when the server fails (WEB-010)", () => {
  it("an account that couldn't be read says so with Retry, never \"Mail isn't connected\"", async () => {
    let down = true;
    stubMailbox({ "GET /api/mail/account": () => (down ? json({ error: "internal error" }, 500) : json({ connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null })) });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Mail didn't open.");
    expect(screen.queryByText("Mail isn't connected yet.")).toBeNull();
    down = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Mail isn't connected yet.")).toBeTruthy();
  });

  it("a sent draft that couldn't be cleared says so, so it isn't sent twice", async () => {
    history.replaceState(null, "", "/mail/101");
    stubMailbox({ "DELETE /api/mail/drafts/d-b": () => json({ error: "internal error" }, 500) });
    const user = userEvent.setup();
    render(<Toaster />);
    render(<Mail me={me} />);
    const card = await screen.findByRole("article", { name: "Draft: Re: Research plan — section 3" });
    await user.click(within(card).getByRole("button", { name: "Send" }));
    await waitFor(() => expect([...document.querySelectorAll(".toast span")].map((t) => t.textContent)).toContain("Sent to i.vermaat@westerdok.example. Its draft is still listed: discard it."));
  });
});
