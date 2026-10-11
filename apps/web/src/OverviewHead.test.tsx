/**
 * The Projects board's row (structure.md §2.4).
 *
 * No control sits inside another. The old head was one big <button> wrapping its Sleep, Cancel
 * and Wake buttons: invalid HTML, a React nesting warning on every render, and controls a
 * screen reader could not reach on their own. The new row's whole width opens the project, so
 * the same mistake is one `<a>` away: rendered to static markup in every state the board shows,
 * then walked tag by tag.
 *
 * And what the row says: the next date is the next OPEN step's (it used to be the earliest due
 * date of any step, done or not), the key deadline the next open `#deadline` step, and Orr's
 * flag counts what is off about the project once, not twice.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardTask } from "./api.js";
import { boardProject, boardShelf, nextDate, ProjectRow, ProjectSteps, shelfRows } from "./OverviewHead.js";

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea"]);
const INTERACTIVE_ROLES = /\brole="(button|link|switch|checkbox|menuitem|option|tab)"/;

/** Every interactive element that sits inside another one, as "outer > inner". */
function nestedControls(html: string): string[] {
  const stack: { tag: string; interactive: boolean; label: string }[] = [];
  const found: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs = "", selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const interactive = INTERACTIVE_TAGS.has(tag!) || INTERACTIVE_ROLES.test(attrs) || /\btabindex=/i.test(attrs);
    const label = `${tag}${/class="([^"]*)"/.exec(attrs)?.[1]?.replace(/^/, ".") ?? ""}`;
    const outer = stack.find((s) => s.interactive);
    if (interactive && outer) found.push(`${outer.label} > ${label}`);
    if (!selfClosing) stack.push({ tag: tag!, interactive, label });
  }
  return found;
}

let line = 0;
const task = (text: string, over: Partial<DashboardTask> = {}): DashboardTask =>
  ({ line: ++line, checked: false, status: "todo", text, raw: `- [ ] ${text}`, indent: 0, noteId: "n-p", notePath: "04-Projects/thesis.md", noteTitle: "Thesis", project: "Thesis", object: null, ...over }) as DashboardTask;

const base = {
  slug: "thesis",
  projectId: "p-1",
  name: "Thesis",
  href: "/projects/thesis",
  noteId: "n-p",
  area: { id: "school", label: "School", color: "var(--c3)" },
  status: "on-track",
  total: 3,
  done: 1,
  deadline: "2027-01-19",
  people: [
    { id: "n-iv", title: "Ines Vermaat", kind: "person" as const },
    { id: "n-ks", title: "Kade Social", kind: "company" as const },
  ],
  warnings: [],
};
const tasks = [
  task("Pick a supervisor", { checked: true, status: "done", due: "2020-01-02" }),
  task("Research plan submitted", { key: true, due: "2099-10-19" }),
  task("Ask Thijs to sign", { due: "2099-10-08", noteId: "n-other", noteTitle: "Weekly meetings" }),
];

describe("ProjectRow", () => {
  const p = boardProject({ ...base, tasks });
  const flagged = boardProject({ ...base, status: "", tasks });
  const menu = [{ label: "Pause", onSelect: () => {} }];
  const states = {
    folded: <ProjectRow p={p} open={false} onToggle={() => {}} onOpen={() => {}} menu={menu} />,
    unfolded: <ProjectRow p={p} open onToggle={() => {}} onOpen={() => {}} menu={menu} />,
    "flagged, no menu": <ProjectRow p={flagged} open={false} onToggle={() => {}} onOpen={() => {}} menu={[]} />,
    steps: <ProjectSteps p={p} canEdit all={false} onAll={() => {}} onCheck={() => {}} onStatus={() => {}} onOpenStep={() => {}} links={<a href="/projects/thesis">Open the project</a>} />,
    "every step, read only": <ProjectSteps p={p} canEdit={false} all onAll={() => {}} onCheck={() => {}} onStatus={() => {}} onOpenStep={() => {}} links={null} />,
  };
  for (const [state, el] of Object.entries(states)) {
    it(`nests no control inside another (${state})`, () => {
      expect(nestedControls(renderToStaticMarkup(el))).toEqual([]);
    });
  }

  it("offers every action, each as its own control", () => {
    const html = renderToStaticMarkup(states.folded);
    expect(html).toMatch(/<a class="pr-link" href="\/projects\/thesis">Thesis<\/a>/);
    expect(html).toMatch(/<button[^>]*class="chev"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/<button[^>]*aria-label="More for Thesis"[^>]*aria-haspopup="menu"/);
    const steps = renderToStaticMarkup(states.steps);
    expect(steps).toMatch(/role="checkbox"[^>]*aria-label="Complete Research plan submitted"/);
    expect(steps).toMatch(/<button[^>]*aria-label="Status of Research plan submitted"/);
    expect(steps).toMatch(/in <span class="nm">Weekly meetings<\/span>/);
  });

  it("the walker does catch a nested control", () => {
    expect(nestedControls('<button class="a"><span><button class="b">x</button></span></button>')).toEqual(["button.a > button.b"]);
    expect(nestedControls('<div role="button" class="a"><span role="checkbox" tabindex="0">x</span></div>')).toEqual(["div.a > span"]);
  });
});

