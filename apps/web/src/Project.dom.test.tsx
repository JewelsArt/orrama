/**
 * The project page edits the project note as the note has it (COR-005): "Edit" on the goals
 * opens on the `## Goals` section's own text and saves it back, so a checkbox, a nested item or
 * a line of prose survives a save nobody changed.
 *
 * Its dates are typed as text and written once, when a field is left (WEB-023): never a
 * half-typed year, never while typing, and one write after another. Its status is the vault's
 * vocabulary, written as the ontology's id. Its tabs are addresses.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
      if (method === "GET" && url.startsWith("/api/graph/relations"))
        return { entity: { id: "n-1", title: "Thesis", type: "project", summary: "", fields: {} }, relations: [], warnings: [] };
      if (method === "GET" && url.startsWith("/api/vault/note/")) return { id: "n-1", path: "04-Projects/thesis.md", title: "Thesis", content: "", hash: "h", tags: [], canEdit: true };
      if (method === "GET") return [];
      return { ok: true };
    },
  };
});

const { Project } = await import("./Project.js");
const me = { id: "u-1", username: "jules", displayName: "Jules", isOwner: true } as never;
const SOURCE = "- [x] Pick a supervisor\n- [ ] Defend in January\n  - book the room\n\nDone means: signed off.";

beforeEach(() => {
  server.calls = [];
  server.hold = null;
  server.workspace = {
    slug: "thesis", key: "project/thesis", name: "Thesis", noteId: "n-1", path: "04-Projects/thesis.md", domain: null,
    status: "on-track", start: "2026-09-01", deadline: "2027-01-15", prompt: "",
    goals: ["Pick a supervisor", "Defend in January", "book the room", "Done means: signed off."], goalsSource: SOURCE,
    decisions: ["**2026-10-06** — MASE over MAPE."], inbox: [], people: [], notes: [], files: [], content: "", canEdit: true, total: 2, done: 1, tasks: [],
  };
});

const patches = () => server.calls.filter((c) => c.method === "PATCH").map((c) => c.body);
const open = async () => {
  render(<Project me={me} slug="thesis" onOpenNote={() => {}} />);
  await act(async () => {});
};
/** Opens the dates box from the header's "1 Sep – 15 Jan 2027". */
const dates = async () => {
  fireEvent.click(screen.getByRole("button", { name: /1 Sep – 15 Jan 2027/ }));
  await act(async () => {});
  return { start: screen.getByLabelText("Start") as HTMLInputElement, deadline: screen.getByLabelText("Deadline") as HTMLInputElement };
};

describe("Edit goals (COR-005)", () => {
  it("opens on the section's own text and saves it back untouched", async () => {
    await open();
    const goals = screen.getByRole("region", { name: "Goals" });
    fireEvent.click(within(goals).getByRole("button", { name: "Edit" }));
    expect((within(goals).getByRole("textbox", { name: "Goals" }) as HTMLTextAreaElement).value).toBe(SOURCE);
    await act(async () => {
      fireEvent.click(screen.getByText("Save goals"));
    });
    expect(patches()).toEqual([{ goals: SOURCE }]);
  });
});

