/**
 * The Notes page as the boards draw it (structure.md §2.3, R7): Notes home with its pins,
 * recent notes, inbox and counts; relations in words in the side panel (typed on a vault with
 * an ontology, links on one without); Make this a project only on ordinary notes (§8 #7); Show
 * in the Orrery on the note's own slug; a pin written into the note's front matter; a tag that
 * filters the tree. The real router runs, as App drives it.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeHref, useRoute } from "./ui/router.js";
import { usePageTitleFor } from "./entity/title.js";

const srv = vi.hoisted(() => ({
  typed: true,
  puts: [] as { path: string; content: string }[],
  posts: [] as string[],
}));

vi.mock("./ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("./Editor.js", () => ({ Editor: () => <div data-testid="editor" /> }));

const NOW = Date.now();
const T = (id: string, path: string, extra: Partial<{ tags: string[]; mtimeMs: number; openTasks: number; category: string }> = {}) => ({
  id,
  path,
  folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
  title: path.split("/").pop()!.replace(/\.md$/, ""),
  hash: "",
  tags: extra.tags ?? [],
  openTasks: extra.openTasks ?? 0,
  category: extra.category ?? "school",
  mtimeMs: extra.mtimeMs ?? NOW - 86_400_000 * 30,
});
const TREE = [
  T("old", "Archive/Old note.md", { mtimeMs: NOW - 86_400_000 * 90 }),
  T("plan", "04-Projects/graduation-thesis/Research plan.md", { tags: ["project/graduation-thesis", "thesis"], mtimeMs: NOW - 60_000 }),
  T("thesis", "04-Projects/graduation-thesis.md", { tags: ["project/thesis"] }),
  T("ines", "01-Me/Contacts/Ines Vermaat.md", { tags: ["contact"], category: "personal" }),
  T("kade", "Contacts/Companies/Kade Social.md", { tags: ["company"], category: "work" }),
  T("ideas", "Ideas.md", { mtimeMs: NOW - 120_000, tags: ["thesis"] }),
  T("chat", "Conversations/Forecast chat.md", { category: "tools" }),
  T("inbox", "Personal/jules/Inbox.md", { openTasks: 4 }),
  // A session note titled by its id: the server names it by kind, date and gist (F3).
  { ...T("sess", "Claude Sessions/394a1725.md", { category: "tools" }), title: "Conversation, 4 Jun 2026: Tidying the reading list" },
];
const CONTENT: Record<string, string> = {
  plan: "---\ntags:\n  - project/graduation-thesis\n  - thesis\ndeadline: 2026-10-19\n---\nAsk [[Ines Vermaat]] and [[Kade Social]].\n",
  thesis: "---\ntags:\n  - project/thesis\n---\n# Graduation thesis\n",
  old: "# Old\n",
  ines: "---\ntags:\n  - contact\n---\nSupervisor.\n",
  kade: "---\ntags:\n  - company\n---\nAgency.\n",
  ideas: "---\nid: n-ideas\n---\n# Ideas\n\nSee [[Research plan]].\n",
  chat: "---\ntype: claude-session\n---\nTranscript.\n",
  inbox: "# Inbox\n- [ ] one\n",
  sess: "---\ntitle: 394a1725\ntype: claude-session\n---\n**Jules:** Tidy the reading list.\n",
};
const LINKS: Record<string, { target: string; targetId: string | null; locked: boolean; raw: string; line: number }[]> = {
  plan: [
    { target: "Ines Vermaat", targetId: "ines", locked: false, raw: "[[Ines Vermaat]]", line: 5 },
    { target: "Kade Social", targetId: "kade", locked: false, raw: "[[Kade Social]]", line: 5 },
  ],
  ideas: [{ target: "Research plan", targetId: "plan", locked: false, raw: "[[Research plan]]", line: 4 }],
};

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  return {
    ...real,
    api: async (method: string, url: string, body?: { path: string; content: string }) => {
      if (method === "PUT" && body) {
        srv.puts.push(body);
        return { content: body.content, hash: `h:${body.content.length}`, path: body.path };
      }
      if (method === "POST") {
        srv.posts.push(url);
        return {};
      }
      if (url === "/api/vault/tree") return TREE;
      if (url === "/api/notes/overview") return { pinned: ["thesis"], notes: 6, conversations: 1, openTasks: 12, doneTasks: 30 };
      // The project's slug is not its file name: only the projects list knows it.
      if (url === "/api/projects") return [{ slug: "thesis", name: "Graduation thesis", noteId: "thesis" }];
      if (url === "/api/graph/schema") return { types: srv.typed ? [{ id: "person", count: 1, description: "" }] : [] };
      if (url.startsWith("/api/graph/relations")) {
        const id = decodeURIComponent(url.split("entity=")[1]!);
        const type = id === "ines" ? "person" : id === "chat" ? "conversation" : "note";
        const relations =
          id === "plan"
            ? [
                { relation: "part_of", to: [{ id: "thesis", title: "Graduation thesis", type: "project", via: "tag", where: "tag", source: { id: "plan", title: "Research plan" } }] },
                {
                  relation: "supervised_by",
                  to: [{ id: "ines", title: "Ines Vermaat", type: "person", via: "derived", where: "", source: { id: "plan", title: "Research plan" }, through: [{ id: "thesis", title: "Graduation thesis" }] }],
                },
              ]
            : [];
        return { entity: { id, title: id, type, summary: "", fields: {} }, relations, warnings: [] };
      }
      const m = /^\/api\/vault\/note\/([^/]+)$/.exec(url);
      if (method === "GET" && m) {
        const id = m[1]!;
        const t = TREE.find((n) => n.id === id)!;
        const backlinks = id === "plan" ? [{ fromId: "ideas", fromTitle: "Ideas", fromPath: "Ideas.md", line: 4, context: "See [[Research plan]]." }] : [];
        return { id, path: t.path, title: t.title, content: CONTENT[id], hash: "h", tags: t.tags.map((tag) => ({ tag, line: 1 })), tasks: [], links: LINKS[id] ?? [], backlinks, canEdit: true };
      }
      return [];
    },
  };
});

const { Notes } = await import("./Notes.js");
const { resetNoteSyncs } = await import("./noteSync.js");
const me = { id: "u-1", username: "jules", displayName: "Jules" } as never;
function Routed() {
  const r = useRoute();
  const n = r?.kind === "notes" ? r : null;
  return <Notes me={me} noteId={n?.id} notePath={n?.path} />;
}
const flush = async () => {
  await act(async () => {});
  await act(async () => {});
};
const at = (href: string) => history.replaceState(null, "", href);
const path = () => decodeURIComponent(location.pathname + location.search);
const side = () => within(screen.getByRole("complementary", { name: "About this note" }));
const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "More" }));

beforeEach(() => {
  srv.typed = true;
  srv.puts = [];
  srv.posts = [];
  localStorage.clear();
  resetNoteSyncs();
  at("/notes");
});

describe("Notes home", () => {
  it("shows recent notes, pins, the inbox and the counts that left Today; a row opens its note", async () => {
    render(<Routed />);
    await flush();
    const home = within(document.querySelector(".nt-home") as HTMLElement);
    expect(home.getByText("6 notes · 1 conversation")).toBeTruthy();
    expect(home.getByText("12 open tasks")).toBeTruthy();
    const recent = within(home.getByRole("group", { name: "Recent notes" }));
    expect(recent.getAllByRole("link").map((a) => a.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("Research plan"), expect.stringContaining("Ideas")]));
    expect(recent.getAllByRole("link")[0]!.textContent).toContain("Research plan"); // newest first
    expect(within(home.getByRole("group", { name: "Pinned notes" })).getByText("graduation-thesis")).toBeTruthy();
    expect(home.getByText("4 to sort")).toBeTruthy();
    expect(home.getByRole("link", { name: /Open the Orrery/ }).getAttribute("href")).toBe("/orrery");
    fireEvent.click(recent.getAllByRole("link")[0]!);
    await flush();
    expect(path()).toBe("/notes/04-Projects/graduation-thesis/Research plan");
  });
});

describe("the note's name", () => {
  /** What the window title and the phone's top bar say for this address (App reads it so). */
  function Titled() {
    const r = useRoute();
    const title = usePageTitleFor(r ? routeHref(r) : "");
    return (
      <>
        <Routed />
        <output data-testid="page-title">{title ?? ""}</output>
      </>
    );
  }

  it("the window says the note's name as the page does, not its file name (F3)", async () => {
    at("/notes/Claude Sessions/394a1725");
    render(<Titled />);
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Conversation, 4 Jun 2026: Tidying the reading list" })).toBeTruthy();
    expect(screen.getByTestId("page-title").textContent).toBe("Conversation, 4 Jun 2026: Tidying the reading list");
  });
});

