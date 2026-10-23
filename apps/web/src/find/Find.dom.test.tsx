/**
 * Find (⌘K; structure.md §2.12): typed results in groups, keyboard first. Arrows move, Enter
 * opens; a project opens the project, not its note; Tab and a typed type narrow; settings by
 * name; actions run; empty shows Recent and the places; nothing found says so. Fictional data.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as { method: string; url: string; body: unknown }[], hits: [] as { id: string; path: string; title: string }[] }));
vi.mock("../ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));

const contact = (id: string, name: string, company: string, role = "", companyId: string | null = null) => ({ id, name, path: `Contacts/${name}.md`, sector: "", role, company, companyId, email: "", phone: "", linkedin: "", personal: false });
vi.mock("../api.js", async (orig) => {
  const real = await orig<typeof import("../api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      server.calls.push({ method, url, body });
      const path = url.replace(/\?.*$/, "");
      if (method === "PUT" && path === "/api/vault/note") return { id: "n-new", path: (body as { path: string }).path };
      switch (path) {
        case "/api/contacts":
          return [contact("n-thijs", "Thijs Brouwer", "[[Kade Social]]", "Data lead", "n-kade"), contact("n-ines", "Ines Vermaat", "[[Westerdok]]", "Thesis supervisor")];
        case "/api/companies":
          return [{ id: "n-kade", name: "Kade Social", path: "Contacts/Companies/Kade Social.md", description: "Social-media agency", sector: "", linkedin: "", website: "", careers: "", location: "", positions: [], personal: false }];
        case "/api/projects":
          return [{ slug: "graduation-thesis", key: "project/graduation-thesis", name: "Graduation thesis", domain: null, noteId: "n-thesis", total: 4, done: 1, status: "on-track", start: null, deadline: null, group: null, nextDue: null, overdue: 0 }];
        case "/api/vault/graph":
          return { nodes: [], edges: [] };
        case "/api/vault/tree":
          return [{ id: "n-off", path: "Personal/Kade offsite.md", folder: "Personal", title: "Kade offsite", hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category: "personal" }];
        case "/api/people/context":
          return { typed: false, entries: [] };
        case "/api/vault/search":
          return server.hits;
      }
      return [];
    },
  };
});

const { Find } = await import("./Find.js");
const me = { id: "u-1", username: "jules", email: "jules@orrama.dev", displayName: "Jules", isOwner: true } as never;

let props: { onClose: ReturnType<typeof vi.fn>; onTheme: ReturnType<typeof vi.fn>; onCapture: ReturnType<typeof vi.fn>; onAsk: ReturnType<typeof vi.fn> };
beforeEach(() => {
  server.calls = [];
  server.hits = [];
  localStorage.clear();
  history.replaceState(null, "", "/today");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  props = { onClose: vi.fn(), onTheme: vi.fn(), onCapture: vi.fn(), onAsk: vi.fn() };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const open = async () => {
  render(<Find me={me} shown="light" {...props} />);
  // The lists have answered (each answer can start the next).
  for (let i = 0; i < 6; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const field = () => screen.getByRole("combobox", { name: "Find" });
const type = async (q: string) => {
  fireEvent.change(field(), { target: { value: q } });
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  await act(async () => {});
};
const key = async (k: string, shift = false) => {
  fireEvent.keyDown(field(), { key: k, shiftKey: shift });
  await act(async () => {});
};
const groups = () => screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
const options = () => screen.getAllByRole("option").map((o) => o.querySelector(".x .t")!.textContent);
const selected = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")!;

describe("Find", () => {
  it("is a palette called Find; empty, it offers the places and things to do", async () => {
    await open();
    expect(screen.getByRole("dialog", { name: "Find" })).toBeTruthy();
    expect(groups()).toEqual(["Places", "Actions"]);
    expect(options().slice(0, 8)).toEqual(["Today", "Planning", "Notes", "Orrery", "Projects", "People", "Mail", "Money"]);
  });

  it("types and groups what it finds: the company first, then who works there and its notes", async () => {
    server.hits = [{ id: "n-off", path: "Personal/Kade offsite.md", title: "Kade offsite" }];
    await open();
    await type("kade");
    expect(groups()).toEqual(["Companies", "People", "Notes and conversations", "Actions"]);
    expect(options()).toEqual(["Kade Social", "Thijs Brouwer", "Kade offsite", "Show Kade Social in the Orrery"]);
    expect(selected().textContent).toContain("Company");
    expect(screen.getByText("1 at Kade Social")).toBeTruthy();
  });

  it("arrows move, Enter opens: a project opens the project page, and is remembered", async () => {
    await open();
    await type("thesis");
    expect(options()[0]).toBe("Graduation thesis");
    expect(selected().textContent).toContain("opens the project");
    await key("Enter");
    expect(location.pathname).toBe("/projects/graduation-thesis");
    expect(props.onClose).toHaveBeenCalled();
    cleanup();
    await open();
    expect(groups()[0]).toBe("Recent");
    expect(options()[0]).toBe("Graduation thesis");
  });

  it("Tab narrows to a type, and a type typed first does too", async () => {
    await open();
    await key("Tab");
    expect(screen.getByRole("button", { name: /Type: Person/ })).toBeTruthy();
    expect(groups()).toEqual(["People"]);
    expect(options()).toEqual(["Ines Vermaat", "Thijs Brouwer"]);
    await key("Tab", true);
    expect(screen.getByRole("button", { name: /Type: any/ })).toBeTruthy();
    await type("person ines");
    expect(options()).toEqual(["Ines Vermaat"]);
    await key("ArrowDown");
    await key("Enter");
    expect(location.pathname).toBe("/people/ines-vermaat");
  });

  it("finds a setting by what it does, and opens its section", async () => {
    await open();
    await type("dark");
    const settings = screen.getByRole("group", { name: "Settings" });
    fireEvent.click(within(settings).getAllByRole("option")[0]!);
    expect(location.pathname).toBe("/settings/appearance");
  });

  it("actions run: Switch to dark, New task, Ask Orr", async () => {
    await open();
    await type("switch to dark");
    await key("Enter");
    expect(props.onTheme).toHaveBeenCalledWith("dark");
    cleanup();
    await open();
    await type("new task");
    await key("Enter");
    expect(props.onCapture).toHaveBeenCalled();
  });

  it("New note asks for a name and creates it create-only, then opens it", async () => {
    await open();
    await type("new note");
    await key("Enter");
    const dialog = screen.getByRole("dialog", { name: "New note" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Ideas/Reading list" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    });
    expect(server.calls.filter((c) => c.method !== "GET")).toEqual([{ method: "PUT", url: "/api/vault/note", body: expect.objectContaining({ path: "Ideas/Reading list.md", create: true }) }]);
    expect(location.search).toBe("?id=n-new");
  });

  it("the server's own filters still work, as notes", async () => {
    server.hits = [{ id: "n-off", path: "Personal/Kade offsite.md", title: "Kade offsite" }];
    await open();
    await type("tag:offsite");
    expect(server.calls.some((c) => c.url === "/api/vault/search?q=tag%3Aoffsite")).toBe(true);
    expect(groups()).toEqual(["Notes and conversations"]);
    expect(options()).toEqual(["Kade offsite"]);
  });

  it("nothing found: Orr shrugs, and Ask Orr is one click", async () => {
    await open();
    await type("zzqx");
    expect(screen.getByText("Nothing called “zzqx”.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask Orr instead" }));
    expect(props.onAsk).toHaveBeenCalled();
  });
});
