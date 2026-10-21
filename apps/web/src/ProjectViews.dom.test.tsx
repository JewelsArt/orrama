/**
 * The project's working tabs.
 *
 * The Documents board saves 400 ms after the last change. Leaving it inside that window
 * (renaming a box and clicking the Overview tab, which blurs the name and unmounts the board)
 * used to cancel the save (WEB-014). Orr's suggested links are asked about one at a time: Link
 * keeps the line as the user's own, No drops it.
 *
 * The To-do tab groups by the note's own sections in the note's order, the checkbox ticks, and
 * the ⋯ menu sets the other states. Add a step writes a checkbox with its `due:`.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Node = { id: string; label?: string };
type Edge = { id: string; fromNode: string; toNode: string; orramaSuggested?: boolean; label?: string };
const server = vi.hoisted(() => ({
  puts: [] as { url: string; body: { nodes: Node[]; edges: Edge[] } }[],
  posts: [] as { url: string; body: Record<string, unknown> }[],
  board: null as unknown,
  /** When it says yes, that write fails as a server that isn't there would (WEB-010). */
  fail: null as ((method: string, url: string) => boolean) | null,
}));

vi.mock("./DocViewer.js", () => ({ DocViewer: () => null }));
vi.mock("./TaskCard.js", () => ({ TaskCard: () => null }));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      if (method === "GET" && url === "/api/projects/thesis/board") return server.board;
      if (server.fail?.(method, url)) {
        server.posts.push({ url: `failed ${url}`, body: body as never });
        throw new TypeError("Failed to fetch");
      }
      if (method === "PUT") server.puts.push({ url, body: body as never });
      if (method === "POST") server.posts.push({ url, body: body as never });
      return {};
    },
  };
});

const { AddStepDialog, ProjectBoard, ProjectTimeline, ProjectTodo } = await import("./ProjectViews.js");
const { Toaster } = await import("./ui/overlays.js");
const files = "04-Projects/thesis/files/";
const SOURCES = { nodes: [{ id: "g-1", type: "group", label: "Sources", x: 0, y: 0, width: 480, height: 220 }], edges: [], canEdit: true };
const SUGGESTED = {
  nodes: [
    { id: "a", type: "file", file: `${files}Reach NL vs FR.png`, x: 0, y: 0, width: 222, height: 46 },
    { id: "b", type: "file", file: `${files}Hyndman 2021.pdf`, x: 400, y: 0, width: 222, height: 46 },
  ],
  edges: [{ id: "e-1", fromNode: "a", toNode: "b", orramaSuggested: true, label: "Both use the same method" }],
  canEdit: true,
};
const w = { slug: "thesis", noteId: "n-1", path: "04-Projects/thesis.md", files: [], canEdit: true, tasks: [] } as never;

beforeEach(() => {
  server.puts = [];
  server.posts = [];
  server.board = SOURCES;
  server.fail = null;
});

describe("the Documents board (WEB-014)", () => {
  it("a rename finished by leaving the board is still saved", async () => {
    const { unmount } = render(<ProjectBoard w={w} onChanged={async () => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Rename Sources"));
    const input = screen.getByLabelText("Box name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Primary sources" } });
    fireEvent.blur(input);
    // The tab switch, at once — well inside the 400 ms debounce.
    unmount();
    await act(async () => {});
    expect(server.puts).toHaveLength(1);
    expect(server.puts[0]!.url).toBe("/api/projects/thesis/board");
    expect(server.puts[0]!.body.nodes.find((n) => n.id === "g-1")!.label).toBe("Primary sources");
  });

  it("a change left alone is saved once, after the pause, not again on leaving", async () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<ProjectBoard w={w} onChanged={async () => {}} />);
      await act(async () => {});
      fireEvent.click(screen.getByLabelText("Rename Sources"));
      const input = screen.getByLabelText("Box name") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "Later" } });
      fireEvent.blur(input);
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(server.puts).toHaveLength(1);
      unmount();
      expect(server.puts).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Orr's suggested links", () => {
  const ask = async () => {
    server.board = SUGGESTED;
    const r = render(<ProjectBoard w={w} onChanged={async () => {}} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /1 suggested link/ }));
    return { ...r, tip: screen.getByRole("dialog", { name: "Suggested link" }) };
  };

  it("asks about one link in its own words; Link keeps it as the user's", async () => {
    const { tip, unmount } = await ask();
    expect(tip.textContent).toContain("Both use the same method. Link them?");
    fireEvent.click(within(tip).getByRole("button", { name: "Link" }));
    unmount();
    expect(server.puts.at(-1)!.body.edges).toEqual([{ id: "e-1", fromNode: "a", toNode: "b", label: "Both use the same method" }]);
  });

  it("No drops it", async () => {
    const { tip, unmount } = await ask();
    fireEvent.click(within(tip).getByRole("button", { name: "No" }));
    unmount();
    expect(server.puts.at(-1)!.body.edges).toEqual([]);
  });
});

let line = 0;
const step = (text: string, section: string, over: Record<string, unknown> = {}) => ({
  line: ++line, checked: false, status: "todo", text, raw: `- [ ] ${text}`, indent: 0, noteId: "n-1", notePath: "04-Projects/thesis.md",
  noteTitle: "Thesis", project: "Thesis", object: null, section, ...over,
});

