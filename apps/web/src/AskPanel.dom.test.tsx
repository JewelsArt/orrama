/**
 * Ask Orr (structure.md §2.11), against a fake server that streams its answers chunk by chunk
 * (test/ask-fixture.ts).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answer, serveAsk } from "./test/ask-fixture.js";

const { AskPanel } = await import("./AskPanel.js");

beforeEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/today");
});

async function ask(text: string) {
  const box = await screen.findByRole("textbox", { name: /question/i });
  await waitFor(() => expect(box).not.toHaveProperty("disabled", true));
  fireEvent.change(box, { target: { value: text } });
  fireEvent.submit(box.closest("form")!);
}

describe("a run stops when you stop it (AI-006, the web half)", () => {
  it("Stop ends the run Orr is in the middle of", async () => {
    const calls = serveAsk();
    render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    await ask("What's waiting on Thijs?");
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.send({ type: "start" });
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(calls[0]!.signal?.aborted).toBe(false);
    await act(async () => fireEvent.click(stop));
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("closing the panel ends the run too: nothing keeps working for a panel nobody sees", async () => {
    const calls = serveAsk();
    const { unmount } = render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    await ask("Rewrite my research plan");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.signal?.aborted).toBe(false);
    unmount();
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("says so when the server stopped a run at its deadline", async () => {
    const calls = serveAsk();
    render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    await ask("Plan my whole year");
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.send({ type: "start" });
    calls[0]!.send({ type: "error", errorText: "The agent did not finish within 120 s, so it was stopped." });
    expect(await screen.findByText("The agent did not finish within 120 s, so it was stopped.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("the note you are on, and the notes Orr cites (AI-012)", () => {
  it("sends the open note with the question, so Orr can read what it links to", async () => {
    const calls = serveAsk();
    window.history.replaceState(null, "", "/notes/Shared/Weekly%20meetings");
    render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    await ask("What does this note depend on?");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.contextNoteId).toBe("n-weekly");
  });

  it("waits for the vault before taking a question, so the note is never left out", async () => {
    let release!: () => void;
    const calls = serveAsk({ treeAfter: new Promise<void>((r) => (release = r)) });
    window.history.replaceState(null, "", "/notes/Shared/Weekly%20meetings");
    render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    const box = await screen.findByRole("textbox", { name: /question/i });
    await new Promise((r) => setTimeout(r, 30));
    expect(box).toHaveProperty("disabled", true);
    await act(async () => release());
    await ask("And this one?");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.contextNoteId).toBe("n-weekly");
  });

  it("sends a project's own note from its page, and nothing from a page about no note", async () => {
    const calls = serveAsk();
    window.history.replaceState(null, "", "/projects/graduation-thesis/timeline");
    const { unmount } = render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    await ask("What's late?");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.contextNoteId).toBe("n-thesis");
    unmount();
    window.history.replaceState(null, "", "/today");
    render(<AskPanel onClose={() => {}} onOpenNote={() => {}} />);
    await ask("What's late?");
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body.contextNoteId).toBeUndefined();
  });

  it("makes each [[citation]] a link that opens its thing, and leaves the panel open", async () => {
    const calls = serveAsk();
    const onClose = vi.fn();
    render(<AskPanel onClose={onClose} onOpenNote={() => {}} />);
    await ask("What's waiting on Thijs?");
    await waitFor(() => expect(calls).toHaveLength(1));
    answer(calls[0]!, "Three things wait on [[Thijs Brouwer]] for [[Graduation thesis]], from [[Weekly meetings|your notes]]. [[Nowhere]] is not a note.");
    const person = await screen.findByRole("link", { name: "Thijs Brouwer" });
    expect(person.getAttribute("href")).toBe("/people/thijs-brouwer");
    expect(screen.getByRole("link", { name: "Graduation thesis" }).getAttribute("href")).toBe("/projects/graduation-thesis");
    const note = screen.getByRole("link", { name: "your notes" });
    expect(note.getAttribute("href")).toBe("/notes/Shared/Weekly%20meetings");
    // A citation of nothing Orr or the vault knows is text, not a link that leads nowhere.
    expect(screen.queryByRole("link", { name: "Nowhere" })).toBeNull();
    expect(screen.getByText(/Nowhere/)).toBeTruthy();
    fireEvent.click(note);
    expect(window.location.pathname).toBe("/notes/Shared/Weekly%20meetings");
    expect(onClose).not.toHaveBeenCalled();
  });
});

