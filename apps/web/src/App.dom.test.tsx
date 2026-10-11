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

describe("the shell", () => {
  it("lists the eight places in order, then Find, Ask Orr and your Orr; no Reload, Dark or Back", async () => {
    at("/today");
    render(<App />);
    await view();
    const rail = screen.getAllByRole("navigation", { name: "Places" })[0]!;
    const items = [...rail.querySelectorAll(".ri")].map((e) => e.textContent);
    expect(items).toEqual(["Today", "Planning", "Notes", "Orrery", "Projects", "People", "Mail", "Money", "Find", "Ask Orr"]);
    expect(rail.textContent).not.toMatch(/Reload|Dark|Light|Back|your vault|Ask vault/);
    expect(rail.querySelector("kbd, .kbd, .rail-kbd")).toBeNull(); // keys live in tooltips (§8 #5)
    expect(rail.querySelector(".ri[data-tip]")?.getAttribute("data-tip")).toBe("Today  1");
    expect(screen.getByRole("link", { name: "Jules: Settings" })).toBeTruthy();
  });

  it("lights the place you are in, and its address is the rail's link", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await view();
    const rail = screen.getAllByRole("navigation", { name: "Places" })[0]!;
    const projects = [...rail.querySelectorAll<HTMLAnchorElement>(".ri")].find((a) => a.textContent === "Projects")!;
    expect(projects.getAttribute("href")).toBe("/projects");
    await user.click(projects);
    expect(path()).toBe("/projects");
    expect(projects.getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Projects · Orrama");
  });

  it("your Orr opens Settings → You", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await view();
    await user.click(screen.getByRole("link", { name: "Jules: Settings" }));
    expect(path()).toBe("/settings/you");
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toEqual(["dashboard", "settings"]);
  });

  it("on the phone, More holds the other places and Settings, with your Orr on top", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await view();
    await user.click(screen.getByRole("button", { name: /^More/ }));
    const more = screen.getByRole("dialog", { name: "More" });
    expect([...more.querySelectorAll(".more-row")].map((e) => e.textContent)).toEqual(["Orrery", "Projects", "People", "Mail", "Money", "Settings"]);
    expect(more.querySelector(".more-me")?.textContent).toMatch(/Jules/);
    await user.click([...more.querySelectorAll<HTMLElement>(".more-row")].find((e) => e.textContent === "Money")!);
    expect(path()).toBe("/money");
    expect(screen.queryByRole("dialog", { name: "More" })).toBeNull();
  });

  it("the phone's top bar has Back only on a page deeper than its tab", async () => {
    at("/projects");
    const { unmount } = render(<App />);
    await view();
    expect(document.querySelector(".ptop .back")).toBeNull();
    unmount();
    at("/projects/thesis");
    render(<App />);
    await view();
    expect(document.querySelector(".ptop .back")).not.toBeNull();
    expect(document.querySelector(".ptop h1")?.textContent).toBe("Thesis");
  });

  it("says Orrama while it boots", async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/me" ? new Promise<Response>((r) => (answer = r)) : new Response(JSON.stringify({ needsSetup: false }), { status: 200 }),
    );
    at("/today");
    render(<App />);
    expect(screen.getByRole("img", { name: "Orrama" })).toBeTruthy();
    answer(new Response("{}", { status: 401 }));
  });

  it("shows the update note after a ship, and only then", async () => {
    let build = "aaa";
    serve();
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) =>
      url === "/api/health" ? new Response(JSON.stringify({ ok: true, notes: 1, build }), { status: 200 }) : base(url, init),
    );
    at("/today");
    render(<App />);
    await view();
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.queryByText("Update ready")).toBeNull();
    build = "bbb"; // pnpm ship
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getAllByText("Update ready").length).toBeGreaterThan(0);
  });
});
