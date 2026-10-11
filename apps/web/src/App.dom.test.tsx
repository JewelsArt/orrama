/**
 * Addresses (structure.md §1.2): reload keeps your place, Back and Forward work, links work.
 * The screens are stubs (test/app-harness.tsx); this is the shell's routing alone.
 */
import "./test/app-harness.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, routeOfView } from "./App.js";
import { routeHref } from "./ui/router.js";
import { at, crash, ME, mounted, serve } from "./test/app-harness.js";
import { dismissToast, toast, topLayer } from "./ui/overlays.js";

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
    expect(await view()).toMatch(/^today/);
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
    expect(await view()).toMatch(/^today/);
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
    at("/money");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "month Groceries" }));
    expect(path()).toBe("/money/spending/Groceries?month=2026-09");
    expect(await view()).toMatch(/category=Groceries month=2026-09/);
    await user.click(screen.getByRole("button", { name: "merchant UNIQLO" }));
    expect(path()).toBe("/money/spending?merchant=UNIQLO");
    expect(await view()).toMatch(/^money page=spending merchant=UNIQLO/);
    await user.click(screen.getByRole("button", { name: "page savings" }));
    expect(path()).toBe("/money/savings");
    await user.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => expect(path()).toBe("/money/spending?merchant=UNIQLO"));
  });

  it("a whole month opened from elsewhere is that month's page under Spending, not the overview", () => {
    expect(routeHref(routeOfView({ kind: "finance", month: "2026-09" }))).toBe("/money/spending?month=2026-09");
    expect(routeHref(routeOfView({ kind: "finance", month: "2026-09", category: "Groceries" }))).toBe("/money/spending/Groceries?month=2026-09");
  });

  it("a life area opens the Orrery zoomed to it", () => {
    expect(routeHref(routeOfView({ kind: "architecture", category: "work" }))).toBe("/orrery?area=work");
  });

  it("Settings is a page at its address, with its section; Back returns to where you were", async () => {
    at("/projects/thesis");
    render(<App />);
    await screen.findByText(/^project/);
    act(() => void window.history.pushState({ depth: 1 }, "", "/settings/ai"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toEqual(["settings"]);
    expect(await view()).toMatch(/section=ai/);
    expect(document.title).toBe("Orr & AI · Orrama");
    act(() => void window.history.replaceState({ depth: 0 }, "", "/projects/thesis"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toEqual(["project"]);
  });

  it("a project's tab is its address, and moving between tabs keeps the same page (R8)", async () => {
    at("/projects/thesis/timeline");
    render(<App />);
    expect(await view()).toMatch(/^project slug=thesis tab=timeline/);
    const before = mounted.project;
    act(() => void window.history.pushState({ depth: 1 }, "", "/projects/thesis/todo"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await view()).toMatch(/^project slug=thesis tab=todo/);
    act(() => void window.history.pushState({ depth: 2 }, "", "/projects/thesis"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await view()).toMatch(/^project slug=thesis tab=overview/);
    // The page, its loaded workspace and its scroll stay; only the tab changes.
    expect(mounted.project).toBe(before);
  });

  it("the Projects board's area filter is in its address (R8)", async () => {
    at("/projects?area=school");
    render(<App />);
    expect(await view()).toMatch(/^overview area=school/);
  });

  it("the old Completed and Archived shelf addresses open Done (F1)", async () => {
    at("/projects?area=school&shelf=archived");
    render(<App />);
    expect(await view()).toMatch(/^overview area=school/);
    expect(path()).toBe("/projects?area=school&shelf=done");
  });

  it("opening a shelf or picking an area keeps the board mounted (F1)", async () => {
    at("/projects");
    render(<App />);
    await view();
    const before = mounted.overview;
    act(() => void window.history.pushState({ depth: 1 }, "", "/projects?shelf=done"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    act(() => void window.history.pushState({ depth: 2 }, "", "/projects?area=work&shelf=done"));
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate")));
    expect(await view()).toMatch(/^overview area=work/);
    expect(mounted.overview).toBe(before);
  });

  it("an address this app does not know goes to Today", async () => {
    at("/dashboard");
    render(<App />);
    expect(await view()).toMatch(/^today/);
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
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toEqual(["settings"]);
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

  it("on the phone, a Settings section's Back goes to the list of sections", async () => {
    const user = userEvent.setup();
    at("/settings/connections");
    render(<App />);
    await view();
    expect(screen.getByRole("heading", { level: 1, name: "Connections" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(path()).toBe("/settings");
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

describe("keys", () => {
  const field = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    return host;
  };

  it("⌘← and ⌘[ in a field, a textarea or the editor stay there; on the page ⌘[ goes back (WEB-003)", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "open project" }));
    expect(path()).toBe("/projects/thesis");
    const host = field('<input aria-label="title"><textarea aria-label="body"></textarea><div class="cm-editor"><div class="cm-content" contenteditable="true">x</div></div>');
    for (const el of [host.querySelector("input")!, host.querySelector("textarea")!, host.querySelector(".cm-content")!]) {
      (el as HTMLElement).focus();
      fireEvent.keyDown(el, { key: "ArrowLeft", metaKey: true });
      fireEvent.keyDown(el, { key: "[", metaKey: true });
      expect(path()).toBe("/projects/thesis");
    }
    host.remove();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "[", metaKey: true });
    await waitFor(() => expect(path()).toBe("/today"));
  });

  it("the number keys open the eight places, in rail order", async () => {
    at("/today");
    render(<App />);
    await view();
    const seen: string[] = [];
    for (const key of ["2", "3", "4", "5", "6", "7", "8", "1"]) {
      fireEvent.keyDown(document.body, { key });
      seen.push(path());
    }
    expect(seen).toEqual(["/planning/week", "/notes", "/orrery", "/projects", "/people", "/mail", "/money", "/today"]);
  });

  it("? lists every key; the shell's keys stand down while it is open", async () => {
    at("/today");
    render(<App />);
    await view();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const sheet = screen.getByRole("dialog", { name: "Keys" });
    expect(sheet.textContent).toMatch(/Find/);
    fireEvent.keyDown(document.body, { key: "5" });
    expect(path()).toBe("/today");
  });

  it("⌘K opens Find, ⌘J Ask Orr, c capture, ⌘, Settings", async () => {
    at("/today");
    render(<App />);
    await view();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toContain("search");
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyDown(document.body, { key: "j", metaKey: true });
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toContain("ask");
    fireEvent.keyDown(document.body, { key: "c" });
    expect(screen.getAllByTestId("view").map((v) => v.dataset.view)).toContain("capture");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    expect(path()).toBe("/settings");
  });
});

describe("overlays (WEB-018)", () => {
  const open = () => screen.queryAllByTestId("view").map((v) => v.dataset.view);

  it("Find and Capture are labelled dialogs and Escape closes each; ⌘, opens the Settings page", async () => {
    at("/today");
    render(<App />);
    await view();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Find" }).getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(open()).not.toContain("search");
    fireEvent.keyDown(document.body, { key: "c" });
    expect(screen.getByRole("dialog", { name: "Capture" }).getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(open()).not.toContain("capture");
    fireEvent.keyDown(document.body, { key: ",", metaKey: true });
    expect(open()).toEqual(["settings"]);
    expect(path()).toBe("/settings");
    expect(screen.queryByRole("dialog")).toBeNull(); // a page, not a modal (§3)
  });

  it("⌘K from Settings opens Find over it, and Escape closes Find alone", async () => {
    at("/settings/you");
    render(<App />);
    await screen.findByText(/^settings/);
    fireEvent.keyDown(document.activeElement!, { key: "k", metaKey: true });
    expect(topLayer()?.kind).toBe("palette");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(open()).not.toContain("search");
    expect(open()).toContain("settings");
    expect(path()).toBe("/settings/you");
  });

  it("what Settings opens goes over it, not in its place", async () => {
    const user = userEvent.setup();
    at("/settings/you");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "edit a profile" }));
    expect(screen.getByRole("dialog", { name: "Edit colour profile" })).toBeTruthy();
    expect(open()).toContain("settings");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Edit colour profile" })).toBeNull();
    expect(open()).toContain("settings");
    await user.keyboard("{Escape}");
    expect(open()).toEqual(["settings"]); // the page stays: Escape is for what floats
    expect(path()).toBe("/settings/you");
  });

  it("toasts show in the app: the shell mounts the one place they appear", async () => {
    at("/today");
    render(<App />);
    await view();
    let id = 0;
    act(() => void (id = toast("Moved to Friday")));
    expect(screen.getByRole("status").textContent).toContain("Moved to Friday");
    act(() => dismissToast(id));
  });

  it("closing Find gives focus back to what opened it", async () => {
    const user = userEvent.setup();
    at("/today");
    render(<App />);
    await view();
    const find = screen.getAllByRole("button", { name: /^Find/ })[0]!;
    await user.click(find);
    expect(screen.getByRole("dialog", { name: "Find" }).contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(find);
  });

  it("Ask sits beside the page: the keys still work, and Escape closes it only from inside it", async () => {
    at("/today");
    render(<App />);
    await view();
    const onPage = screen.getByRole("button", { name: "open note" });
    onPage.focus();
    fireEvent.keyDown(onPage, { key: "j", metaKey: true });
    expect(open()).toContain("ask");
    expect(document.activeElement).toBe(onPage); // opening it leaves you where you were
    fireEvent.keyDown(document.body, { key: "2" });
    expect(path()).toBe("/planning/week");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(open()).toContain("ask");
    const inside = screen.getByRole("button", { name: "close ask" });
    inside.focus();
    fireEvent.keyDown(inside, { key: "Escape" });
    expect(open()).not.toContain("ask");
  });
});

describe("the theme (§9)", () => {
  const html = document.documentElement;
  afterEach(() => html.removeAttribute("data-theme"));

  /** A system whose dark mode can change while the app is open; returns the switch. */
  function system(dark: boolean) {
    const state = { dark };
    const heard = new Set<() => void>();
    const query = { get matches() { return state.dark; }, addEventListener: (_: string, f: () => void) => heard.add(f), removeEventListener: (_: string, f: () => void) => heard.delete(f) };
    vi.stubGlobal("matchMedia", (q: string) => (q === "(prefers-color-scheme: dark)" ? query : { matches: false, addEventListener() {}, removeEventListener() {} }));
    return (next: boolean) =>
      act(() => {
        state.dark = next;
        for (const f of heard) f();
      });
  }

  /** What the app sends to the account. */
  function patches() {
    const sent: { appearance?: { theme?: string } }[] = [];
    const answer = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
      if (init.method === "PATCH") sent.push(JSON.parse(String(init.body)));
      return answer(url, init);
    });
    return sent;
  }

  it("shows the theme this device showed last from the first render, before the account answers", () => {
    system(false);
    localStorage.setItem("basalt-theme", "command");
    at("/today");
    render(<App />);
    expect(html.dataset.theme).toBe("dark");
  });

  it("Match this device follows the system as it changes, and leaves the account's theme alone", async () => {
    const user = userEvent.setup();
    const flip = system(true);
    serve({ "GET /api/me": { ...ME, appearance: { theme: "light", vision: "none", profiles: [] } } });
    const sent = patches();
    at("/settings/you");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "theme match" }));
    expect(html.dataset.theme).toBe("dark");
    expect(localStorage.getItem("basalt-theme-device")).toBe("match");
    flip(false);
    expect(html.dataset.theme).toBe("light");
    flip(true);
    expect(html.dataset.theme).toBe("dark");
    expect(sent.filter((b) => b.appearance)).toEqual([]); // the account still says light

    await user.click(screen.getByRole("button", { name: "theme light" }));
    expect(html.dataset.theme).toBe("light");
    expect(localStorage.getItem("basalt-theme-device")).toBeNull();
    flip(false);
    flip(true);
    expect(html.dataset.theme).toBe("light"); // no longer following the system
  });

  it("Dark is the account's: it goes up as the server's word for it", async () => {
    const user = userEvent.setup();
    system(false);
    serve({ "GET /api/me": { ...ME, appearance: { theme: "light", vision: "none", profiles: [] } } });
    const sent = patches();
    at("/settings/you");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "theme dark" }));
    expect(html.dataset.theme).toBe("dark");
    await waitFor(() => expect(sent.map((b) => b.appearance?.theme)).toContain("command"));
    expect(localStorage.getItem("basalt-theme")).toBe("command");
  });
});

