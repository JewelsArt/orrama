/**
 * Mail with more than one account (N1). One list for every account, each row saying its
 * account, with a menu to show one; or one account at a time, as Settings says on this device.
 * A message is opened from its own account (uid 101 is another message in each), a reply goes
 * from the account the mail came to, new mail from the default, a staged draft from its own.
 * With one account Mail reads as it always did. The people are the mockups' fictional ones.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { Mail } from "./Mail.js";
import { Toaster } from "./ui/overlays.js";
import { DRAFTS, json, stubMailbox } from "./test/mail-fixture.js";

const me = { id: "u1", email: "jules@orrama.dev", displayName: "Jules" } as unknown as Me;

beforeEach(() => {
  history.replaceState(null, "", "/mail");
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rows = () => [...document.querySelectorAll<HTMLAnchorElement>("a.mr")];
const rowOf = (sender: string) =>
  waitFor(() => {
    const a = rows().find((r) => r.textContent?.includes(sender));
    if (!a) throw new Error(`no row from ${sender}`);
    return a;
  });
const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;

describe("one list for every account", () => {
  it("each row says its account; the menu shows one account, and the choice is remembered", async () => {
    stubMailbox({}, { two: true });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    expect((await rowOf("Thijs Bakker")).querySelector(".macct")?.textContent).toMatch(/Work/);
    expect((await rowOf("Ines Vermaat")).querySelector(".macct")?.textContent).toMatch(/jules@orrama\.dev/);
    await user.click(screen.getByRole("button", { name: /Showing all accounts/ }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Work" }));
    await waitFor(() => expect(rows().map((r) => r.textContent?.includes("Thijs Bakker"))).toEqual([true]));
    // One account shown: rows no longer say it.
    expect(rows()[0]!.querySelector(".macct")).toBeNull();
    expect(localStorage.getItem("orrama-mail-account")).toBe("mail-2");
  });

  it("a message is read from its own account: Work's 101 is not the first account's 101", async () => {
    const { sent } = stubMailbox({}, { two: true });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await rowOf("Thijs Bakker"));
    expect(location.pathname).toBe("/mail/2.101");
    expect(await screen.findByText("Rev C is in the shared folder.")).toBeTruthy();
    expect(sent.some((r) => r.url === "/api/mail/message/101?account=mail-2")).toBe(true);
    expect(screen.getByText(/to you · Work/)).toBeTruthy();
    await user.click(await rowOf("Ines Vermaat"));
    // The default account's messages keep the address they always had.
    expect(location.pathname).toBe("/mail/101");
    expect(await screen.findByText("Thanks for the draft. Section 3 reads much better now.")).toBeTruthy();
    expect(sent.some((r) => r.url === "/api/mail/message/101?account=mail-1")).toBe(true);
  });

  it("a reply goes from the account the mail came to", async () => {
    const { sent } = stubMailbox({}, { two: true });
    history.replaceState(null, "", "/mail/2.101");
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await screen.findByText("Rev C is in the shared folder.");
    await user.click(screen.getByRole("button", { name: "Reply" }));
    expect(select("From").value).toBe("mail-2");
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Thanks.");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(sent.some((r) => r.url === "/api/mail/send")).toBe(true));
    expect(sent.find((r) => r.url === "/api/mail/send")!.body).toMatchObject({ to: "thijs@kade.example", inReplyTo: "<revc@kade.example>", account: "mail-2" });
  });

  it("new mail goes from the default, and From can change it", async () => {
    const { sent } = stubMailbox({}, { two: true });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await user.click(await screen.findByRole("button", { name: "Write" }));
    expect(select("From").value).toBe("mail-1");
    await user.selectOptions(select("From"), "mail-2");
    await user.type(screen.getByRole("textbox", { name: "To" }), "thijs@kade.example");
    await user.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(sent.some((r) => r.url === "/api/mail/send")).toBe(true));
    expect(sent.find((r) => r.url === "/api/mail/send")!.body).toMatchObject({ account: "mail-2" });
  });

  it("a staged draft says the account it goes from, and Send uses it", async () => {
    const staged = [{ ...DRAFTS[0]!, account: "mail-2" }];
    const { sent } = stubMailbox({ "GET /api/mail/drafts": () => json(staged) }, { two: true });
    history.replaceState(null, "", "/mail/waiting");
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const card = await screen.findByRole("article", { name: /Draft: Agenda for Friday's review/ });
    expect(card.textContent).toMatch(/From Work · To/);
    await user.click(within(card).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.some((r) => r.url === "/api/mail/send")).toBe(true));
    expect(sent.find((r) => r.url === "/api/mail/send")!.body).toMatchObject({ account: "mail-2" });
  });
});

describe("one account at a time", () => {
  it("a switch between accounts, the default first; rows don't say their account", async () => {
    localStorage.setItem("orrama-mail-inbox", "single");
    stubMailbox({}, { two: true });
    const user = userEvent.setup();
    render(<Mail me={me} />);
    const sw = await screen.findByRole("radiogroup", { name: "Account" });
    expect(within(sw).getByRole("radio", { checked: true }).textContent).toBe("jules@orrama.dev");
    await rowOf("Ines Vermaat");
    expect(rows().some((r) => r.textContent?.includes("Thijs Bakker"))).toBe(false);
    expect(document.querySelector(".macct")).toBeNull();
    expect(screen.queryByRole("button", { name: /Showing/ })).toBeNull();
    await user.click(within(sw).getByRole("radio", { name: "Work" }));
    await waitFor(() => expect(rows().map((r) => r.textContent?.includes("Thijs Bakker"))).toEqual([true]));
  });
});

describe("one account, as before", () => {
  it("no menu, no switch, no labels on rows, and the composer says From", async () => {
    stubMailbox();
    const user = userEvent.setup();
    render(<Mail me={me} />);
    await rowOf("Ines Vermaat");
    expect(document.querySelector(".macct")).toBeNull();
    expect(screen.queryByRole("button", { name: /Showing/ })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Account" })).toBeNull();
    expect(screen.getByText("Gmail")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Write" }));
    expect(screen.queryByRole("combobox", { name: "From" })).toBeNull();
    expect(screen.getByText("From jules@orrama.dev")).toBeTruthy();
  });
});

/**
 * Make a note (N1): one click writes the mail as a note (the server: mail-note.test.ts); the toast
 * offers Open, Undo and the project the mail may belong with, which is never chosen for you. A
 * mail already made into a note opens that note instead.
 */
