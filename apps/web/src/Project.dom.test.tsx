/**
 * The project page edits the project note as the note has it (COR-005): "Edit
 * goals" opens on the `## Goals` section's own text and saves it back, so a
 * checkbox, a nested item or a line of prose survives a save nobody changed.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as { method: string; url: string; body: Record<string, unknown> }[], workspace: {} as Record<string, unknown> }));

vi.mock("./ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("./Editor.js", () => ({ Editor: () => null }));
vi.mock("./DocViewer.js", () => ({ DocViewer: () => null }));
vi.mock("./ProjectViews.js", () => ({ ProjectBoard: () => null, ProjectTimeline: () => null, ProjectTodo: () => null }));
vi.mock("./noteSync.js", () => ({
  openNoteSync: () => ({ refresh: async () => {}, edit: () => {}, flush: async () => {}, close: () => {}, subscribe: () => () => {} }),
  retire: () => {},
}));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: Record<string, unknown>) => {
      server.calls.push({ method, url, body: body ?? {} });
      if (method === "GET" && url === "/api/projects/thesis") return server.workspace;
      if (method === "GET") return [];
      return { ok: true };
    },
  };
});

const { Project } = await import("./Project.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
const SOURCE = "- [x] Pick a supervisor\n- [ ] Defend in January\n  - book the room\n\nDone means: signed off.";

beforeEach(() => {
  localStorage.setItem("basalt-proj-view", "overview");
  server.calls = [];
  server.workspace = {
    slug: "thesis", key: "project/thesis", name: "Thesis", noteId: "n-1", path: "04-Projects/thesis.md", domain: null,
    status: "on-track", start: "2026-09-01", deadline: "2027-01-15", prompt: "",
    goals: ["Pick a supervisor", "Defend in January", "book the room", "Done means: signed off."], goalsSource: SOURCE,
    decisions: [], inbox: [], people: [], notes: [], files: [], content: "", canEdit: true, total: 2, done: 1, tasks: [],
  };
});

describe("Edit goals (COR-005)", () => {
  it("opens on the section's own text and saves it back untouched", async () => {
    render(<Project me={me} slug="thesis" onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {});
    const goals = screen.getByText("Goals").closest("section") ?? document.body;
    fireEvent.click(Array.from(goals.querySelectorAll("button")).find((b) => b.textContent === "Edit")!);
    expect((screen.getByLabelText("Goals") as HTMLTextAreaElement).value).toBe(SOURCE);
    await act(async () => {
      fireEvent.click(screen.getByText("Save goals"));
    });
    expect(server.calls.find((c) => c.method === "PATCH")!.body).toEqual({ goals: SOURCE });
  });
});
