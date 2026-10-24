/**
 * The Projects board after Jules's answers to R8 (F1, 11 October).
 *
 * No summary of today at the top: no board draws it and Today already says what's due, so the
 * page neither offers it nor asks whether a model is set up. Finished work is one shelf, Done:
 * a project whose status is completed or archived (or whose every step is ticked) sits on it,
 * newest first, and the shelf opens at its own address. The notes' statuses are never written.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AREAS_REPLY } from "./test/areas.js";

const server = vi.hoisted(() => ({
  calls: [] as string[],
  writes: [] as { method: string; url: string; body: unknown }[],
  /** `/api/admin/projects/hidden`: removed from the board (owners). */
  hidden: [] as { id: string; slug: string; name: string }[],
}));

const project = (slug: string, status: string, over: Record<string, unknown> = {}) => ({
  project: slug,
  projectId: `p-${slug}`,
  slug,
  status,
  total: 2,
  done: 1,
  assignees: [],
  domain: "professional",
  tasks: [],
  ...over,
});
const DASHBOARD = {
  team: null,
  projects: [
    project("brand-refresh", "on-track"),
    project("cv-v4", "completed", { lastActivityMs: 100 }),
    project("summer-report", "archived", { lastActivityMs: 300 }),
    project("literature-review", "on-track", { total: 2, done: 2, lastActivityMs: 200, domain: "academic" }),
    project("thai-cooking", "paused"),
    project("lisbon-trip", "cancelled", { lastActivityMs: 400 }),
    project("shop-site", "on-track"),
    project("bakery-site", "on-track"),
    project("client-report", "at-risk"),
  ],
  members: [],
  orphaned: [],
};
const NAMES: Record<string, string> = {
  "brand-refresh": "Brand refresh",
  "cv-v4": "CV v4",
  "summer-report": "Summer report",
  "literature-review": "Literature review",
  "thai-cooking": "Learn to cook Thai",
  "lisbon-trip": "Lisbon trip",
  "shop-site": "Shop site",
  "bakery-site": "Bakery site",
  "client-report": "Client report",
};
/** The notes' `group:`; Brand refresh has none. One spelling differs, and is the same group. */
const GROUPS: Record<string, string> = { "shop-site": "websites", "bakery-site": "Websites", "client-report": "Acme" };

vi.mock("./TaskCard.js", () => ({ TaskCard: () => null }));
vi.mock("./DocViewer.js", () => ({ DocViewer: () => null }));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      server.calls.push(`${method} ${url}`);
      if (method !== "GET") {
        server.writes.push({ method, url, body });
        return { ok: true };
      }
      if (url === "/api/admin/projects/hidden") return server.hidden;
      // No team: a new install has none, and the board asks for none (1A).
      if (url === "/api/dashboard") return DASHBOARD;
      if (url === "/api/projects") return DASHBOARD.projects.map((p) => ({ slug: p.slug, key: p.slug, name: NAMES[p.slug], domain: p.domain, area: p.domain === "academic" ? "school" : "work", noteId: null, total: p.total, done: p.done, status: p.status, start: null, deadline: null, group: GROUPS[p.slug] ?? null, nextDue: null, overdue: 0 }));
      if (url === "/api/vault/graph") return { nodes: [], edges: [] };
      if (url === "/api/graph/schema") throw new Error("no ontology");
      if (url === "/api/vault/tree") return [];
      if (url === "/api/areas") return AREAS_REPLY;
      if (url === "/api/ai/status") return { configured: true };
      throw new Error(`unexpected ${method} ${url}`);
    },
  };
});

const { Overview } = await import("./Overview.js");
const { useRoute } = await import("./ui/router.js");
const ME = { id: "u-1", username: "jules", isOwner: true } as never;

/** The board as App mounts it: the area from the address. */
function Board() {
  const r = useRoute();
  return <Overview me={ME} area={r?.kind === "projects" ? r.area : undefined} onOpenNote={() => {}} />;
}
const at = (href: string) => window.history.replaceState({ depth: 0 }, "", href);
const shelves = () => [...document.querySelectorAll<HTMLButtonElement>(".shelf-head")];

beforeEach(() => {
  server.calls = [];
  server.writes = [];
  server.hidden = [];
  at("/projects");
});

