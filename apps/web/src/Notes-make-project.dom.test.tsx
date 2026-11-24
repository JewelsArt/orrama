/**
 * Make a project from a note (N2), from the Notes page: the ⋯ menu offers it (and a note in a
 * project says which, with "Make a new project anyway" there only), the dialog is prefilled
 * from the note and leaves it where it is unless asked, the page goes to the new project with
 * a toast whose Undo moves the note back first, then deletes the project, then gives the note
 * back to the project it left. The palette (⌘K) gets the same offer while the note is open.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAreasForTest } from "./categories.js";
import { pageActions } from "./ui/pageActions.js";
import { useRoute } from "./ui/router.js";

type Note = { path: string; content: string; tags: string[]; tasks: { text: string; checked: boolean }[]; category: string; mtimeMs?: number };
const srv = vi.hoisted(() => ({
  notes: new Map<string, Note>(),
  posts: [] as { url: string; body: unknown }[],
  projects: [] as { slug: string; name: string; noteId: string | null; group: string | null }[],
  made: null as null | Record<string, unknown>,
  /** Live-sync listeners, and a note read the test holds back until it lets it go. */
  ws: new Set<(m: { type: string; noteId?: string }) => void>(),
  held: null as null | Promise<void>,
}));

vi.mock("./ws.js", () => ({ onWs: (l: (m: { type: string; noteId?: string }) => void) => (srv.ws.add(l), () => srv.ws.delete(l)), sendEditing: () => {} }));
vi.mock("./Editor.js", () => ({ Editor: () => <div data-testid="editor" /> }));

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  const title = (p: string) => p.split("/").pop()!.replace(/\.md$/, "");
  const tree = () =>
    [...srv.notes].map(([id, n]) => ({ id, path: n.path, folder: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "", title: title(n.path), hash: "h", mtimeMs: n.mtimeMs ?? 0, tags: n.tags, openTasks: n.tasks.filter((t) => !t.checked).length, category: n.category }));
  return {
    ...real,
    api: async (method: string, url: string, body?: Record<string, unknown>) => {
      if (method === "POST") srv.posts.push({ url, body });
      if (method === "POST" && url === "/api/projects/from-note") {
        const from = srv.notes.get(body!["noteId"] as string)!;
        const slug = String(body!["name"]).toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const moved = body!["move"] === true;
        const was = from.path;
        const at = moved ? `04-Projects/${slug}/${from.path.split("/").pop()}` : from.path;
        // The server moved it and says so on the live socket while the request is still open.
        if (moved) {
          from.path = at;
          for (const l of [...srv.ws]) l({ type: "note-changed", noteId: body!["noteId"] as string });
        }
        srv.made = { slug, key: `project/${slug}`, projectNoteId: `p-${slug}`, projectPath: `04-Projects/${slug}.md`, note: { id: body!["noteId"], path: at, from: was, moved }, left: from.tags.find((t) => t.startsWith("project/")) ?? null, tasks: from.tasks.filter((t) => !t.checked).length };
        return srv.made;
      }
      if (method === "POST" && url === "/api/vault/move") return { id: "x", path: body!["toPath"], links: 0, notes: 0 };
      if (method === "POST") return { ok: true };
      if (url === "/api/vault/tree") return tree();
      if (url === "/api/vault/folders") return [];
      if (url === "/api/projects") return srv.projects;
      if (url === "/api/notes/overview") return { pinned: [], notes: srv.notes.size, conversations: 0, openTasks: 0, doneTasks: 0 };
      if (url === "/api/graph/schema") return { types: [] };
      const m = /^\/api\/vault\/note\/([^/?]+)$/.exec(url);
      if (method === "GET" && m) {
        if (srv.held) await srv.held;
        const n = srv.notes.get(m[1]!);
        if (!n) throw new real.ApiError(404, "note not found");
        return { id: m[1], path: n.path, title: title(n.path), content: n.content, hash: "h", tags: n.tags.map((tag) => ({ tag, line: 0 })), tasks: n.tasks.map((t, i) => ({ ...t, line: 5 + i, status: t.checked ? "done" : "todo" })), links: [], backlinks: [], canEdit: true };
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
      {n ? <Notes me={me} noteId={n.id} notePath={n.path} /> : <p>Elsewhere</p>}
      <Toaster />
    </>
  );
}
const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => {});
};
const at = (href: string) => history.replaceState(null, "", href);
const path = () => decodeURIComponent(location.pathname + location.search);
const menu = () => fireEvent.click(screen.getByRole("button", { name: "More" }));
const items = () => screen.getAllByRole("menuitem").map((m) => m.textContent);