describe("the To-do tab", () => {
  const tasks = [
    step("Outline chapter 1", "Chapter 1", { noteId: "n-ch1", noteTitle: "Chapter 1", line: 3 }),
    step("Ask Thijs to sign", "Research plan", { line: 20, due: "2020-01-01" }),
    step("Literature map", "Research plan", { line: 21, checked: true, status: "done" }),
    step("Summarise MASE", "Literature", { line: 30 }),
  ];
  const todo = (changed = async () => {}) => render(<ProjectTodo w={{ ...(w as object), tasks } as never} onChanged={changed} onOpenNote={() => {}} onAdd={() => {}} />);

  it("groups by the note's own sections in its order, other notes after", () => {
    todo();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Research plan", "Literature", "Chapter 1"]);
  });

  it("the checkbox ticks; the menu sets the other states", async () => {
    todo();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Complete Ask Thijs to sign" }));
    });
    expect(server.posts.at(-1)).toMatchObject({ url: "/api/tasks/check", body: { text: "Ask Thijs to sign", checked: true } });
    fireEvent.click(screen.getByRole("button", { name: "Status of Ask Thijs to sign" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Blocked" }));
    });
    expect(server.posts.at(-1)).toMatchObject({ url: "/api/tasks/status", body: { text: "Ask Thijs to sign", status: "blocked" } });
  });

  it("done steps fold under their section until asked for", () => {
    todo();
    expect(screen.queryByText("Literature map")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 done" }));
    expect(screen.getByText("Literature map")).toBeTruthy();
  });
});

describe("Add a step", () => {
  it("writes a checkbox with its due date; a date that is not one stops it", async () => {
    const added = vi.fn(async () => {});
    render(<AddStepDialog w={w} due="2026-10-19" onClose={() => {}} onAdded={added} />);
    fireEvent.change(screen.getByLabelText("The step"), { target: { value: "Run the pilot interview" } });
    const when = screen.getByLabelText("Due (optional)") as HTMLInputElement;
    expect(when.value).toMatch(/19 Oct/);
    fireEvent.change(when, { target: { value: "29 Oct 202" } });
    expect((screen.getByRole("button", { name: "Add the step" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(when, { target: { value: "29/10/2026" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the step" }));
    });
    expect(server.posts).toEqual([{ url: "/api/projects/thesis/capture", body: { text: "Run the pilot interview due:2026-10-29", task: true } }]);
    expect(added).toHaveBeenCalled();
  });
});

describe("Add a step with the card's fields (1B)", () => {
  it("takes a priority and the key-deadline tag at creation, written as a person types them", async () => {
    render(<AddStepDialog w={w} onClose={() => {}} onAdded={vi.fn(async () => {})} />);
    fireEvent.change(screen.getByLabelText("The step"), { target: { value: "Hand in the draft" } });
    fireEvent.change(screen.getByLabelText("Due (optional)"), { target: { value: "30 Oct 2026" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Priority" })).getByRole("radio", { name: "High" }));
    fireEvent.click(screen.getByRole("switch", { name: "Key deadline" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the step" }));
    });
    expect(server.posts).toEqual([{ url: "/api/projects/thesis/capture", body: { text: "Hand in the draft due:2026-10-30 !p1 #deadline", task: true } }]);
  });

  it("a step with none of them is its words alone", async () => {
    render(<AddStepDialog w={w} onClose={() => {}} onAdded={vi.fn(async () => {})} />);
    fireEvent.change(screen.getByLabelText("The step"), { target: { value: "  Book the room " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add the step" }));
    });
    expect(server.posts).toEqual([{ url: "/api/projects/thesis/capture", body: { text: "Book the room", task: true } }]);
  });
});

describe("a drag that didn't save (WEB-010)", () => {
  it("the Gantt bar goes back, a toast says why, and Retry sends the same dates", async () => {
    localStorage.setItem("orrama-proj-gantt", "thesis");
    server.fail = (m, url) => m === "POST" && url === "/api/tasks/dates";
    const changed = vi.fn(async () => {});
    render(<Toaster />);
    render(<ProjectTimeline w={{ ...(w as object), name: "Thesis", tasks: [step("Write chapter 2", "Writing", { start: "2026-10-05", due: "2026-10-09" })] } as never} onChanged={changed} onOpenNote={() => {}} />);
    const bar = document.querySelector<HTMLElement>(".gantt-bar")!;
    const left = bar.style.left;
    await act(async () => {
      fireEvent.pointerDown(bar, { clientX: 100, pointerId: 1 });
      fireEvent.pointerMove(bar, { clientX: 100 + 26 * 3, pointerId: 1 });
      fireEvent.pointerUp(bar, { clientX: 100 + 26 * 3, pointerId: 1 });
    });
    expect(server.posts.map((p) => p.url)).toEqual(["failed /api/tasks/dates"]);
    expect(server.posts[0]!.body).toMatchObject({ text: "Write chapter 2", start: "2026-10-08", due: "2026-10-12" });
    expect(document.querySelector<HTMLElement>(".gantt-bar")!.style.left).toBe(left);
    expect([...document.querySelectorAll(".toast span")].map((t) => t.textContent)).toEqual(["The step's dates weren't changed. The server didn't answer. Check it's running, then try again."]);
    expect(changed).not.toHaveBeenCalled();
    server.fail = null;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(server.posts.at(-1)).toMatchObject({ url: "/api/tasks/dates", body: { text: "Write chapter 2", start: "2026-10-08", due: "2026-10-12" } });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
