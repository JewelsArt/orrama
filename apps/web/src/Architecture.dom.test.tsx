/**
 * The note side panel's tasks follow your own saves, and ticking one names the
 * task, not just the line it was drawn on (WEB-004, COR-001). The panel used to
 * keep the tasks it loaded when the note opened: type a line above them, let it
 * save, tick "Call bank", and the server ticked "Pay rent", which had slid onto
 * that line.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Msg = { type: string; noteId?: string; authorId?: string; resync?: boolean };
const ws = vi.hoisted(() => ({ listeners: new Set<(m: Msg) => void>() }));
const server = vi.hoisted(() => ({ content: "", posts: [] as { url: string; body: Record<string, unknown> }[] }));

vi.mock("./ws.js", () => ({
  onWs: (l: (m: Msg) => void) => {
    ws.listeners.add(l);
    return () => ws.listeners.delete(l);
  },
  sendEditing: () => {},
}));
vi.mock("./Editor.js", () => ({ Editor: () => null }));
vi.mock("./GraphCanvas.js", () => ({ GraphCanvas: () => null }));
vi.mock("./FileTree.js", () => ({ FileTree: () => null }));
vi.mock("./noteSync.js", () => ({
  openNoteSync: () => ({ refresh: async () => {}, edit: () => {}, flush: async () => {}, close: () => {} }),
  retire: () => {},
}));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  /** The note as the server has it now, with its tasks read off the text the way core does. */
  const detail = () => {
    const lines = server.content.split("\n");
    const tasks = lines.flatMap((raw, line) => {
      const m = /^- \[( |x)\] (.*)$/.exec(raw);
      return m ? [{ line, checked: m[1] === "x", status: m[1] === "x" ? "done" : "todo", text: m[2]!, raw, indent: 0 }] : [];
    });
    return { id: "n-1", path: "Notes/list.md", title: "List", content: server.content, hash: "h", tags: [], tasks, links: [], backlinks: [], canEdit: true };
  };
  return {
    ...real,
    api: async (method: string, url: string, body?: Record<string, unknown>) => {
      if (method === "GET" && url === "/api/vault/note/n-1") return detail();
      if (method === "GET") return [];
      server.posts.push({ url, body: body ?? {} });
      return {};
    },
  };
});

const { Architecture } = await import("./Architecture.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
const flush = () => act(async () => {});

beforeEach(() => {
  ws.listeners.clear();
  server.posts = [];
  server.content = "---\nid: n-1\n---\n\n- [ ] Pay rent\n- [ ] Call bank\n";
});

describe("the side panel's tasks (WEB-004)", () => {
  it("show what your own save wrote, and a tick names the task it was drawn for", async () => {
    render(<Architecture me={me} noteId="n-1" />);
    await flush();
    expect(screen.getByLabelText("Call bank")).toBeTruthy();

    // You type a task above the others; the autosave lands and the server
    // tells every view, this one included, that the note changed.
    server.content = "---\nid: n-1\n---\n\n- [ ] Book dentist\n- [ ] Pay rent\n- [ ] Call bank\n";
    await act(async () => {
      for (const l of ws.listeners) l({ type: "note-changed", noteId: "n-1", authorId: "u-1" });
    });
    expect(screen.getByLabelText("Book dentist")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Call bank"));
    await flush();
    const check = server.posts.find((p) => p.url === "/api/tasks/check")!;
    expect(check.body).toMatchObject({ noteId: "n-1", line: 6, text: "Call bank", checked: true });
  });

  it("a tick sent from a panel the server has moved past still says which task it meant", async () => {
    render(<Architecture me={me} noteId="n-1" />);
    await flush();
    // The note changes and no word of it reaches this view (the socket was down).
    server.content = "---\nid: n-1\n---\n\n- [ ] Book dentist\n- [ ] Pay rent\n- [ ] Call bank\n";
    fireEvent.click(screen.getByLabelText("Call bank"));
    await flush();
    // The line is stale; the text is what lets the server find "Call bank" or refuse.
    expect(server.posts.find((p) => p.url === "/api/tasks/check")!.body).toMatchObject({ line: 5, text: "Call bank" });
    // And the panel reloads after the click, so the next one is drawn from the note as it is.
    expect(screen.getByLabelText("Book dentist")).toBeTruthy();
  });
});