beforeEach(() => {
  setAreasForTest([
    { id: "work", name: "Work", catchAll: false },
    { id: "home", name: "Home", catchAll: false },
    { id: "personal", name: "Personal", catchAll: true },
  ]);
  srv.notes = new Map([
    ["k", { path: "Ideas/Kitchen.md", content: "# Kitchen\n- [ ] Measure\n- [ ] Quotes\n- [x] Colour\n", tags: [], tasks: [{ text: "Measure", checked: false }, { text: "Quotes", checked: false }, { text: "Colour", checked: true }], category: "home" }],
    ["b", { path: "Ideas/Beds.md", content: "---\ntags:\n  - project/allotment\n---\n- [ ] Weed\n", tags: ["project/allotment"], tasks: [{ text: "Weed", checked: false }], category: "home" }],
    ["own", { path: "04-Projects/allotment.md", content: "---\ntags:\n  - project\n  - project/allotment\n---\n", tags: ["project", "project/allotment"], tasks: [], category: "home" }],
    ["c", { path: "01-Me/Contacts/Ines.md", content: "---\ntags:\n  - contact\n---\n", tags: ["contact"], tasks: [], category: "personal" }],
  ]);
  srv.projects = [
    { slug: "allotment", name: "Allotment", noteId: "own", group: "Garden" },
    { slug: "site", name: "Website", noteId: null, group: "Websites" },
  ];
  srv.posts = [];
  srv.made = null;
  srv.held = null;
  localStorage.clear();
  resetNoteSyncs();
});