describe("Projects (F1)", () => {
  it("has no summary of today, and does not ask for one", async () => {
    render(<Board />);
    await screen.findByText("Brand refresh");
    expect(screen.queryByRole("button", { name: /summary/i })).toBeNull();
    expect(screen.queryByText(/Orr is reading the board/)).toBeNull();
    expect(server.calls.filter((c) => c.includes("/api/ai/"))).toEqual([]);
  });

  it("puts completed and archived work on one Done shelf, and nothing else", async () => {
    render(<Board />);
    await screen.findByText("Brand refresh");
    expect(shelves().map((b) => b.textContent)).toEqual(["Paused 1", "Cancelled 1", "Done 3"]);
    expect(screen.queryByText(/^Completed/)).toBeNull();
    expect(screen.queryByText(/^Archived/)).toBeNull();
  });

  it("opens Done at its address, newest first", async () => {
    const user = userEvent.setup();
    render(<Board />);
    await screen.findByText("Brand refresh");
    await user.click(shelves().find((b) => b.textContent === "Done 3")!);
    expect(location.pathname + location.search).toBe("/projects?shelf=done");
    const done = await screen.findByRole("region", { name: "Done projects" });
    expect(within(done).getAllByRole("link").map((a) => a.textContent)).toEqual(["Summer report", "Literature review", "CV v4"]);
  });

  it("Done follows the area filter", async () => {
    at("/projects?area=school&shelf=done");
    render(<Board />);
    const done = await screen.findByRole("region", { name: "Done projects" });
    expect(within(done).getAllByRole("link").map((a) => a.textContent)).toEqual(["Literature review"]);
    expect(shelves().map((b) => b.textContent)).toEqual(["Done 1"]);
    await act(async () => {});
  });
});

describe("Work split by group (Jules, 20 Oct)", () => {
  const boxes = () => [...document.querySelectorAll<HTMLElement>(".pjs-board")].map((b) => b.getAttribute("aria-label"));
  it("one area shows a box per group, the biggest first, Other last", async () => {
    at("/projects?area=work");
    render(<Board />);
    const sites = await screen.findByRole("region", { name: "Websites" });
    expect(boxes()).toEqual(["Websites", "Acme", "Other"]);
    expect(within(sites).getAllByRole("link").map((a) => a.textContent)).toEqual(["Bakery site", "Shop site"]);
    expect(within(screen.getByRole("region", { name: "Other" })).getAllByRole("link").map((a) => a.textContent)).toEqual(["Brand refresh"]);
    // The column heads are drawn once, in the first box.
    expect(document.querySelectorAll(".pjs .ph")).toHaveLength(1);
    expect(sites.querySelector(".ph")).not.toBeNull();
  });

  it("every area at once stays one list", async () => {
    render(<Board />);
    await screen.findByText("Brand refresh");
    expect(boxes()).toEqual(["Open projects"]);
  });
});

describe("the board's own changes (1E)", () => {
  const user = () => userEvent.setup();
  it("a row's ⋯ archives it, and its status is a menu like the project page's", async () => {
    const u = user();
    render(<Board />);
    await screen.findByText("Brand refresh");
    await u.click(screen.getByRole("button", { name: "More for Brand refresh" }));
    await u.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(server.writes).toEqual([{ method: "PATCH", url: "/api/projects/brand-refresh", body: { status: "archived" } }]);
    const row = screen.getByText("Brand refresh").closest(".pr-row") as HTMLElement;
    await u.click(within(row.querySelector(".c-status") as HTMLElement).getByRole("button", { name: /Status: on track/ }));
    await u.click(screen.getByRole("menuitemcheckbox", { name: /At risk/ }));
    expect(server.writes.at(-1)).toEqual({ method: "PATCH", url: "/api/projects/brand-refresh", body: { status: "at-risk" } });
  });

  it("a project removed from the board waits on its own shelf, and Put back brings it back", async () => {
    server.hidden = [{ id: "p-stray", slug: "week-plan", name: "Week plan" }];
    const u = user();
    render(<Board />);
    await screen.findByText("Brand refresh");
    const head = shelves().find((b) => b.textContent === "Removed from the board 1")!;
    await u.click(head);
    expect(location.pathname + location.search).toBe("/projects?shelf=removed");
    const shelf = await screen.findByRole("region", { name: "Removed from the board" });
    await u.click(within(shelf).getByRole("button", { name: "Put back" }));
    expect(server.writes).toEqual([{ method: "POST", url: "/api/admin/projects/p-stray/back", body: undefined }]);
  });

  it("no Removed shelf when nothing was removed", async () => {
    render(<Board />);
    await screen.findByText("Brand refresh");
    expect(shelves().map((b) => b.textContent)).not.toContain("Removed from the board 0");
    expect(server.calls).toContain("GET /api/admin/projects/hidden");
  });
});
