/**
 * Mail's composer and the drafts Orr stages (WEB-006). Opening a second staged draft while the
 * composer was open kept the first draft's text under the second draft's id and headers: Send
 * mailed A's words threaded to B's message, deleted B unsent, and left A waiting to go twice.
 * And reading another message while writing threw the reply away without asking.
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "./api.js";
import { Mail } from "./Mail.js";
import { stubMailbox } from "./test/mail-fixture.js";

const me = { id: "u1", email: "jules@basalt.dev", displayName: "Jules" } as unknown as Me;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The staged draft's row in "Waiting for you", by its subject. */
const draftRow = async (subject: string) => (await screen.findByText(subject, { selector: ".mail-pending-subject" })).closest("button")!;
const composer = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const field = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;

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
    await user.click(screen.getByText("Camille Dubois"));
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
    await user.click(screen.getByText("Camille Dubois"));
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
    await user.click(screen.getByText("Camille Dubois"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => {});
    expect(await screen.findByText("One question about BE reach before Friday.")).toBeTruthy();
  });
});
