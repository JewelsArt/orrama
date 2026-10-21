/**
 * The project page edits the project note as the note has it (COR-005): "Edit" on the goals
 * opens on the `## Goals` section's own text and saves it back, so a checkbox, a nested item or
 * a line of prose survives a save nobody changed.
 *
 * Its dates are typed as text and written once, when a field is left (WEB-023): never a
 * half-typed year, never while typing, and one write after another. Its status is the vault's
 * vocabulary, written as the ontology's id. Its tabs are addresses. A person or company on it
 * opens their own page, and is taken off the project from the row's ⋯ menu (F2).
 */
import { act, cleanup as cleanupRender, fireEvent, render, screen, within } from "@testing-library/react";
import { Toaster } from "./ui/overlays.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  calls: [] as { method: string; url: string; body: Record<string, unknown> }[],
  workspace: {} as Record<string, unknown>,
  /** When set, a PATCH waits for this before it answers (a slow server). */
  hold: null as Promise<void> | null,
  /** What the graph says the project has, by relation. */
  relations: [] as { relation: string; to: { id: string; title: string; type: string }[] }[],
  contacts: [] as Record<string, unknown>[],
  /** When it says yes, that request fails as a server that isn't there would (WEB-010). */
  fail: null as ((method: string, url: string) => boolean) | null,
  /** `/api/projects`: the groups other projects use. */
  projects: [] as { slug: string; group: string | null }[],
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
      if (server.fail?.(method, url)) throw new TypeError("Failed to fetch");
      if (method === "PATCH" && server.hold) await server.hold;
      if (method === "GET" && url === "/api/projects/thesis") return server.workspace;
      if (method === "GET" && url.startsWith("/api/graph/relations"))
        return { entity: { id: "n-1", title: "Thesis", type: "project", summary: "", fields: {} }, relations: server.relations, warnings: [] };
      if (method === "GET" && url === "/api/contacts") return server.contacts;
      if (method === "GET" && url === "/api/projects") return server.projects;
      if (method === "GET" && url.startsWith("/api/vault/note/")) return { id: "n-1", path: "04-Projects/thesis.md", title: "Thesis", content: "", hash: "h", tags: [], canEdit: true };
      if (method === "GET") return [];
      return { ok: true };
    },
  };
});

// happy-dom would really fetch a frame's src (the page route): these tests check the frame, not a page.
(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
const { Project } = await import("./Project.js");
const me = { id: "u-1", username: "jules", displayName: "Jules", isOwner: true } as never;
const SOURCE = "- [x] Pick a supervisor\n- [ ] Defend in January\n  - book the room\n\nDone means: signed off.";

beforeEach(() => {
  server.calls = [];
  server.hold = null;
  server.relations = [];
  server.contacts = [];
  server.fail = null;
  server.projects = [];
  server.workspace = {
    slug: "thesis", key: "project/thesis", name: "Thesis", noteId: "n-1", path: "04-Projects/thesis.md", domain: null,
    status: "on-track", start: "2026-09-01", deadline: "2027-01-15", group: "", prompt: "",
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
    expect(localStorage.getItem("orrama-proj-view")).toBe("todo");
  });
});