describe("Make a project from a note", () => {
  it("is offered on a note, not on a person or a project's own note", async () => {
    at("/notes/Ideas/Kitchen");
    const { unmount } = render(<Routed />);
    await flush();
    menu();
    expect(items()).toContain("Make a project…");
    expect(items()).not.toContain("Make this a project");
    unmount();
    for (const where of ["/notes/01-Me/Contacts/Ines", "/notes/04-Projects/allotment"]) {
      at(where);
      const r = render(<Routed />);
      await flush();
      menu();
      expect(items().some((t) => /project/i.test(t ?? "") && !/Orrery/.test(t ?? ""))).toBe(false);
      r.unmount();
    }
  });

  it("is prefilled from the note, leaves it where it is, goes to the project, and Undo deletes the project", async () => {
    at("/notes/Ideas/Kitchen");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make a project…" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Make a project" }));
    expect((dlg.getByLabelText("Name") as HTMLInputElement).value).toBe("Kitchen");
    expect((dlg.getByLabelText("Life area") as HTMLSelectElement).value).toBe("home");
    // The groups the projects already use, then a new one.
    await waitFor(() => expect([...(dlg.getByLabelText("Group (optional)") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["No group", "Garden", "Websites", "New group…"]));
    expect(dlg.getByRole("radio", { name: /Leave it where it is/ }).getAttribute("aria-checked")).toBe("true");
    expect(dlg.getByText("Its 2 open tasks will count for the project.")).toBeTruthy();
    fireEvent.change(dlg.getByLabelText("Group (optional)"), { target: { value: "Garden" } });
    fireEvent.change(dlg.getByLabelText("Due (optional)"), { target: { value: "2027-05-01" } });
    fireEvent.click(dlg.getByRole("button", { name: "Make the project" }));
    await waitFor(() => expect(path()).toBe("/projects/kitchen"));
    expect(srv.posts.filter((p) => p.url === "/api/projects/from-note")).toEqual([{ url: "/api/projects/from-note", body: { noteId: "k", name: "Kitchen", area: "home", group: "Garden", deadline: "2027-05-01" } }]);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Kitchen was taken back.");
    // Not moved, so nothing to move back; no project left, so nothing to give back.
    expect(srv.posts.slice(1).map((p) => p.url)).toEqual(["/api/projects/kitchen/trash"]);
    expect(path()).toBe("/notes/Ideas/Kitchen");
  });

  it("moves the note only when asked, and Undo moves it back before the project goes", async () => {
    at("/notes/Ideas/Kitchen");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make a project…" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Make a project" }));
    fireEvent.click(dlg.getByRole("radio", { name: /Move it into the project's folder/ }));
    // The note read the live-sync event starts answers only after the page has left Notes.
    let release = () => {};
    srv.held = new Promise<void>((r) => (release = r));
    fireEvent.click(dlg.getByRole("button", { name: "Make the project" }));
    await waitFor(() => expect(path()).toBe("/projects/kitchen"));
    srv.held = null;
    await act(async () => release());
    await flush();
    // That late answer (the note, at its new path) does not take the page back to the note.
    expect(path()).toBe("/projects/kitchen");
    expect((srv.posts[0]!.body as { move?: boolean }).move).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Kitchen was taken back.");
    expect(srv.posts.slice(1)).toEqual([
      { url: "/api/vault/move", body: { fromPath: "04-Projects/kitchen/Kitchen.md", toPath: "Ideas/Kitchen.md", links: true } },
      { url: "/api/projects/kitchen/trash", body: undefined },
    ]);
  });

  it("a note in a project says which, and makes a new one only when asked from the ⋯ menu; Undo gives it back", async () => {
    at("/notes/Ideas/Beds");
    render(<Routed />);
    await flush();
    // The palette says where it is, and offers nothing more.
    expect(pageActions().map((a) => a.title)).toEqual(["Already in Allotment"]);
    menu();
    expect(items()).toEqual(expect.arrayContaining(["Already in Allotment", "Make a new project anyway…"]));
    expect(items()).not.toContain("Make a project…");
    fireEvent.click(screen.getByRole("menuitem", { name: "Make a new project anyway…" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Make a new project" }));
    expect(dlg.getByText("It leaves Allotment.")).toBeTruthy();
    fireEvent.change(dlg.getByLabelText("Name"), { target: { value: "Raised beds" } });
    fireEvent.click(dlg.getByRole("button", { name: "Make the project" }));
    await waitFor(() => expect(path()).toBe("/projects/raised-beds"));
    expect(srv.posts[0]!.body).toMatchObject({ noteId: "b", name: "Raised beds", anyway: true });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Raised beds was taken back.");
    expect(srv.posts.slice(1)).toEqual([
      { url: "/api/projects/raised-beds/trash", body: undefined },
      { url: "/api/projects/allotment/notes", body: { noteId: "b" } },
    ]);
  });

  it("chooses the note's life area even when the list of areas arrives after the dialog opened", async () => {
    setAreasForTest([{ id: "personal", name: "Personal", catchAll: true }]);
    at("/notes/Ideas/Kitchen");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make a project…" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Make a project" }));
    act(() =>
      setAreasForTest([
        { id: "work", name: "Work", catchAll: false },
        { id: "home", name: "Home", catchAll: false },
        { id: "personal", name: "Personal", catchAll: true },
      ]),
    );
    expect((dlg.getByLabelText("Life area") as HTMLSelectElement).value).toBe("home");
  });

  it("a note in no listed area is offered the catch-all, and that is what is sent", async () => {
    srv.notes.get("k")!.category = "gone";
    at("/notes/Ideas/Kitchen");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make a project…" }));
    const dlg = within(await screen.findByRole("dialog", { name: "Make a project" }));
    expect((dlg.getByLabelText("Life area") as HTMLSelectElement).value).toBe("personal");
    fireEvent.click(dlg.getByRole("button", { name: "Make the project" }));
    await waitFor(() => expect(srv.posts[0]?.body).toMatchObject({ area: "personal" }));
  });

  it("Recent leaves out a project's own note, and says the folder of two notes with one name", async () => {
    const now = Date.now();
    // Just made from Kitchen: the project's own note, newest of all, under the same name.
    srv.notes.set("pk", { path: "04-Projects/kitchen.md", content: "---\ntags:\n  - project\n  - project/kitchen\n---\n", tags: ["project", "project/kitchen"], tasks: [], category: "home", mtimeMs: now });
    srv.projects.push({ slug: "kitchen", name: "Kitchen", noteId: "pk", group: null });
    srv.notes.get("k")!.mtimeMs = now - 1000;
    srv.notes.set("p1", { path: "Ideas/Plans.md", content: "# Plans\n", tags: [], tasks: [], category: "home", mtimeMs: now - 2000 });
    srv.notes.set("p2", { path: "Garden/Plans.md", content: "# Plans\n", tags: [], tasks: [], category: "home", mtimeMs: now - 3000 });
    at("/notes");
    render(<Routed />);
    await flush();
    const tree = within(document.querySelector(".nt-tree") as HTMLElement);
    const recent = () => {
      const rows: string[] = [];
      let el = tree.getByText("Recent").nextElementSibling;
      while (el && el.tagName === "A") {
        rows.push(el.querySelector("span")!.textContent!);
        el = el.nextElementSibling;
      }
      return rows;
    };
    // The tree's Recent holds four; the newest three are these, the project's note not among them.
    await waitFor(() => expect(recent().slice(0, 3)).toEqual(["Kitchen", "Plans · Ideas", "Plans · Garden"]));
    expect(recent().filter((t) => t.startsWith("Kitchen"))).toEqual(["Kitchen"]);
    // Notes home's Recent, the same list: Kitchen once, the project's note not at all.
    const home = within(document.querySelector(".nt-home") as HTMLElement).getByRole("group", { name: "Recent notes" });
    expect(within(home).getAllByText("Kitchen")).toHaveLength(1);
  });

  it("Already in … opens that project", async () => {
    at("/notes/Ideas/Beds");
    render(<Routed />);
    await flush();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Already in Allotment" }));
    await waitFor(() => expect(path()).toBe("/projects/allotment"));
  });

  it("hands Find the offer while the note is open, and opens the dialog from it", async () => {
    at("/notes/Ideas/Kitchen");
    const { unmount } = render(<Routed />);
    await flush();
    const offer = pageActions();
    expect(offer.map((a) => [a.title, a.meta])).toEqual([["Make a project from this note", "Kitchen"]]);
    act(() => offer[0]!.run());
    expect(await screen.findByRole("dialog", { name: "Make a project" })).toBeTruthy();
    unmount();
    expect(pageActions()).toEqual([]);
  });
});
