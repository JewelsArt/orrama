/**
 * Rename, move, the trash and history from the Notes page itself (1C): the note's ⋯ offers
 * them, a renamed note's address follows it, the open note put in the trash closes and Undo
 * opens it again, and /notes/trash is the Trash view.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRoute } from "./ui/router.js";

const srv = vi.hoisted(() => ({
  notes: new Map<string, { path: string; content: string }>(),
  trashed: new Map<string, string>(),
  posts: [] as { url: string; body: unknown }[],
}));

vi.mock("./ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("./Editor.js", () => ({ Editor: () => <div data-testid="editor" /> }));

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  const tree = () =>
    [...srv.notes].map(([id, n]) => ({
      id,
      path: n.path,
      folder: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "",
      title: n.path.split("/").pop()!.replace(/\.md$/, ""),
      hash: "h",
      mtimeMs: 0,
      tags: [],
      openTasks: 0,
      category: "other",
    }));
  return {
    ...real,
    api: async (method: string, url: string, body?: Record<string, string>) => {
      if (method === "POST") srv.posts.push({ url, body });
      if (method === "POST" && url === "/api/vault/move") {
        const id = [...srv.notes].find(([, n]) => n.path === body!["fromPath"])![0];
        srv.notes.get(id)!.path = body!["toPath"]!;
        return { id, path: body!["toPath"], links: 0, notes: 0 };
      }
      if (method === "POST" && url === "/api/vault/trash") {
        const [id, n] = [...srv.notes].find(([, x]) => x.path === body!["path"])!;
        srv.notes.delete(id);
        srv.trashed.set(id, n.path);
        return { path: n.path, trashPath: `.trash/${n.path}` };
      }
      if (method === "POST" && url === "/api/vault/trash/restore") {
        const [id, p] = [...srv.trashed][0]!;
        srv.trashed.delete(id);
        srv.notes.set(id, { path: p, content: "# back\n" });
        return { path: p, id };
      }
      if (method === "PUT") return { ...body, hash: "h2" };
      if (url === "/api/vault/tree") return tree();
      if (url === "/api/vault/folders") return [...new Set(tree().map((n) => n.folder).filter(Boolean))];
      if (url === "/api/vault/trash") return [];
      if (url === "/api/notes/overview") return { pinned: [], notes: srv.notes.size, conversations: 0, openTasks: 0, doneTasks: 0 };
      if (url === "/api/graph/schema") return { types: [] };
      if (url.includes("/linkers")) return { notes: [], other: 0 };
      const m = /^\/api\/vault\/note\/([^/?]+)$/.exec(url);
      if (method === "GET" && m) {
        const n = srv.notes.get(m[1]!);
        if (!n) throw new real.ApiError(404, "note not found");
        return { id: m[1], path: n.path, title: n.path.split("/").pop()!.replace(/\.md$/, ""), content: n.content, hash: "h", tags: [], tasks: [], links: [], backlinks: [], canEdit: true };
      }
      return [];
    },
  };
});

const { Notes } = await import("./Notes.js");
const { resetNoteSyncs } = await import("./noteSync.js");
const { Toaster } = await import("./ui/overlays.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
function Routed() {
  const r = useRoute();
  const n = r?.kind === "notes" ? r : null;
  return (
    <>
      <Notes me={me} noteId={n?.id} notePath={n?.path} trash={!!n?.trash} />
      <Toaster />
    </>
  );
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};
const at = (href: string) => history.replaceState(null, "", href);
const path = () => decodeURIComponent(location.pathname);
const menu = () => fireEvent.click(screen.getByRole("button", { name: "More" }));

beforeEach(() => {
  srv.notes = new Map([
    ["a", { path: "Ideas/Reading.md", content: "# Reading\n" }],
    ["b", { path: "Travel/Lisbon.md", content: "# Lisbon\n" }],
  ]);
  srv.trashed = new Map();
  srv.posts = [];
  localStorage.clear();
  resetNoteSyncs();
  at("/notes");
});

describe("the note's ⋯", () => {
  it("offers Rename, Move, History and Move to the trash", async () => {
    at("/notes/Ideas/Reading");
    render(<Routed />);
    await flush();
    menu();
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Pin to Notes home", "Make this a project", "Rename…", "Move to…", "History", "Show in the Orrery", "Close note", "Move to the trash"]);
  });

  it("a rename's address follows the note, and it stays open", async () => {
    at("/notes/Ideas/Reading");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Reading list" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await flush();
    expect(srv.posts).toEqual([{ url: "/api/vault/move", body: { fromPath: "Ideas/Reading.md", toPath: "Ideas/Reading list.md", links: true } }]);
    expect(await screen.findByRole("heading", { level: 1, name: "Reading list" })).toBeTruthy();
    expect(path()).toBe("/notes/Ideas/Reading list");
    expect(screen.queryByText(/Can't open/)).toBeNull();
  });

  it("the open note put in the trash closes; Undo puts it back and opens it", async () => {
    at("/notes/Ideas/Reading");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to the trash" }));
    await flush();
    expect(srv.posts[0]).toEqual({ url: "/api/vault/trash", body: { path: "Ideas/Reading.md" } });
    expect(path()).toBe("/notes");
    fireEvent.click((await screen.findAllByRole("button", { name: "Undo" })).pop()!);
    await flush();
    expect(srv.posts[1]).toEqual({ url: "/api/vault/trash/restore", body: { path: ".trash/Ideas/Reading.md" } });
    expect(await screen.findByRole("heading", { level: 1, name: "Reading" })).toBeTruthy();
    expect(path()).toBe("/notes/Ideas/Reading");
  });
});

describe("the Trash view", () => {
  it("/notes/trash is the Trash view, reached from the tree", async () => {
    render(<Routed />);
    await flush();
    fireEvent.click(screen.getAllByRole("link", { name: "Trash" })[0]!);
    await flush();
    expect(path()).toBe("/notes/trash");
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
  });
});