describe("when a page breaks (WEB-011)", () => {
  afterEach(() => crash.clear());

  it("the page says so, the rail still works, and the next place renders", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    crash.add("planning");
    at("/planning/week");
    render(<App />);
    expect(await screen.findByText("This page hit an error.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    const rail = screen.getAllByRole("navigation", { name: "Places" })[0]!;
    await user.click([...rail.querySelectorAll<HTMLElement>(".ri")].find((a) => a.textContent === "Projects")!);
    expect(await view()).toMatch(/^overview/);
    crash.clear();
    await user.click([...rail.querySelectorAll<HTMLElement>(".ri")].find((a) => a.textContent === "Planning")!);
    expect(await view()).toMatch(/^planning/); // a fresh boundary: the page renders again
    vi.restoreAllMocks();
  });

  it("Settings breaking stays in its page, and the rail still works", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    crash.add("settings");
    at("/settings/ai");
    render(<App />);
    expect(await screen.findByText("Settings hit an error.")).toBeTruthy();
    const rail = screen.getAllByRole("navigation", { name: "Places" })[0]!;
    await user.click([...rail.querySelectorAll<HTMLElement>(".ri")].find((a) => a.textContent === "Today")!);
    expect(await view()).toMatch(/^today/);
    vi.restoreAllMocks();
  });

  it("⌘R reloads from outside React", async () => {
    const { installReloadKey } = await import("./ui/reloadKey.js");
    const reload = vi.fn();
    const off = installReloadKey(window, reload);
    fireEvent.keyDown(document.body, { key: "r", metaKey: true });
    fireEvent.keyDown(document.body, { key: "R", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "r" });
    expect(reload).toHaveBeenCalledTimes(2);
    off();
  });
});
