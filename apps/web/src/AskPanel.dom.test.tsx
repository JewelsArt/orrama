/**
 * Ask Orr (structure.md §2.11), against a fake server that streams its answers chunk by chunk
 * (test/ask-fixture.ts).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serveAsk } from "./test/ask-fixture.js";

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