describe("the Reader tab: the project's pages", () => {
  const file = (name: string, size = 2048) => ({ name, size, mtimeMs: Date.parse("2026-10-21T09:00:00Z"), ext: name.slice(name.lastIndexOf(".")).toLowerCase() });
  const tabs = () => within(screen.getByRole("tablist", { name: "Project views" })).getAllByRole("tab");

  it("shows only when the project has an .html document, with how many", async () => {
    server.workspace = { ...server.workspace, files: [file("brief.pdf")] };
    await open();
    expect(tabs().map((t) => t.textContent)).not.toContainEqual(expect.stringMatching(/^Reader/));
    cleanupRender();
    server.workspace = { ...server.workspace, files: [file("brief.pdf"), file("Map.html"), file("Plan.htm")] };
    await open();
    const reader = tabs().find((t) => t.textContent?.startsWith("Reader"));
    expect(reader?.getAttribute("href")).toBe("/projects/thesis/reader");
    expect(reader?.textContent).toBe("Reader2");
  });

  it("lists the pages and shows the one the address names, sealed off, with its live artifact", async () => {
    server.workspace = {
      ...server.workspace,
      files: [file("brief.pdf"), file("Process map.html"), file("Canvas.html", 70 * 1024 * 1024)],
      content: "## Documents\n\n- **Process map.html**: copy of the claude.ai artifact https://claude.ai/artifact/AbC123, copied 21 Oct 2026.\n",
    };
    render(<Project me={me} slug="thesis" tab="reader" page="Process map.html" onOpenNote={() => {}} />);
    await act(async () => {});
    const list = screen.getByRole("navigation", { name: "Pages" });
    const rows = within(list).getAllByRole("link");
    expect(rows.map((r) => r.textContent)).toEqual(["Canvas70.0 MB · Wed 21 Oct", "Process map2 KB · Wed 21 Oct"]);
    expect(rows[1]!.getAttribute("href")).toBe("/projects/thesis/reader?page=Process+map.html");
    expect(rows[1]!.className).toContain("on");

    const frame = document.querySelector<HTMLIFrameElement>(".pj-reader-page iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/projects/thesis/files/Process%20map.html/page");
    expect(frame.getAttribute("sandbox")?.split(" ")).not.toContain("allow-same-origin");
    expect(screen.getByRole("link", { name: "Open on claude.ai" }).getAttribute("href")).toBe("https://claude.ai/artifact/AbC123");

    await act(async () => {
      fireEvent.click(rows[0]!);
    });
    expect(location.pathname + location.search).toBe("/projects/thesis/reader?page=Canvas.html");
  });

  it("opens the first page when the address names none, and says so when there are none", async () => {
    server.workspace = { ...server.workspace, files: [file("b.html"), file("a.html")] };
    render(<Project me={me} slug="thesis" tab="reader" onOpenNote={() => {}} />);
    await act(async () => {});
    expect(document.querySelector(".pj-reader-page iframe")?.getAttribute("src")).toBe("/api/projects/thesis/files/a.html/page");
    expect(screen.queryByRole("link", { name: "Open on claude.ai" })).toBeNull();
    cleanupRender();
    server.workspace = { ...server.workspace, files: [] };
    render(<Project me={me} slug="thesis" tab="reader" onOpenNote={() => {}} />);
    await act(async () => {});
    expect(screen.getByText("No pages in this project yet.")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
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

describe("people and companies (F2)", () => {
  const INES = { id: "n-iv", title: "Ines Vermaat", kind: "contact", role: "Supervisor", company: "[[Westerdok]]", linkedin: "", path: "03-People/Ines Vermaat.md", inText: false };
  const KADE = { id: "n-ks", title: "Kade Social", kind: "company", role: "", company: "", linkedin: "", path: "03-People/Companies/Kade Social.md", inText: false };
  const panel = () => screen.getByRole("group", { name: "People and companies" });
  const deletes = () => server.calls.filter((c) => c.method === "DELETE").map((c) => c.url);

  it("a name opens their own page, a person's and a company's, as everywhere else", async () => {
    server.workspace = { ...server.workspace, people: [INES, KADE] };
    await open();
    const ines = within(panel()).getByRole("link", { name: /Ines Vermaat/ });
    expect(ines.getAttribute("href")).toBe("/people/ines-vermaat");
    expect(within(panel()).getByRole("link", { name: /Kade Social/ }).getAttribute("href")).toBe("/companies/kade-social");
    await act(async () => {
      fireEvent.click(ines);
    });
    expect(location.pathname).toBe("/people/ines-vermaat");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("someone only the graph names opens their page too, and has nothing to remove", async () => {
    server.relations = [{ relation: "supervised_by", to: [{ id: "n-tb", title: "Thijs Brouwer", type: "person" }] }];
    server.contacts = [{ id: "n-tb", name: "Thijs Brouwer", path: "03-People/Thijs Brouwer.md", sector: "", role: "", company: "", email: "", phone: "", linkedin: "", personal: false }];
    await open();
    expect(within(panel()).getByRole("link", { name: /Thijs Brouwer/ }).getAttribute("href")).toBe("/people/thijs-brouwer");
    expect(within(panel()).getByText("supervises")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More for Thijs Brouwer" })).toBeNull();
  });

  it("Remove from this project is in the row's ⋯ menu, behind the same Confirm", async () => {
    server.workspace = { ...server.workspace, people: [INES, KADE] };
    await open();
    const more = () => screen.getByRole("button", { name: "More for Ines Vermaat" });
    // The ⋯ is beside the link, never inside it.
    expect(within(panel()).getByRole("link", { name: /Ines Vermaat/ }).contains(more())).toBe(false);

    fireEvent.click(more());
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from this project" }));
    let ask = screen.getByRole("alertdialog", { name: "Take Ines Vermaat off Thesis?" });
    expect(ask.textContent).toContain("Their own note stays as it is.");
    fireEvent.click(within(ask).getByRole("button", { name: "Keep it" }));
    await act(async () => {});
    expect(deletes()).toEqual([]);

    fireEvent.click(more());
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from this project" }));
    ask = screen.getByRole("alertdialog", { name: "Take Ines Vermaat off Thesis?" });
    const before = server.calls.length;
    await act(async () => {
      fireEvent.click(within(ask).getByRole("button", { name: "Take them off" }));
    });
    expect(deletes()).toEqual(["/api/projects/thesis/people/n-iv"]);
    // The page reloads the project after the link is gone.
    expect(server.calls.slice(before).some((c) => c.method === "GET" && c.url === "/api/projects/thesis")).toBe(true);
  });

  it("the Confirm says when they are still mentioned in the note, and only then", async () => {
    // Ines is linked under ## People and in the text ("Ask [[Ines Vermaat]] to sign…"); Kade only under ## People.
    server.workspace = { ...server.workspace, people: [{ ...INES, inText: true }, KADE] };
    await open();
    const still = "They are still mentioned elsewhere in the project note, so they stay listed.";
    const ask = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: `More for ${name}` }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from this project" }));
      return screen.getByRole("alertdialog", { name: `Take ${name} off Thesis?` });
    };
    let dialog = ask("Ines Vermaat");
    expect(dialog.textContent).toContain("This removes the link from the project note.");
    expect(dialog.textContent).toContain(still);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    await act(async () => {});
    dialog = ask("Kade Social");
    expect(dialog.textContent).toContain("This removes the link from the project note.");
    expect(dialog.textContent).not.toContain(still);
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
  });

  it("without edit there is no ⋯ to remove anyone", async () => {
    server.workspace = { ...server.workspace, people: [INES, KADE], canEdit: false };
    await open();
    expect(within(panel()).getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /^More for/ })).toBeNull();
  });
});

describe("a failed write is never silent (WEB-010)", () => {
  const down = "The server didn't answer. Check it's running, then try again.";
  const toasts = () => [...document.querySelectorAll(".toast span")].map((t) => t.textContent);
  const openWithToasts = async () => {
    render(<Toaster />);
    await open();
  };
  afterEach(() => {
    for (const b of screen.queryAllByRole("button", { name: "Dismiss" })) fireEvent.click(b);
  });

  it("a form: the goals that didn't save stay in the box, the reason under them, Save still there", async () => {
    server.fail = (m) => m === "PATCH";
    await openWithToasts();
    const goals = screen.getByRole("region", { name: "Goals" });
    fireEvent.click(within(goals).getByRole("button", { name: "Edit" }));
    const box = within(goals).getByRole("textbox", { name: "Goals" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Defend in February" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save goals"));
    });
    expect(within(goals).getByRole("alert").textContent).toBe(`The goals weren't saved. ${down}`);
    expect((within(goals).getByRole("textbox", { name: "Goals" }) as HTMLTextAreaElement).value).toBe("Defend in February");
    const save = within(goals).getByRole("button", { name: "Save goals" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    server.fail = null;
    await act(async () => {
      fireEvent.click(save);
    });
    expect(patches()).toEqual([{ goals: "Defend in February" }, { goals: "Defend in February" }]);
    expect(within(goals).queryByRole("textbox", { name: "Goals" })).toBeNull();
  });

  it("an inline edit: a date that didn't save is said, and leaving the field again sends it again", async () => {
    server.fail = (m) => m === "PATCH";
    await openWithToasts();
    const { deadline } = await dates();
    fireEvent.change(deadline, { target: { value: "2 Feb 2027" } });
    await act(async () => {
      fireEvent.blur(deadline);
    });
    expect(toasts()).toEqual([`The deadline date wasn't saved. ${down}`]);
    expect(deadline.value).toBe("2 Feb 2027");
    server.fail = null;
    await act(async () => {
      fireEvent.blur(deadline);
    });
    expect(patches()).toEqual([{ deadline: "2027-02-02" }, { deadline: "2027-02-02" }]);
  });

  it("a tick: a step that didn't tick is said, with Retry, which ticks it", async () => {
    server.workspace = {
      ...server.workspace,
      tasks: [{ noteId: "n-1", notePath: "04-Projects/thesis.md", noteTitle: "Thesis", project: "thesis", object: null, line: 3, checked: false, status: "todo", text: "Book the room", raw: "- [ ] Book the room", indent: 0, section: "Tasks" }],
    };
    server.fail = (m, url) => m === "POST" && url === "/api/tasks/check";
    await openWithToasts();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Done: Book the room" }));
    });
    expect(toasts()).toEqual([`The step wasn't ticked. ${down}`]);
    server.fail = null;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    const checks = server.calls.filter((c) => c.url === "/api/tasks/check");
    expect(checks).toHaveLength(2);
    expect(checks[1]!.body).toMatchObject({ noteId: "n-1", text: "Book the room", checked: true });
    expect(toasts()).toEqual([]);
  });

  it("the project note that didn't open says so, with Retry, instead of opening for ever", async () => {
    server.fail = (m, url) => m === "GET" && url.startsWith("/api/vault/note/");
    await openWithToasts();
    const doc = screen.getByRole("article", { name: "The project note" });
    expect(within(doc).getByRole("alert").textContent).toContain("The note didn't open.");
    server.fail = null;
    await act(async () => {
      fireEvent.click(within(doc).getByRole("button", { name: "Retry" }));
    });
    expect(within(doc).queryByRole("alert")).toBeNull();
    expect(within(doc).queryByText("Opening the note…")).toBeNull();
  });
});

describe("the group (Jules, 20 Oct)", () => {
  const menu = async (name: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name }));
    await act(async () => {});
    return screen.getByRole("menu", { name: "Group" });
  };

  it("lists the groups other projects use, the current one ticked, and writes the one picked", async () => {
    server.workspace = { ...server.workspace, group: "Scooperz" };
    server.projects = [
      { slug: "a", group: "Websites" },
      { slug: "b", group: "scooperz" },
      { slug: "c", group: null },
    ];
    await open();
    const m = await menu(/Group: Scooperz/);
    const items = [...m.querySelectorAll("button")];
    expect(items.map((i) => i.textContent)).toEqual(["Scooperz", "Websites", "New group…", "No group"]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(within(m).getByText("Websites")));
    expect(patches()).toEqual([{ group: "Websites" }]);
  });

  it("No group takes it out", async () => {
    server.workspace = { ...server.workspace, group: "Scooperz" };
    await open();
    const m = await menu(/Group: Scooperz/);
    await act(async () => fireEvent.click(within(m).getByText("No group")));
    expect(patches()).toEqual([{ group: "" }]);
  });

  it("a new group is named in a dialog, no Markdown needed", async () => {
    await open();
    const m = await menu(/Add to a group/);
    expect(within(m).queryByText("No group")).toBeNull();
    await act(async () => fireEvent.click(within(m).getByText("New group…")));
    const dialog = screen.getByRole("dialog", { name: "New group" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Personal branding" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Add" })));
    expect(patches()).toEqual([{ group: "Personal branding" }]);
    expect(screen.queryByRole("dialog", { name: "New group" })).toBeNull();
  });

  it("without edit it is the name alone", async () => {
    server.workspace = { ...server.workspace, group: "Scooperz", canEdit: false };
    await open();
    expect(screen.getByText("Scooperz").tagName).toBe("SPAN");
    expect(screen.queryByRole("button", { name: /Group/ })).toBeNull();
  });
});
