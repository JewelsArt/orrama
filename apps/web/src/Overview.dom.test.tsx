/**
 * The Projects board after Jules's answers to R8 (F1, 11 October).
 *
 * No summary of today at the top: no board draws it and Today already says what's due, so the
 * page neither offers it nor asks whether a model is set up.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as string[] }));

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
  team: { id: "t-1", slug: "home", name: "Home", color: "", icon: "" },
  projects: [
    project("brand-refresh", "on-track"),
    project("cv-v4", "completed", { lastActivityMs: 100 }),
    project("summer-report", "archived", { lastActivityMs: 300 }),
    project("literature-review", "on-track", { total: 2, done: 2, lastActivityMs: 200, domain: "academic" }),
    project("thai-cooking", "paused"),
    project("lisbon-trip", "cancelled", { lastActivityMs: 400 }),
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
};

vi.mock("./TaskCard.js", () => ({ TaskCard: () => null }));
vi.mock("./DocViewer.js", () => ({ DocViewer: () => null }));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string) => {
      server.calls.push(`${method} ${url}`);
      if (url === "/api/teams") return [{ ...DASHBOARD.team, total: 0, done: 0 }];
      if (url === "/api/dashboard/home") return DASHBOARD;
      if (url === "/api/projects") return DASHBOARD.projects.map((p) => ({ slug: p.slug, key: p.slug, name: NAMES[p.slug], domain: p.domain, noteId: null, total: p.total, done: p.done, status: p.status, start: null, deadline: null, nextDue: null, overdue: 0 }));
      if (url === "/api/vault/graph") return { nodes: [], edges: [] };
      if (url === "/api/graph/schema") throw new Error("no ontology");
      if (url === "/api/vault/tree") return [];
      if (url === "/api/ai/status") return { configured: true };
      throw new Error(`unexpected ${method} ${url}`);
    },
  };
});

const { Overview } = await import("./Overview.js");
const ME = { id: "u-1", username: "jules", isOwner: true } as never;

const Board = () => <Overview me={ME} onOpenNote={() => {}} />;
const at = (href: string) => window.history.replaceState({ depth: 0 }, "", href);

beforeEach(() => {
  server.calls = [];
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
});