describe("start and deadline, typed (WEB-023)", () => {
  it("typing writes nothing; leaving the field writes the date once", async () => {
    await open();
    const { deadline } = await dates();
    expect(deadline.value).toBe("Fri 15 Jan 2027");
    for (const v of ["1", "15", "15 Jan", "15 Jan 2", "15 Jan 202", "15 Jan 2028"]) fireEvent.change(deadline, { target: { value: v } });
    expect(patches()).toEqual([]);
    expect(screen.getByText("Sat 15 Jan 2028")).toBeTruthy();
    await act(async () => {
      fireEvent.blur(deadline);
    });
    expect(patches()).toEqual([{ deadline: "2028-01-15" }]);
  });

  it("a half-typed year is never written, and says so; Enter writes; an empty field clears", async () => {
    await open();
    const { deadline, start } = await dates();
    fireEvent.change(deadline, { target: { value: "15 Jan 202" } });
    expect(screen.getByText(/Not a date yet/)).toBeTruthy();
    expect(deadline.getAttribute("aria-invalid")).toBe("true");
    await act(async () => {
      fireEvent.blur(deadline);
    });
    expect(patches()).toEqual([]);
    fireEvent.change(deadline, { target: { value: "1/3/2027" } });
    await act(async () => {
      fireEvent.keyDown(deadline, { key: "Enter" });
    });
    expect(patches()).toEqual([{ deadline: "2027-03-01" }]);
    fireEvent.change(start, { target: { value: "" } });
    await act(async () => {
      fireEvent.blur(start);
    });
    expect(patches()).toEqual([{ deadline: "2027-03-01" }, { start: "" }]);
  });

  it("closing the box leaves the field: the date typed is written", async () => {
    await open();
    const { deadline } = await dates();
    fireEvent.change(deadline, { target: { value: "2 Feb 2027" } });
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    });
    expect(screen.queryByLabelText("Deadline")).toBeNull();
    expect(patches()).toEqual([{ deadline: "2027-02-02" }]);
  });

  it("writes go one after another, so the last date set is the last one written", async () => {
    await open();
    const { deadline, start } = await dates();
    let release!: () => void;
    server.hold = new Promise<void>((r) => (release = r));
    fireEvent.change(deadline, { target: { value: "2027-03-01" } });
    await act(async () => {
      fireEvent.blur(deadline);
    });
    fireEvent.change(start, { target: { value: "2026-11-01" } });
    await act(async () => {
      fireEvent.blur(start);
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

describe("status, in the vault's words", () => {
  it("reads an old spelling as its word and writes the ontology's id", async () => {
    server.workspace = { ...server.workspace, status: "sleeping" };
    await open();
    const button = screen.getByRole("button", { name: /Status: paused/ });
    expect(button.textContent).toBe("Paused");
    fireEvent.click(button);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /At risk/ }));
    });
    expect(patches()).toEqual([{ status: "at-risk" }]);
  });

  it("no status is said, and Orr says it at the top", async () => {
    server.workspace = { ...server.workspace, status: "" };
    await open();
    expect(screen.getByRole("button", { name: /Status: no status/ })).toBeTruthy();
    expect(screen.getByRole("note", { name: "Orr noticed" }).textContent).toContain("No status yet");
  });
});

describe("tabs are addresses", () => {
  it("each tab is a link to its own address, the current one selected", async () => {
    render(<Project me={me} slug="thesis" tab="todo" onOpenNote={() => {}} />);
    await act(async () => {});
    const tabs = within(screen.getByRole("tablist", { name: "Project views" })).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("href"))).toEqual(["/projects/thesis", "/projects/thesis/timeline", "/projects/thesis/documents", "/projects/thesis/todo"]);
    expect(tabs.find((t) => t.getAttribute("aria-selected") === "true")?.textContent).toMatch(/^To-do/);
    await act(async () => {
      fireEvent.click(tabs[1]!);
    });
    expect(location.pathname).toBe("/projects/thesis/timeline");
    expect(localStorage.getItem("basalt-proj-view")).toBe("todo");
  });
});

describe("decisions", () => {
  it("show their day apart from their words, newest first", async () => {
    await open();
    const box = screen.getByRole("region", { name: "Decisions" });
    expect(within(box).getByText(/^Tue 6 Oct/).nextSibling?.textContent).toBe("MASE over MAPE.");
    fireEvent.change(within(box).getByRole("textbox", { name: "Add to Decisions" }), { target: { value: "Two markets only" } });
    await act(async () => {
      fireEvent.click(within(box).getByRole("button", { name: "Add" }));
    });
    expect(server.calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/projects/thesis/decisions", body: { text: "Two markets only" } });
  });
});
