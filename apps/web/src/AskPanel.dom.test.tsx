/**
 * Ask Orr (structure.md §2.11), against a fake server that streams its answers chunk by chunk
 * (test/ask-fixture.ts).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answer, serveAsk, toolCall } from "./test/ask-fixture.js";

const { AskPanel } = await import("./AskPanel.js");
const { SESSION_ENDED, sessionOver, sessionStarted } = await import("./api.js");

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
    render(<AskPanel onClose={() => {}} />);
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
    const { unmount } = render(<AskPanel onClose={() => {}} />);
    await ask("Rewrite my research plan");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.signal?.aborted).toBe(false);
    unmount();
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("says so when the server stopped a run at its deadline", async () => {
    const calls = serveAsk();
    render(<AskPanel onClose={() => {}} />);
    await ask("Plan my whole year");
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.send({ type: "start" });
    calls[0]!.send({ type: "error", errorText: "The agent did not finish within 120 s, so it was stopped." });
    expect(await screen.findByText("The agent did not finish within 120 s, so it was stopped.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });
});

describe("an ended session (WEB-013)", () => {
  it("signs the app out from Ask Orr too, like any other request", async () => {
    serveAsk({ askStatus: 401 });
    sessionStarted();
    const ended = vi.fn();
    window.addEventListener(SESSION_ENDED, ended);
    try {
      render(<AskPanel onClose={() => {}} />);
      await ask("What's waiting on Thijs?");
      await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    } finally {
      window.removeEventListener(SESSION_ENDED, ended);
      sessionOver();
    }
  });
});

describe("the note you are on, and the notes Orr cites (AI-012)", () => {
  it("sends the open note with the question, so Orr can read what it links to", async () => {
    const calls = serveAsk();
    window.history.replaceState(null, "", "/notes/Shared/Weekly%20meetings");
    render(<AskPanel onClose={() => {}} />);
    await ask("What does this note depend on?");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.contextNoteId).toBe("n-weekly");
  });

  it("waits for the vault before taking a question, so the note is never left out", async () => {
    let release!: () => void;
    const calls = serveAsk({ treeAfter: new Promise<void>((r) => (release = r)) });
    window.history.replaceState(null, "", "/notes/Shared/Weekly%20meetings");
    render(<AskPanel onClose={() => {}} />);
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
    const { unmount } = render(<AskPanel onClose={() => {}} />);
    await ask("What's late?");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.contextNoteId).toBe("n-thesis");
    unmount();
    window.history.replaceState(null, "", "/today");
    render(<AskPanel onClose={() => {}} />);
    await ask("What's late?");
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.body.contextNoteId).toBeUndefined();
  });

  it("makes each [[citation]] a link that opens its thing, and leaves the panel open", async () => {
    const calls = serveAsk();
    const onClose = vi.fn();
    render(<AskPanel onClose={onClose} />);
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

describe("Ask Orr on its board", () => {
  it("shows his working as it happens, then folds it under the answer as names that open their things", async () => {
    const calls = serveAsk();
    render(<AskPanel onClose={() => {}} />);
    await ask("Who is involved with Thijs?");
    await waitFor(() => expect(calls).toHaveLength(1));
    const c = calls[0]!;
    c.send({ type: "start" });
    c.send({ type: "start-step" });
    toolCall(c, "t1", "get_relations", { entity: "Thijs Brouwer" });
    await waitFor(() => expect(screen.getByRole("status", { name: "Orr is working" }).textContent).toContain("Looking up everything connected to Thijs Brouwer"));
    c.send({ type: "tool-output-available", toolCallId: "t1", output: { entity: { id: "n-thijs", title: "Thijs Brouwer" }, relations: [{ relation: "works_at", to: [{ id: "n-kade", title: "Kade Social" }] }] } });
    c.send({ type: "finish-step" });
    c.send({ type: "start-step" });
    c.send({ type: "text-start", id: "a" });
    c.send({ type: "text-delta", id: "a", delta: "He works at [[Kade Social]]." });
    c.send({ type: "text-end", id: "a" });
    c.send({ type: "finish-step" });
    c.end();
    const how = await screen.findByRole("button", { name: "How I found this" });
    expect(screen.queryByRole("status", { name: "Orr is working" })).toBeNull();
    expect(how.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Looked up everything connected to Thijs Brouwer")).toBeTruthy();
    // The company it found opens the company, like the citation in the answer.
    const links = screen.getAllByRole("link", { name: "Kade Social" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/companies/kade-social", "/companies/kade-social"]);
    fireEvent.click(how);
    expect(screen.queryByText("Looked up everything connected to Thijs Brouwer")).toBeNull();
  });

  it("asks on Enter, and Shift-Enter is a new line", async () => {
    const calls = serveAsk();
    render(<AskPanel onClose={() => {}} />);
    const box = await screen.findByRole("textbox", { name: "Question" });
    await waitFor(() => expect(box).toHaveProperty("disabled", false));
    fireEvent.change(box, { target: { value: "First line" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls).toHaveLength(1));
  });

  it("without a model, says what he needs and leads to Settings; the field is closed", async () => {
    serveAsk({ configured: false });
    render(<AskPanel onClose={() => {}} />);
    expect(await screen.findByText("Orr needs a model to answer.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up Orr" }).getAttribute("href")).toBe("/settings/ai");
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveProperty("disabled", true);
    expect(document.body.textContent).not.toMatch(/workspace owner|your vault|Ask vault/);
  });

  it("keeps the conversation when the panel closes, and offers it again under Earlier questions", async () => {
    const calls = serveAsk();
    const first = render(<AskPanel onClose={() => {}} />);
    await ask("What's late on the thesis?");
    await waitFor(() => expect(calls).toHaveLength(1));
    answer(calls[0]!, "Two steps are late in [[Graduation thesis]].");
    await screen.findByRole("link", { name: "Graduation thesis" });
    first.unmount();

    // Opened again: the same conversation.
    const second = render(<AskPanel onClose={() => {}} />);
    expect(await screen.findByText("What's late on the thesis?")).toBeTruthy();
    // A new one starts empty; the earlier one is in the list, and picking it brings it back.
    fireEvent.click(screen.getByRole("button", { name: "Earlier questions" }));
    fireEvent.click(await screen.findByRole("button", { name: /New conversation/ }));
    await waitFor(() => expect(screen.queryByText("What's late on the thesis?")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Earlier questions" }));
    fireEvent.click(await screen.findByRole("button", { name: /What's late on the thesis\?/ }));
    expect(await screen.findByRole("link", { name: "Graduation thesis" })).toBeTruthy();
    second.unmount();
  });

  it("keeps a question you closed the panel on mid-answer", async () => {
    const calls = serveAsk();
    const first = render(<AskPanel onClose={() => {}} />);
    await ask("Summarise the thesis");
    await waitFor(() => expect(calls).toHaveLength(1));
    calls[0]!.send({ type: "start" });
    await screen.findByRole("button", { name: "Stop" });
    first.unmount();
    render(<AskPanel onClose={() => {}} />);
    expect(await screen.findByText("Summarise the thesis")).toBeTruthy();
  });

  it("on the phone, where the panel is the screen, steps aside when you go somewhere", async () => {
    const calls = serveAsk();
    const phone = vi.fn((q: string) => ({ matches: q.includes("760px"), media: q, addEventListener() {}, removeEventListener() {} }));
    vi.stubGlobal("matchMedia", phone);
    const onClose = vi.fn();
    render(<AskPanel onClose={onClose} />);
    await ask("Open Weekly meetings");
    await waitFor(() => expect(calls).toHaveLength(1));
    answer(calls[0]!, "Here: [[Weekly meetings]].");
    fireEvent.click(await screen.findByRole("link", { name: "Weekly meetings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

