/**
 * People inside the App: its own addresses — a person, a company, a search typed into ?q= —
 * are one page, not a new one each time. Keyed by the full address, the page was thrown away
 * and rebuilt on every keystroke of the search (focus and the loaded lists gone with it).
 */
import "../test/app-harness.js";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.js";
import { at, serve } from "../test/app-harness.js";
import { navigate } from "../ui/router.js";

beforeEach(() => serve());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("People in the App", () => {
  it("stays the same page across its own addresses, and only those", async () => {
    const user = userEvent.setup();
    at("/people");
    render(<App />);
    const draft = (await screen.findByRole("textbox", { name: "people draft" })) as HTMLInputElement;
    await user.type(draft, "kept");
    for (const to of ["/people?q=ines", "/people/ines-vermaat", "/companies/kade-social", "/people?sector=University"]) {
      act(() => navigate(to));
      expect(screen.getByRole("textbox", { name: "people draft" })).toBe(draft);
      expect(draft.value).toBe("kept");
    }
    act(() => navigate("/mail"));
    act(() => navigate("/people"));
    expect((screen.getByRole("textbox", { name: "people draft" }) as HTMLInputElement).value).toBe("");
  });
});
