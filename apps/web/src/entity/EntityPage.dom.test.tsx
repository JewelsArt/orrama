/**
 * The entity page (structure.md §2.6): a person, a company, a conversation and a document at
 * their addresses, with facts, relations in words both ways, how you know them, what is going on
 * with them, then the note; Orr's own warnings on top with their fix. On a vault without an
 * ontology it still works: plain links, and no empty boxes. A person's sector is written by the
 * server, never by editing the note's text in the browser (WEB-022, moved here from People's
 * sheet). Fictional people only.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; body: unknown }[],
  typed: true,
  patch: null as null | (() => never),
}));

vi.mock("../ws.js", () => ({ onWs: () => () => {}, sendEditing: () => {} }));
vi.mock("../Editor.js", () => ({ Editor: (p: { content: string }) => <div data-testid="editor">{p.content}</div> }));
vi.mock("../DocViewer.js", () => ({ DocViewer: (p: { name: string; inline?: boolean }) => <div data-testid="reader">{`${p.inline ? "inline" : "sheet"}:${p.name}`}</div> }));
vi.mock("../noteSync.js", () => ({ openNoteSync: () => null, retire: () => {} }));

const ines = { id: "n-ines", name: "Ines Vermaat", path: "Contacts/Ines Vermaat.md", sector: "University", role: "Thesis supervisor", company: "[[Westerdok]]", email: "ines@westerdok.example", phone: "", linkedin: "", personal: false };
const thijs = { ...ines, id: "n-thijs", name: "Thijs Brouwer", path: "Contacts/Thijs Brouwer.md", role: "Data lead", company: "[[Kade Social]]", email: "thijs@kadesocial.example", sector: "Other" };
const jules = { ...ines, id: "n-jules", name: "Jules Demo", path: "Contacts/Jules Demo.md", role: "Student", company: "[[Kade Social]]", email: "jules@orrama.dev", sector: "Other" };
const pieter = { ...ines, id: "n-pieter", name: "Pieter Bakker", path: "Contacts/Pieter Bakker.md", role: "Owner", company: "Bakker & Zn", email: "", sector: "Other" };
const company = (id: string, name: string, extra = {}) => ({ id, name, path: `Contacts/Companies/${name}.md`, description: "", sector: "Marketing", linkedin: "", website: "", careers: "", location: "", positions: [], personal: false, ...extra });
const westerdok = company("n-westerdok", "Westerdok", { sector: "University" });
const kade = company("n-kade", "Kade Social", { description: "Social-media agency", website: "kade.example" });
const tree = (id: string, path: string, title: string, category = "work") => ({ id, path, folder: path.split("/").slice(0, -1).join("/"), title, hash: "h", mtimeMs: 1_790_000_000_000, tags: [], openTasks: 0, category });
const TREE = [
  tree(ines.id, ines.path, ines.name),
  tree(thijs.id, thijs.path, thijs.name),
  tree(jules.id, jules.path, jules.name),
  tree(pieter.id, pieter.path, pieter.name),
  tree(westerdok.id, westerdok.path, westerdok.name),
  tree(kade.id, kade.path, kade.name),
  tree("n-thesis", "04-Projects/graduation-thesis.md", "Graduation thesis", "school"),
  tree("n-drinks", "Shared/Kade drinks.md", "Kade drinks"),
  tree("n-talk", "07-Claude/Scoping the question.md", "Scoping the question", "tools"),
  tree("n-ch1", "04-Projects/graduation-thesis/Chapter 1.md", "Chapter 1"),
];
const brief = (id: string, title: string, type: string) => ({ id, title, type });
const thesis = brief("n-thesis", "Graduation thesis", "project");
const relations: Record<string, { relation: string; to: ReturnType<typeof brief>[] }[]> = {
  "n-ines": [
    { relation: "supervises", to: [thesis] },
    { relation: "involved_in", to: [thesis] },
    { relation: "works_at", to: [brief("n-westerdok", "Westerdok", "company")] },
  ],
  "n-kade": [{ relation: "employs", to: [brief("n-thijs", "Thijs Brouwer", "person")] }],
  "n-talk": [{ relation: "about", to: [thesis] }],
  "n-ch1": [{ relation: "part_of", to: [thesis] }],
};
const NOTE_TEXT: Record<string, string> = {
  "n-talk": "---\ntype: conversation\ndate: 2026-10-01\n---\n**Date:** 2026-10-01\n\n**Jules:** Help me scope the question.\n\n**Claude:** Start from what you can measure.\n",
};

vi.mock("../api.js", async (orig) => {
  const real = await orig<typeof import("../api.js")>();
  const relRows = (id: string) => (server.typed ? (relations[id] ?? []).map((g) => ({ relation: g.relation, to: g.to.map((t) => ({ ...t, via: "field", where: "x", source: { id, title: "x" } })) })) : []);
  return {
    ...real,
    api: async (method: string, url: string, body?: unknown) => {
      server.calls.push({ method, url, body });
      const path = url.replace(/\?.*$/, "");
      if (method === "PATCH" && server.patch) server.patch();
      if (method !== "GET") return { ok: true };
      switch (path) {
        case "/api/contacts":
          return [ines, thijs, jules, pieter];
        case "/api/companies":
          return [westerdok, kade];
        case "/api/projects":
          return [{ slug: "graduation-thesis", noteId: "n-thesis", name: "Graduation thesis", key: "project/graduation-thesis", domain: "academic", total: 3, done: 1, status: "on-track", start: null, deadline: null, group: null, nextDue: null, overdue: 0 }];
        case "/api/vault/graph":
          return { nodes: TREE.map((n) => ({ id: n.id, title: n.title, folder: n.folder, sector: null, tags: [], links: 0, tasks: 0, kind: n.id === "n-talk" ? "conversation" : "note", description: "" })), edges: [] };
        case "/api/vault/tree":
          return TREE;
        case "/api/graph/relations": {
          const id = new URLSearchParams(url.split("?")[1]).get("entity")!;
          return { entity: { id, title: id, type: "person", summary: "", fields: {} }, relations: relRows(id), warnings: [] };
        }
        case "/api/graph/warnings":
          return {
            typed: server.typed,
            ontology: null,
            warnings: server.typed ? [{ code: "unresolved-object", message: "x", note: { id: "n-pieter", title: "Pieter Bakker", type: "person", path: pieter.path }, relation: "works_at", target: "Bakker & Zn" }] : [],
          };
        case "/api/people/context":
          return {
            typed: server.typed,
            entries: server.typed
              ? [
                  { id: "n-ines", relations: relations["n-ines"], mention: { id: "n-drinks", title: "Kade drinks", at: "2026-09-25" } },
                  { id: "n-thijs", relations: [{ relation: "involved_in", to: [thesis] }], mention: null },
                ]
              : [{ id: "n-ines", relations: [], mention: { id: "n-drinks", title: "Kade drinks", at: "2026-09-25" } }],
          };
        case "/api/graph/path":
          return server.typed
            ? {
                found: true,
                length: 3,
                paths: [
                  [
                    { from: brief("n-jules", "Jules Demo", "person"), relation: "works_at", to: brief("n-kade", "Kade Social", "company"), via: "field", where: "company" },
                    { from: brief("n-kade", "Kade Social", "company"), relation: "company_involved_in", to: thesis, via: "derived", where: "x" },
                    { from: thesis, relation: "supervised_by", to: brief("n-ines", "Ines Vermaat", "person"), via: "inverse", where: "x" },
                  ],
                ],
              }
            : { found: false, paths: [] };
        case "/api/tasks":
          return [{ noteId: "n-thesis", notePath: "04-Projects/graduation-thesis.md", noteTitle: "Graduation thesis", project: "Graduation thesis", line: 9, checked: false, status: "todo", text: "Send Ines Vermaat the revised section 3", raw: "", indent: 0, due: "2026-10-16", object: null }];
        case "/api/events":
          return [{ id: "ev-1", ownerId: "u", username: "jules", mine: true, title: "Supervision with Ines Vermaat", date: "2026-10-21", startMin: 960, durationMin: 60 }];
        case "/api/mail/account":
          return { connected: false, email: null, imapHost: null, lastCheckedAt: null, lastError: null };
        case "/api/projects/graduation-thesis":
          return { files: [{ name: "Research plan.pdf", size: 12_700, mtimeMs: 1_790_000_000_000, ext: ".pdf" }] };
      }
      if (path.startsWith("/api/vault/note/")) {
        const id = path.slice("/api/vault/note/".length);
        const t = TREE.find((n) => n.id === id)!;
        const backlinks = id === "n-ines" ? [{ fromId: "n-drinks", fromTitle: "Kade drinks", fromPath: "Shared/Kade drinks.md", line: 3, context: "" }] : [];
        const links = id === "n-ines" ? [{ target: "Westerdok", raw: "[[Westerdok]]", line: 8, targetId: "n-westerdok", locked: false }] : [];
        return { id, path: t.path, title: t.title, content: NOTE_TEXT[id] ?? `# ${t.title}\n`, hash: "h", tags: [], tasks: [], links, backlinks, canEdit: true };
      }
      return [];
    },
  };
});

const { EntityPage } = await import("./EntityPage.js");
const me = { id: "u-1", username: "jules", email: "jules@orrama.dev", displayName: "Jules", isOwner: true } as never;

beforeEach(() => {
  server.calls = [];
  server.typed = true;
  server.patch = null;
  history.replaceState(null, "", "/");
});
afterEach(cleanup);

// The heading comes with the lists; what the page asks for next (relations, the note, the path,
// activity) lands a moment later, after effects React may run late on a loaded machine. So a
// test finds what it is about (findBy…), never reads it at once after the heading.
const show = async (route: Parameters<typeof EntityPage>[0]["route"]) => {
  render(<EntityPage me={me} route={route} />);
  await screen.findByRole("heading", { level: 1 });
};
const relationRow = async (word: string) => (await screen.findByText(word, { selector: ".ent-rel-row .k" })).closest(".ent-rel-row") as HTMLElement;
const linkNamed = (name: string, within_: HTMLElement = document.body) => within(within_).getByRole("link", { name: new RegExp(name) });

describe("a person", () => {
  it("says who they are, with facts, and every name opens its thing", async () => {
    await show({ kind: "person", slug: "ines-vermaat" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ines Vermaat");
    const facts = document.querySelector(".ent-facts") as HTMLElement;
    expect(within(facts).getByText("Works at")).toBeTruthy();
    expect(linkNamed("Westerdok", facts).getAttribute("href")).toBe("/companies/westerdok");
    expect(await within(facts).findByText("Last in touch")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Show in the Orrery" })[0]!.getAttribute("href")).toBe("/orrery?center=ines-vermaat");
  });

  it("relates in words, both directions, each note once under its strongest word", async () => {
    await show({ kind: "person", slug: "ines-vermaat" });
    expect(linkNamed("Graduation thesis", await relationRow("supervises")).getAttribute("href")).toBe("/projects/graduation-thesis");
    expect(screen.queryByText("involved in", { selector: ".ent-rel-row .k" })).toBeNull(); // said as "supervises", from the same answer
    expect(linkNamed("Westerdok", await relationRow("works at")).getAttribute("href")).toBe("/companies/westerdok");
    const ww = await relationRow("works with");
    expect(linkNamed("Thijs Brouwer", ww).getAttribute("href")).toBe("/people/thijs-brouwer");
    expect(ww.textContent).toContain("both on Graduation thesis");
    expect(linkNamed("Kade drinks", await relationRow("mentioned in")).getAttribute("href")).toBe("/notes/Shared/Kade%20drinks");
  });

  it("says how you know them when the path is short and not direct", async () => {
    await show({ kind: "person", slug: "ines-vermaat" });
    const path = await screen.findByRole("region", { name: "How you know Ines Vermaat" });
    expect(path.textContent).toMatch(/Jules Demo.*works at.*Kade Social.*Graduation thesis.*Ines Vermaat/);
    expect(server.calls.some((c) => c.url === "/api/graph/path?from=n-jules&to=n-ines")).toBe(true);
  });

  it("lists what is going on with them: an event and a step that name them", async () => {
    await show({ kind: "person", slug: "ines-vermaat" });
    const act_ = await screen.findByRole("region", { name: "With Ines" });
    expect((await within(act_).findByRole("link", { name: /Supervision with Ines Vermaat/ })).getAttribute("href")).toBe("/planning/day/2026-10-21");
    expect(await within(act_).findByRole("checkbox", { name: "Done: Send Ines Vermaat the revised section 3" })).toBeTruthy();
  });

  it("shows the note in the editor, below", async () => {
    await show({ kind: "person", slug: "ines-vermaat" });
    expect((await within(await screen.findByRole("region", { name: "The note" })).findByTestId("editor")).textContent).toContain("# Ines Vermaat");
  });

  it("puts its own warning on top with the fix, and its own name is not a link to itself", async () => {
    await show({ kind: "person", slug: "pieter-bakker" });
    const warn = await screen.findByRole("note", { name: "Orr noticed" });
    expect(warn.textContent).toContain("Pieter Bakker works at Bakker & Zn, which has no note.");
    expect(within(warn).queryByRole("link", { name: "Pieter Bakker" })).toBeNull();
    fireEvent.click(within(warn).getByRole("button", { name: "Create the note" }));
    const dialog = await screen.findByRole("dialog", { name: "New company" });
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Bakker & Zn");
    expect(server.calls.filter((c) => c.method !== "GET")).toEqual([]); // nothing written until saved
  });

  it("sets the sector through the server, never by writing the note (WEB-022)", async () => {
    await show({ kind: "person", slug: "ines-vermaat" });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Sector" }), { target: { value: "Finance" } });
    });
    expect(server.calls.filter((c) => c.method !== "GET")).toEqual([{ method: "PATCH", url: "/api/contacts/n-ines", body: { sector: "Finance" } }]);
  });

  it("says why when the server refuses the sector, and keeps the old one", async () => {
    const { ApiError } = await import("../api.js");
    server.patch = () => {
      throw new ApiError(409, "this note's front matter could not be read, so its sector was not changed; fix it in the note");
    };
    await show({ kind: "person", slug: "ines-vermaat" });
    const select = screen.getByRole("combobox", { name: "Sector" }) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "Finance" } });
    });
    expect((await screen.findByRole("alert")).textContent).toContain("front matter could not be read");
    expect(select.value).toBe("University");
  });

  it("an address that names nobody says so, with the way back", async () => {
    render(<EntityPage me={me} route={{ kind: "person", slug: "nobody-here" }} />);
    expect(await screen.findByText("There's no person at this address.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to People" }).getAttribute("href")).toBe("/people");
  });
});

describe("on a vault without an ontology", () => {
  it("plain links instead of typed relations, no path, no warnings, no empty boxes", async () => {
    server.typed = false;
    await show({ kind: "person", slug: "ines-vermaat" });
    expect(linkNamed("Kade drinks", await relationRow("mentioned in"))).toBeTruthy();
    expect(linkNamed("Westerdok", await relationRow("links to")).getAttribute("href")).toBe("/companies/westerdok");
    // Every request was asked in the same effect and answered at once, so by now relations,
    // warnings and the path have answered too: what is absent is absent, not late.
    expect(screen.getByRole("region", { name: "How Ines relates" }).textContent).toContain("links in your notes");
    expect(screen.queryByText("supervises", { selector: ".ent-rel-row .k" })).toBeNull();
    expect(screen.queryByRole("region", { name: /How you know/ })).toBeNull();
    expect(screen.queryByRole("note", { name: "Orr noticed" })).toBeNull();
    expect(document.querySelectorAll(".ent-block:empty, .ent-facts:empty")).toHaveLength(0);
  });

  it("a company still lists who works there, as People always has", async () => {
    server.typed = false;
    await show({ kind: "company", slug: "kade-social" });
    const employs = await relationRow("employs");
    expect(linkNamed("Thijs Brouwer", employs).getAttribute("href")).toBe("/people/thijs-brouwer");
    expect(linkNamed("Jules Demo", employs)).toBeTruthy();
  });
});

describe("a company", () => {
  it("says what it is, who works there and edits its card in a sheet", async () => {
    await show({ kind: "company", slug: "kade-social" });
    expect(screen.getByText("Social-media agency")).toBeTruthy();
    expect(linkNamed("Thijs Brouwer", await relationRow("employs"))).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);
    expect(await screen.findByRole("dialog", { name: "Edit Kade Social" })).toBeTruthy();
  });
});

describe("a conversation", () => {
  it("is its turns, never the **Jules:** markup, with what it's about", async () => {
    await show({ kind: "conversation", slug: "scoping-the-question" });
    const talk = await screen.findByRole("region", { name: "The conversation" });
    expect(within(talk).getAllByRole("listitem").map((li) => li.querySelector(".ent-who")!.textContent)).toEqual(["Jules", "Claude"]);
    expect(talk.textContent).not.toContain("**");
    expect(talk.textContent).not.toContain("Date:");
    expect(screen.getByRole("heading", { level: 1 }).parentElement!.textContent).toContain("with Claude");
    expect(linkNamed("Graduation thesis", await relationRow("about")).getAttribute("href")).toBe("/projects/graduation-thesis");
  });
});

describe("a document", () => {
  it("a project's file: its project, type and size, and the reader in the page", async () => {
    await show({ kind: "document", path: "04-Projects/graduation-thesis/files/Research plan.pdf" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Research plan.pdf");
    const facts = document.querySelector(".ent-facts") as HTMLElement;
    expect(linkNamed("Graduation thesis", facts).getAttribute("href")).toBe("/projects/graduation-thesis/documents");
    expect(facts.textContent).toContain("12 KB");
    expect(screen.getByTestId("reader").textContent).toBe("inline:Research plan.pdf");
  });

  it("a note that is a document: the project it is part of, then the note", async () => {
    await show({ kind: "document", path: "04-Projects/graduation-thesis/Chapter 1.md" });
    expect(linkNamed("Graduation thesis", await relationRow("part of"))).toBeTruthy();
    expect(await screen.findByTestId("editor")).toBeTruthy();
  });

  it("a file that is not there says so", async () => {
    render(<EntityPage me={me} route={{ kind: "document", path: "04-Projects/graduation-thesis/files/Gone.pdf" }} />);
    expect(await screen.findByText("There's no document at this address.")).toBeTruthy();
  });
});