describe("the side panel's relations", () => {
  it("on a typed vault: relations in words, a derived one with what it goes through, and what the note mentions", async () => {
    at("/notes/04-Projects/graduation-thesis/Research plan");
    render(<Routed />);
    await flush();
    const rel = within(side().getByRole("region", { name: "Relations" }));
    expect(rel.getByText("part of")).toBeTruthy();
    expect(rel.getByText("supervised by")).toBeTruthy();
    expect(rel.getByText(/via Graduation thesis/)).toBeTruthy();
    // Ines is told by the graph already; Kade only by a link: "mentions" says it once.
    expect(rel.getByText("mentions").parentElement!.textContent).toContain("Kade Social");
    expect(rel.getByText("mentions").parentElement!.textContent).not.toContain("Ines Vermaat");
  });

  it("on a vault without an ontology: the note's links, both ways", async () => {
    srv.typed = false;
    at("/notes/04-Projects/graduation-thesis/Research plan");
    render(<Routed />);
    await flush();
    const rel = within(side().getByRole("region", { name: "Relations" }));
    expect(rel.queryByText("part of")).toBeNull();
    expect(rel.getByText("mentions").parentElement!.textContent).toMatch(/Ines Vermaat.*Kade Social/);
    expect(rel.getByText("mentioned in").parentElement!.textContent).toContain("Ideas");
  });
});

