/**
 * Addresses (structure.md §1.2): reload keeps your place, Back and Forward work, links work.
 * The screens are stubs (test/app-harness.tsx); this is the shell's routing alone.
 */
import "./test/app-harness.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { at, serve } from "./test/app-harness.js";

const view = async () => (await screen.findByTestId("view")).textContent!;
const path = () => location.pathname + location.search;
const back = async () => {
  await act(async () => {
    history.back();
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => serve());
// Unmount before the stubs go: a late request from the app must not reach happy-dom's real fetch.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("addresses", () => {
  it("opens / on Today, and writes it as /today", async () => {
    at("/");
    render(<App />);
    expect(await view()).toMatch(/^dashboard/);
    expect(path()).toBe("/today");
  });

  it("reload keeps your place: a project's address opens the project", async () => {
    at("/projects/thesis/timeline");
    render(<App />);
    expect(await view()).toMatch(/^project slug=thesis/);
  });

  it("a click goes to the thing's address, and the browser's Back comes back", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "open project" }));
    expect(path()).toBe("/projects/thesis");
    expect(await view()).toMatch(/^project slug=thesis/);
    await back();
    expect(path()).toBe("/today");
    expect(await view()).toMatch(/^dashboard/);
  });

  it("a note opened by its id gets its readable address once the tree knows its path", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "open note" }));
    await waitFor(() => expect(path()).toBe("/notes/04-Projects/thesis/Graduation%20thesis"));
    expect(await view()).toMatch(/noteId=n-1/);
  });

  it("an address by id (a link made before the path was known) is rewritten to the path", async () => {
    at("/notes?id=n-1");
    render(<App />);
    await waitFor(() => expect(path()).toBe("/notes/04-Projects/thesis/Graduation%20thesis"));
    expect(await view()).toMatch(/noteId=n-1/);
  });

  it("a note's address opens that note", async () => {
    at("/notes/04-Projects/thesis/Graduation%20thesis");
    render(<App />);
    await waitFor(async () => expect(await view()).toMatch(/noteId=n-1/));
  });

  it("Money's drill-down has addresses: a month of a category, a merchant, a page", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "open month" }));
    expect(path()).toBe("/money/spending/Groceries?month=2026-09");
    expect(await view()).toMatch(/category=Groceries month=2026-09/);
    await user.click(screen.getByRole("button", { name: "merchant UNIQLO" }));
    expect(path()).toBe("/money?merchant=UNIQLO");
    await user.click(screen.getByRole("button", { name: "page savings" }));
    expect(path()).toBe("/money/savings");
    await user.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(path()).toBe("/money?merchant=UNIQLO"));
  });

  it("a life area opens the Orrery zoomed to it", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "open area" }));
    expect(path()).toBe("/orrery?area=work");
    expect(await view()).toMatch(/category=work/);
  });

  it("Settings has an address and opens over the page you were on; closing goes back", async () => {
    const user = userEvent.setup();
    at("/projects/thesis");
    render(<App />);
    await screen.findByText(/^project/);
    act(() => void window.history.pushState({ depth: 1 }, "", "/settings/ai"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toEqual(["project", "settings"]);
    await user.click(screen.getByRole("button", { name: "close settings" }));
    await waitFor(() => expect(path()).toBe("/projects/thesis"));
  });

  it("an address this app does not know goes to Today", async () => {
    at("/dashboard");
    render(<App />);
    expect(await view()).toMatch(/^dashboard/);
    expect(path()).toBe("/today");
  });
});