describe("Make a note", () => {
  const made = { created: true, id: "n-quay", path: "Personal/jules/Quay drawings, rev C.md", title: "Quay drawings, rev C", projects: [{ slug: "quay", name: "Quay works" }] };

  it("asks for the note of this mail in its account; the toast's Open goes to it", async () => {
    const { sent } = stubMailbox({ "POST /api/mail/note": () => json(made) }, { two: true });
    history.replaceState(null, "", "/mail/2.101");
    const user = userEvent.setup();
    render(<Toaster />);
    render(<Mail me={me} />);
    await screen.findByText("Rev C is in the shared folder.");
    await user.click(screen.getByRole("button", { name: "Make a note" }));
    const t = await screen.findByText("Note made.");
    expect(sent.find((r) => r.url === "/api/mail/note")!.body).toEqual({ uid: 101, account: "mail-2" });
    // Nothing joins a project by itself.
    expect(sent.some((r) => r.url.startsWith("/api/projects/"))).toBe(false);
    const box = t.closest(".toast") as HTMLElement;
    expect([...box.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open", "Undo", "Add to Quay works", ""]);
    await user.click(within(box).getByRole("button", { name: "Open" }));
    expect(decodeURIComponent(location.pathname)).toBe("/notes/Personal/jules/Quay drawings, rev C.md");
  });

  it("Undo puts the note in the trash; Add to … adds it to that project", async () => {
    const { sent } = stubMailbox({ "POST /api/mail/note": () => json(made), "POST /api/vault/trash": () => json({ path: made.path, trashPath: `.trash/${made.path}` }), "POST /api/projects/quay/notes": () => json({ ok: true }) }, { two: true });
    history.replaceState(null, "", "/mail/2.101");
    const user = userEvent.setup();
    render(<Toaster />);
    render(<Mail me={me} />);
    await screen.findByText("Rev C is in the shared folder.");
    await user.click(screen.getByRole("button", { name: "Make a note" }));
    await user.click(within((await screen.findByText("Note made.")).closest(".toast") as HTMLElement).getByRole("button", { name: "Add to Quay works" }));
    await screen.findByText("Added to Quay works.");
    expect(sent.find((r) => r.url === "/api/projects/quay/notes")!.body).toEqual({ noteId: "n-quay" });
    await user.click(screen.getByRole("button", { name: "Make a note" }));
    await user.click(within((await screen.findByText("Note made.")).closest(".toast") as HTMLElement).getByRole("button", { name: "Undo" }));
    await screen.findByText("The note is in the trash.");
    expect(sent.find((r) => r.url === "/api/vault/trash")!.body).toEqual({ path: made.path });
  });

  it("a mail already made into a note opens that note", async () => {
    stubMailbox({ "POST /api/mail/note": () => json({ ...made, created: false, projects: [] }) }, { two: true });
    history.replaceState(null, "", "/mail/2.101");
    const user = userEvent.setup();
    render(<Toaster />);
    render(<Mail me={me} />);
    await screen.findByText("Rev C is in the shared folder.");
    await user.click(screen.getByRole("button", { name: "Make a note" }));
    await waitFor(() => expect(decodeURIComponent(location.pathname)).toBe("/notes/Personal/jules/Quay drawings, rev C.md"));
    expect(await screen.findByText("Opened the note made from this mail.")).toBeTruthy();
  });

  it("a note that couldn't be made says so, and the button works again", async () => {
    stubMailbox({ "POST /api/mail/note": () => json({ error: "internal error" }, 500) }, { two: true });
    history.replaceState(null, "", "/mail/2.101");
    const user = userEvent.setup();
    render(<Toaster />);
    render(<Mail me={me} />);
    await screen.findByText("Rev C is in the shared folder.");
    await user.click(screen.getByRole("button", { name: "Make a note" }));
    expect(await screen.findByText(/The note wasn't made\./)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Make a note" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