describe("the note's menu and links", () => {
  it("Make this a project is offered on an ordinary note only (§8 #7)", async () => {
    at("/notes/Ideas");
    render(<Routed />);
    await flush();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Make this a project" }));
    await flush();
    expect(srv.posts).toContain("/api/projects/promote");
    for (const where of ["/notes/01-Me/Contacts/Ines Vermaat", "/notes/Conversations/Forecast chat", "/notes/04-Projects/graduation-thesis/Research plan"]) {
      await act(async () => at(where));
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
      await flush();
      openMenu();
      expect(screen.queryByRole("menuitem", { name: "Make this a project" })).toBeNull();
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await flush();
    }
  });

  it("Show in the Orrery centres the note: a project by its slug, a note by its file name", async () => {
    at("/notes/04-Projects/graduation-thesis");
    render(<Routed />);
    await flush();
    expect(screen.getByRole("link", { name: /Show in the Orrery/ }).getAttribute("href")).toBe("/orrery?center=thesis");
    await act(async () => at("/notes/Ideas"));
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await flush();
    expect(screen.getByRole("link", { name: /Show in the Orrery/ }).getAttribute("href")).toBe("/orrery?center=ideas");
  });

  it("Pin writes pinned: true into the note's front matter, and nothing else", async () => {
    at("/notes/Ideas");
    render(<Routed />);
    await flush();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin to Notes home" }));
    await flush();
    expect(srv.puts.at(-1)!.content).toBe("---\nid: n-ideas\npinned: true\n---\n# Ideas\n\nSee [[Research plan]].\n");
  });

  it("a tag filters the tree to the notes carrying it", async () => {
    at("/notes/Ideas");
    render(<Routed />);
    await flush();
    at("/notes/04-Projects/graduation-thesis/Research plan");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await flush();
    fireEvent.click(side().getByRole("button", { name: "#thesis" }));
    expect((screen.getByLabelText("Filter notes") as HTMLInputElement).value).toBe("#thesis");
    const matches = within(screen.getByLabelText("Notes matching the filter"));
    expect(matches.getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringContaining("Research plan"), expect.stringContaining("Ideas")]);
  });

  it("a life area filters the tree, and the menu puts it back to all notes", async () => {
    render(<Routed />);
    await flush();
    fireEvent.click(within(screen.getByRole("group", { name: "Life areas" })).getByText("Work"));
    await flush();
    const tree = within(screen.getByRole("complementary", { name: "Notes" }));
    fireEvent.click(tree.getByRole("button", { name: /Contacts/ }));
    fireEvent.click(tree.getByRole("button", { name: /Companies/ }));
    expect(tree.getByText("Kade Social")).toBeTruthy();
    expect(tree.queryByRole("button", { name: /^Me\s*\d+$/ })).toBeNull(); // Ines is Personal
    fireEvent.click(tree.getByRole("button", { name: /Show all notes/ }));
    expect(tree.getByRole("button", { name: /^Me\s*\d+$/ })).toBeTruthy();
  });
});
