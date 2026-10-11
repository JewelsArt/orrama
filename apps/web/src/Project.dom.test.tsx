/**
 * The project page edits the project note as the note has it (COR-005): "Edit
 * goals" opens on the `## Goals` section's own text and saves it back, so a
 * checkbox, a nested item or a line of prose survives a save nobody changed.
 * Its dates are written once per date typed, in order (WEB-023).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; body: Record<string, unknown> }[],
  workspace: {} as Record<string, unknown>,
  /** When set, a PATCH waits for this before it answers (a slow server). */
  hold: null as Promise<void> | null,
}));

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
      if (method === "PATCH" && server.hold) await server.hold;
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
  server.hold = null;
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

describe("start and deadline (WEB-023)", () => {
  const patches = () => server.calls.filter((c) => c.method === "PATCH").map((c) => c.body);
  const deadline = () => screen.getByLabelText("deadline") as HTMLInputElement;

  it("typing a year writes once, the final date — not 0002, 0020, 0202 on the way", async () => {
    vi.useFakeTimers();
    try {
      render(<Project me={me} slug="thesis" onBack={() => {}} onOpenNote={() => {}} />);
      await act(async () => {});
      // A segmented date field changes its value on every digit of the year.
      for (const v of ["0002-01-15", "0020-01-15", "0202-01-15", "2028-01-15"]) {
        fireEvent.change(deadline(), { target: { value: v } });
        await act(async () => {
          vi.advanceTimersByTime(150);
        });
      }
      expect(deadline().value).toBe("2028-01-15");
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(patches()).toEqual([{ deadline: "2028-01-15" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaving the field writes at once; a year before 1900 is never written", async () => {
    render(<Project me={me} slug="thesis" onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {});
    fireEvent.change(deadline(), { target: { value: "0202-01-15" } });
    await act(async () => {
      fireEvent.blur(deadline());
    });
    expect(patches()).toEqual([]);
    expect(deadline().value).toBe("2027-01-15");
    fireEvent.change(deadline(), { target: { value: "2027-03-01" } });
    await act(async () => {
      fireEvent.blur(deadline());
    });
    expect(patches()).toEqual([{ deadline: "2027-03-01" }]);
  });

  it("writes go one after another, so the last date set is the last one written", async () => {
    render(<Project me={me} slug="thesis" onBack={() => {}} onOpenNote={() => {}} />);
    await act(async () => {});
    let release!: () => void;
    server.hold = new Promise<void>((r) => (release = r));
    fireEvent.change(deadline(), { target: { value: "2027-03-01" } });
    await act(async () => {
      fireEvent.blur(deadline());
    });
    fireEvent.change(screen.getByLabelText("start") as HTMLInputElement, { target: { value: "2026-11-01" } });
    await act(async () => {
      fireEvent.blur(screen.getByLabelText("start"));
    });
    // The first is still on its way: the second has not been sent.
    expect(patches()).toEqual([{ deadline: "2027-03-01" }]);
    server.hold = null;
    await act(async () => {
      release();
    });
    expect(patches()).toEqual([{ deadline: "2027-03-01" }, { start: "2026-11-01" }]);
  });
});