describe("what the row says", () => {
  it("the next date is the next OPEN step's, never a done one's (§2.4)", () => {
    const p = boardProject({ ...base, tasks });
    expect(p.next?.text).toBe("Ask Thijs to sign");
    expect(nextDate(p.next)?.big).toBe("Thu 8 Oct 2099");
  });

  it("the key deadline is the next open #deadline step, else the note's deadline", () => {
    expect(boardProject({ ...base, tasks }).key?.text).toBe("Research plan submitted");
    const none = boardProject({ ...base, tasks: tasks.filter((t) => !t.key) });
    expect(none.key).toBeNull();
    expect(renderToStaticMarkup(<ProjectRow p={none} open={false} onToggle={() => {}} onOpen={() => {}} menu={[]} />)).toContain("Deadline");
  });

  it("a late step says how late, and when it was due", () => {
    const d = nextDate(task("Late one", { due: "2020-03-03" }));
    expect(d?.late).toBe(true);
    expect(d?.big).toMatch(/days late$/);
    expect(d?.small).toBe("was Tue 3 Mar 2020");
  });

  it("Orr's flag counts a missing status once, whether the graph says so or not", () => {
    expect(boardProject({ ...base, status: "", tasks }).flags).toEqual(["No status yet: pick one."]);
    expect(boardProject({ ...base, status: "", tasks, warnings: ["Thesis has no status"] }).flags).toEqual(["Thesis has no status"]);
    expect(boardProject({ ...base, status: "waiting", tasks }).flags).toHaveLength(1);
    expect(boardProject({ ...base, tasks }).flags).toEqual([]);
  });

  it("a project's shelf follows its word, then its steps", () => {
    expect(boardProject({ ...base, status: "sleeping", tasks }).shelf).toBe("paused");
    expect(boardProject({ ...base, status: "", total: 3, done: 3, tasks }).shelf).toBe("done");
  });
});

describe("the Done shelf (F1)", () => {
  const steps = { total: 3, done: 1 };
  it("completed and archived both land on Done, in any spelling the note has", () => {
    for (const status of ["completed", "archived", "done", "finished", "Archived"]) expect(boardShelf({ status, ...steps })).toBe("done");
    // Every step ticked, whatever the note says (or does not), is finished too.
    expect(boardShelf({ status: "", total: 3, done: 3 })).toBe("done");
  });

  it("nothing else does", () => {
    expect(boardShelf({ status: "paused", ...steps })).toBe("paused");
    expect(boardShelf({ status: "cancelled", total: 3, done: 3 })).toBe("cancelled");
    for (const status of ["planned", "on-track", "at-risk", "", "waiting"]) expect(boardShelf({ status, ...steps })).toBe("active");
    expect(boardShelf({ status: "", total: 0, done: 0 })).toBe("active");
  });

  it("is newest first: the latest change in the project's notes, undated last", () => {
    const p = (name: string, status: string, lastActivityMs?: number) => boardProject({ ...base, slug: name, name, status, tasks: [], lastActivityMs });
    const list = [p("CV v4", "completed", 100), p("Summer report", "archived", 300), p("Lisbon trip", "cancelled", 400), p("Old notes", "archived"), p("Literature review", "completed", 200)];
    expect(shelfRows(list, "done").map((x) => x.name)).toEqual(["Summer report", "Literature review", "CV v4", "Old notes"]);
    expect(shelfRows(list, "cancelled").map((x) => x.name)).toEqual(["Lisbon trip"]);
  });
});
