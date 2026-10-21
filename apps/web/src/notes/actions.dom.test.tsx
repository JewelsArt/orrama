/**
 * Rename, move, the trash and history on screen (1C): the dialogs every page shares, the Trash
 * view, the History sheet, and the tree's ⋯ menus and drag. The server is a stub that records
 * what was asked; the routes themselves are tested in apps/server/test/note-actions.test.ts.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNote } from "../api.js";

const srv = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; body?: unknown }[],
  refuse: null as null | { status: number; message: string },
  trash: [] as { path: string; from: string; title: string; kind: "note" | "file"; at: number; canRestore: boolean }[],
}));

vi.mock("../api.js", async (orig) => {
  const real = await orig<typeof import("../api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      srv.calls.push({ method, url, body });
      if (srv.refuse && method === "POST") throw new real.ApiError(srv.refuse.status, srv.refuse.message);
      if (url.includes("/linkers")) return { notes: [{ id: "b", path: "B.md", title: "B", links: 2, canEdit: true }], other: 1 };
      if (url === "/api/vault/trash") return srv.trash;
      if (url === "/api/vault/move") {
        const b = body as { toPath: string };
        return { id: "n1", path: b.toPath, links: 2, notes: 1 };
      }
      if (url === "/api/vault/trash/restore") return { path: "Ideas/Reading.md", id: "n1" };
      if (url === "/api/vault/trash/empty") return { removed: 1, kept: 0 };
      if (url.includes("/history/")) return { seq: 7, at: Date.UTC(2026, 9, 1, 9), authorId: "me", content: "# Soup\nLeeks\n" };
      if (url.includes("/history")) {
        return {
          revisions: [
            { seq: 9, at: Date.UTC(2026, 9, 2, 9), authorId: "me", length: 30 },
            { seq: 7, at: Date.UTC(2026, 9, 1, 9), authorId: null, length: 12 },
          ],
          nextBefore: null,
          total: 2,
        };
      }
      return {};
    },
  };
});

const { MoveDialog, RenameNoteDialog, TrashView, HistorySheet, trashFolderRequest } = await import("./actions.js");
const { FileTree } = await import("../FileTree.js");
const { Confirm } = await import("../Confirm.js");

const posts = () => srv.calls.filter((c) => c.method === "POST");
const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

beforeEach(() => {
  srv.calls = [];
  srv.refuse = null;
  srv.trash = [];
});

describe("Rename", () => {
  it("prefills the name, says whose links follow, and renames with the links", async () => {
    const done = vi.fn();
    render(<RenameNoteDialog note={{ id: "n1", path: "Ideas/Reading.md" }} onDone={done} onClose={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Reading");
    fireEvent.change(input, { target: { value: "Reading list" } });
    expect(await screen.findByText(/1 note links here; its links will follow\. 1 link won't follow/)).toBeTruthy();
    expect(srv.calls.some((c) => c.url === "/api/vault/note/n1/linkers?to=Ideas%2FReading%20list.md")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await settle();
    expect(posts()).toEqual([{ method: "POST", url: "/api/vault/move", body: { fromPath: "Ideas/Reading.md", toPath: "Ideas/Reading list.md", links: true } }]);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ path: "Ideas/Reading list.md" }));
  });

  it("says the server's refusal under the field and stays open", async () => {
    srv.refuse = { status: 409, message: "a note already exists at that path" };
    const close = vi.fn();
    render(<RenameNoteDialog note={{ id: "n1", path: "Reading.md" }} onDone={() => {}} onClose={close} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The note wasn't renamed. A note already exists at that path.");
    expect(close).not.toHaveBeenCalled();
  });

  it("a slash is refused before anything is sent", async () => {
    render(<RenameNoteDialog note={{ id: "n1", path: "Reading.md" }} onDone={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ideas/Reading" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/can't contain a slash/);
    expect(posts()).toEqual([]);
  });
});

describe("Move", () => {
  it("offers every folder but where it is now, and a folder never into itself", () => {
    render(<MoveDialog item={{ kind: "folder", path: "Ideas" }} folders={["04-Projects", "Ideas", "Ideas/Sub", "Travel"]} onDone={() => {}} onClose={() => {}} />);
    const radios = screen.getAllByRole("radio").map((r) => [r.textContent, (r as HTMLButtonElement).disabled]);
    expect(radios).toEqual([
      ["Top folderhere now", true],
      ["Projects", false],
      ["Travel", false],
    ]);
  });

  it("moves a note to the folder picked, its links following", async () => {
    const done = vi.fn();
    render(<MoveDialog item={{ kind: "note", id: "n1", path: "Ideas/Reading.md", title: "Reading" }} folders={["Ideas", "Travel"]} onDone={done} onClose={() => {}} />);
    expect((screen.getByRole("button", { name: "Move here" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Travel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await settle();
    expect(posts()).toEqual([{ method: "POST", url: "/api/vault/move", body: { fromPath: "Ideas/Reading.md", toPath: "Travel/Reading.md", links: true } }]);
    expect(done).toHaveBeenCalledWith("Travel/Reading.md");
  });

  it("a folder goes with everything in it", async () => {
    render(<MoveDialog item={{ kind: "folder", path: "Ideas/Sub" }} folders={["Ideas", "Ideas/Sub", "Travel"]} onDone={() => {}} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Top folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Move here" }));
    await settle();
    expect(posts()).toEqual([{ method: "POST", url: "/api/vault/folder/move", body: { from: "Ideas/Sub", to: "Sub" } }]);
  });
});

describe("a folder to the trash", () => {
  it("asks first, saying how many notes go with it", async () => {
    const after = vi.fn();
    render(<Confirm request={trashFolderRequest("Ideas/Old", 3, after)} onClose={() => {}} />);
    expect(screen.getByRole("alertdialog").textContent).toMatch(/Move “Old” to the trash\?All 3 notes in it go too/);
    expect(posts()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Move to the trash" }));
    await settle();
    expect(posts()).toEqual([{ method: "POST", url: "/api/vault/folder/trash", body: { folder: "Ideas/Old" } }]);
    expect(after).toHaveBeenCalled();
  });
});

describe("the Trash view", () => {
  it("lists what's there with where it came from; Restore puts one back", async () => {
    srv.trash = [
      { path: ".trash/Ideas/Reading.md", from: "Ideas/Reading.md", title: "Reading", kind: "note", at: Date.UTC(2026, 9, 21, 9), canRestore: true },
      { path: ".trash/04-Projects/x/scan.pdf", from: "04-Projects/x/scan.pdf", title: "scan.pdf", kind: "file", at: Date.UTC(2026, 9, 20, 9), canRestore: false },
    ];
    const changed = vi.fn();
    render(<TrashView onOpen={() => {}} onChanged={changed} ask={() => {}} />);
    const list = within(await screen.findByRole("list", { name: "In the trash" }));
    expect(list.getAllByRole("listitem").map((r) => r.textContent)).toEqual([
      expect.stringContaining("Readingfrom Ideas"),
      expect.stringContaining("scan.pdffrom Projects / x"),
    ]);
    expect(list.getByText("read-only")).toBeTruthy();
    fireEvent.click(list.getByRole("button", { name: "Restore “Reading”" }));
    await settle();
    expect(posts()).toEqual([{ method: "POST", url: "/api/vault/trash/restore", body: { path: ".trash/Ideas/Reading.md" } }]);
    expect(changed).toHaveBeenCalled();
  });

  it("Empty trash asks first, and only then deletes", async () => {
    srv.trash = [{ path: ".trash/A.md", from: "A.md", title: "A", kind: "note", at: 1, canRestore: true }];
    const ask = vi.fn();
    render(<TrashView onOpen={() => {}} onChanged={() => {}} ask={ask} />);
    fireEvent.click(await screen.findByRole("button", { name: "Empty trash" }));
    expect(posts()).toEqual([]);
    const req = ask.mock.calls[0]![0] as { body: string; onConfirm: () => Promise<unknown> };
    expect(req.body).toBe("1 note is deleted for good. This can't be undone.");
    await act(async () => {
      await req.onConfirm();
    });
    expect(posts()).toEqual([{ method: "POST", url: "/api/vault/trash/empty", body: undefined }]);
  });

  it("an empty trash says so", async () => {
    render(<TrashView onOpen={() => {}} onChanged={() => {}} ask={() => {}} />);
    expect(await screen.findByText("The trash is empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Empty trash" })).toBeNull();
  });
});

describe("History", () => {
  it("lists versions newest first; one opens onto what changed since, and Restore hands its text back", async () => {
    const restore = vi.fn();
    render(<HistorySheet noteId="n1" title="Soup" current={"# Soup\nLeeks\nPotatoes\n"} me={{ id: "me" }} canEdit onRestore={restore} onClose={() => {}} />);
    const rows = await screen.findAllByRole("button", { expanded: false });
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/· now.*you · 30 characters/), expect.stringMatching(/outside Orrama · 12 characters/)]);
    fireEvent.click(rows[1]!);
    expect(await screen.findByText("Since this version: 1 line added.")).toBeTruthy();
    expect(screen.getByLabelText("What changed since this version").textContent).toContain("+Potatoes");
    fireEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    expect(restore).toHaveBeenCalledWith("# Soup\nLeeks\n", Date.UTC(2026, 9, 1, 9));
  });
});

describe("the tree's ⋯ and drag", () => {
  const note = (id: string, path: string): TreeNote => ({
    id,
    path,
    folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    title: path.split("/").pop()!.replace(/\.md$/, ""),
    hash: "",
    mtimeMs: 0,
    tags: [],
    openTasks: 0,
    category: "other",
  });
  const actions = () => ({
    noteMenu: vi.fn(() => [{ label: "Rename…", onSelect: () => {} }]),
    folderMenu: vi.fn(() => [{ label: "New folder here", onSelect: () => {} }]),
    onDropNote: vi.fn(),
    onDropFolder: vi.fn(),
  });

  it("an empty folder shows; every row has a ⋯ that opens its menu, and so does a right-click", () => {
    localStorage.setItem("orrama-tree-closed", "[]");
    const a = actions();
    render(<FileTree notes={[note("r", "Ideas/Reading.md")]} folders={["Ideas", "Empty one"]} activeId={null} onOpen={() => {}} hrefOf={() => "#"} actions={a} />);
    expect(screen.getByRole("button", { name: /^Empty one/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More for Reading" }));
    expect(a.noteMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "r" }));
    expect(screen.getByRole("menuitem", { name: "Rename…" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Ideas/ }));
    expect(a.folderMenu).toHaveBeenCalledWith("Ideas", 1);
  });

  it("a note dropped on a folder moves there; a folder never into itself", () => {
    localStorage.setItem("orrama-tree-closed", "[]");
    const a = actions();
    render(<FileTree notes={[note("r", "Ideas/Reading.md"), note("t", "Travel/Lisbon.md")]} folders={["Ideas", "Ideas/Sub", "Travel"]} activeId={null} onOpen={() => {}} hrefOf={() => "#"} actions={a} />);
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", get types() { return [...data.keys()]; }, dropEffect: "", effectAllowed: "" };
    const travel = screen.getByRole("button", { name: /^Travel/ }).parentElement!;
    fireEvent.dragStart(screen.getByRole("link", { name: /Reading/ }), { dataTransfer });
    fireEvent.dragOver(travel, { dataTransfer });
    expect(travel.className).toContain("drop");
    fireEvent.drop(travel, { dataTransfer });
    expect(a.onDropNote).toHaveBeenCalledWith("r", "Travel");
    data.clear();
    fireEvent.dragStart(screen.getByRole("button", { name: /^Ideas/ }), { dataTransfer });
    fireEvent.drop(screen.getByRole("button", { name: /^Sub/ }).parentElement!, { dataTransfer });
    expect(a.onDropFolder).not.toHaveBeenCalled();
    fireEvent.drop(travel, { dataTransfer });
    expect(a.onDropFolder).toHaveBeenCalledWith("Ideas", "Travel");
  });
});
