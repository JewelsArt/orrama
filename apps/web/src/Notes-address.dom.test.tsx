/**
 * Which note is open is the address (WEB-024). Moving between notes inside Notes, or closing
 * one, used to leave App's view on the note you arrived on, so ⌘K back to it changed nothing.
 * The real router runs here, as App drives it: the address names the note, Notes follows.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigate, useRoute } from "./ui/router.js";

const gets = vi.hoisted(() => [] as string[]);
vi.mock("./ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("./Editor.js", () => ({ Editor: () => null }));
vi.mock("./FileTree.js", () => ({
  FileTree: ({ onOpen }: { onOpen: (id: string) => void }) => (
    <>
      <button onClick={() => onOpen("x")}>tree x</button>
      <button onClick={() => onOpen("y")}>tree y</button>
    </>
  ),
}));
vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  const tree = ["x", "y"].map((id) => ({ id, path: `Notes/${id} note.md`, folder: "Notes", title: `Note ${id.toUpperCase()}`, tags: [], openTasks: 0, category: "other", hash: "", mtimeMs: 0 }));
  return {
    ...real,
    api: async (method: string, url: string) => {
      if (url === "/api/vault/tree") return tree;
      const m = /^\/api\/vault\/note\/([^/]+)$/.exec(url);
      if (method === "GET" && m) {
        gets.push(m[1]!);
        if (!tree.some((t) => t.id === m[1])) throw new real.ApiError(404, "no such note");
        return { id: m[1], path: `Notes/${m[1]} note.md`, title: `Note ${m[1]!.toUpperCase()}`, content: "", hash: "h", tags: [], tasks: [], links: [], backlinks: [], canEdit: false };
      }
      return [];
    },
  };
});

const { Notes, LAST_NOTE_KEY } = await import("./Notes.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;

/** What App does: the address decides the note. */
function Routed() {
  const r = useRoute();
  const n = r?.kind === "notes" ? r : null;
  return <Notes me={me} noteId={n?.id} notePath={n?.path} />;
}
const flush = () => act(async () => {});
const path = () => decodeURIComponent(location.pathname + location.search);
const title = () => document.querySelector(".nt-doc h1")?.textContent ?? null;

beforeEach(() => {
  gets.length = 0;
  localStorage.clear();
  history.replaceState(null, "", "/notes");
});

describe("the open note is the address (WEB-024)", () => {
  it("after moving to another note, ⌘K back to the first opens it", async () => {
    history.replaceState(null, "", "/notes/Notes/x note");
    render(<Routed />);
    await flush();
    expect(title()).toBe("Note X");
    fireEvent.click(screen.getByText("tree y"));
    await flush();
    expect(path()).toBe("/notes/Notes/y note"); // opening updated the address
    expect(title()).toBe("Note Y");
    await act(async () => navigate({ kind: "notes", path: "Notes/x note" })); // what ⌘K → X does
    await flush();
    expect(title()).toBe("Note X");
  });

  it("after closing it with Esc, ⌘K to it opens it again; re-picking the open note loads nothing", async () => {
    history.replaceState(null, "", "/notes/Notes/x note");
    render(<Routed />);
    await flush();
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(path()).toBe("/notes");
    expect(title()).toBeNull();
    await act(async () => navigate({ kind: "notes", path: "Notes/x note" }));
    await flush();
    expect(title()).toBe("Note X");
    const loads = gets.length;
    await act(async () => navigate({ kind: "notes", path: "Notes/x note" }));
    await flush();
    expect(gets.length).toBe(loads);
  });

  it("/notes opens on the note you had open last, until you close it", async () => {
    localStorage.setItem(LAST_NOTE_KEY, "y");
    render(<Routed />);
    await flush();
    await flush();
    expect(path()).toBe("/notes/Notes/y note");
    expect(title()).toBe("Note Y");
  });

  it("an address by id becomes the note's path; one naming nothing says so", async () => {
    history.replaceState(null, "", "/notes?id=x");
    render(<Routed />);
    await flush();
    expect(path()).toBe("/notes/Notes/x note");
    await act(async () => navigate({ kind: "notes", path: "Notes/gone" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Notes/gone.md");
    expect(title()).toBeNull();
  });
});
