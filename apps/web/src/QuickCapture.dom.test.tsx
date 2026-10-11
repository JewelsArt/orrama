/** Capture (`c`): one line into the inbox, as before, now a small sheet (structure.md §2.13). */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickCapture } from "./QuickCapture.js";
import { Toaster } from "./ui/overlays.js";

type Sent = { url: string; method: string; body: unknown };
let sent: Sent[] = [];
function serve(status = 200) {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return status === 200 ? Response.json({ id: "n-inbox", path: "Personal/jules/Inbox.md" }) : Response.json({ error: "the note could not be written" }, { status });
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/today");
});

const field = () => screen.getByRole("textbox", { name: "A task for your inbox" });

describe("Capture", () => {
  it("is a labelled dialog that writes the line into the inbox exactly as before, then says so", async () => {
    serve();
    const onClose = vi.fn();
    render(
      <>
        <QuickCapture onClose={onClose} />
        <Toaster />
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Capture" }).getAttribute("aria-modal")).toBe("true");
    fireEvent.change(field(), { target: { value: "  Call Ines due:2026-10-16  " } });
    fireEvent.submit(field().closest("form")!);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent).toEqual([{ url: "/api/capture", method: "POST", body: { text: "Call Ines due:2026-10-16" } }]);
    // The note it went to is one click away.
    const open = await screen.findByRole("button", { name: "Open" });
    await act(async () => fireEvent.click(open));
    expect(window.location.pathname).toBe("/notes/Personal/jules/Inbox");
  });

  it("sends nothing for an empty line, and just closes", async () => {
    serve();
    const onClose = vi.fn();
    render(<QuickCapture onClose={onClose} />);
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.submit(field().closest("form")!);
    expect(onClose).toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("keeps what you typed, and says why, when the server refuses it", async () => {
    serve(409);
    const onClose = vi.fn();
    render(<QuickCapture onClose={onClose} />);
    fireEvent.change(field(), { target: { value: "Buy stamps" } });
    fireEvent.submit(field().closest("form")!);
    expect(await screen.findByText(/Not saved/)).toBeTruthy();
    expect(field()).toHaveProperty("value", "Buy stamps");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    serve();
    const onClose = vi.fn();
    render(<QuickCapture onClose={onClose} />);
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
