/**
 * Notes is one page whichever note it shows (WEB-024, R7). App keys its error boundary on the
 * address, so going from one note to the next remounted the whole Notes screen — its tree, its
 * filter, the open editor — and refetched the vault. Notes' addresses share one key.
 */
import "./test/app-harness.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { at, serve } from "./test/app-harness.js";
import { navigate } from "./ui/router.js";

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("moving between notes", () => {
  it("keeps the Notes page mounted, and still remounts it for another place", async () => {
    at("/notes/04-Projects/thesis/Graduation%20thesis");
    render(<App />);
    const first = await screen.findByTestId("view");
    expect(first.dataset.view).toBe("architecture");
    await act(async () => navigate({ kind: "notes", path: "Inbox/Other" }));
    expect(screen.getByTestId("view")).toBe(first);
    await act(async () => navigate({ kind: "notes" }));
    expect(screen.getByTestId("view")).toBe(first);
    expect(first.textContent).not.toContain("notePath");
    await act(async () => navigate({ kind: "planning", scale: "week" }));
    expect(screen.getByTestId("view")).not.toBe(first);
  });

  it("hands Notes the path the address names", async () => {
    at("/notes/Inbox/Just%20made");
    render(<App />);
    expect((await screen.findByTestId("view")).textContent).toContain("notePath=Inbox/Just made");
  });
});
