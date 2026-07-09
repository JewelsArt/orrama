import { describe, expect, it } from "vitest";
import {
  VaultIndex,
  appendLine,
  promoteTaskLine,
  setTaskChecked,
  setTaskDates,
  suggestRelated,
  type AclUser,
  type FolderGrant,
  type ProjectDef,
} from "../src/index.js";

const files = [
  {
    path: "Engineering/Atlas/Kickoff.md",
    content: `---
id: n-kick
title: Atlas Kickoff
---
See [[Roadmap]] and [[Client Notes|Acme]].

- [ ] draft spec @erin due:2026-07-10 !p1
- [x] set up repo @erin
- [ ] review copy @mara
`,
    mtimeMs: 1000,
  },
  {
    path: "Engineering/Roadmap.md",
    content: `---
id: n-road
title: Roadmap
aliases: [Plan 2026]
---
#project/atlas milestone list. Links back to [[Atlas Kickoff]].

- [ ] publish roadmap @erin
`,
    mtimeMs: 2000,
  },
  {
    path: "Marketing/Client Notes.md",
    content: `---
id: n-client
title: Client Notes
---
#share/engineering Acme contract details. [[Roadmap]] relevant. #client/acme
`,
    mtimeMs: 3000,
  },
  {
    path: "Marketing/Secret Campaign.md",
    content: `---
id: n-secret
title: Secret Campaign
---
#only/marketing launch surprise. [[Atlas Kickoff]] mentioned covertly.

- [ ] finalize budget @mara
`,
    mtimeMs: 4000,
  },
];

const grants: FolderGrant[] = [
  { team: "engineering", folder: "Engineering", role: "editor" },
  { team: "marketing", folder: "Marketing", role: "editor" },
];
const erin: AclUser = { id: "u1", username: "erin", teams: ["engineering"], isOwner: false };
const mara: AclUser = { id: "u2", username: "mara", teams: ["marketing"], isOwner: false };
const projects: ProjectDef[] = [
  { kind: "folder", key: "Engineering/Atlas", name: "Atlas" },
  { kind: "tag", key: "project/atlas", name: "Atlas" },
];

const vault = () => new VaultIndex(files);

describe("VaultIndex", () => {
  it("resolves links by title, alias, and filename", () => {
    const v = vault();
    expect(v.resolveLink("Roadmap")?.id).toBe("n-road");
    expect(v.resolveLink("plan 2026")?.id).toBe("n-road");
    expect(v.resolveLink("Client Notes")?.id).toBe("n-client");
  });

  it("computes ACL-filtered backlinks (§5.4: no leak through backlink panel)", () => {
    const v = vault();
    const forErin = v.backlinks("n-kick", erin, grants);
    // Secret Campaign links to Kickoff but is #only/marketing → invisible to erin
    expect(forErin.map((b) => b.fromId)).toEqual(["n-road"]);
    const forMara = v.backlinks("n-kick", mara, grants);
    expect(forMara.map((b) => b.fromId)).toEqual(["n-secret"]);
  });

  it("tag index is hierarchical and ACL-filtered", () => {
    const v = vault();
    const idxErin = v.tagIndex(erin, grants);
    expect(idxErin.get("project")?.has("n-road")).toBe(true);
    expect(idxErin.get("project/atlas")?.has("n-road")).toBe(true);
    // client tag lives on a #share/engineering note → visible to erin
    expect(idxErin.get("client/acme")?.has("n-client")).toBe(true);
    // only/marketing note's tags never reach erin
    expect(idxErin.get("only/marketing")).toBeUndefined();
  });

  it("attributes tasks to projects via folder and tag", () => {
    const v = vault();
    const tasks = v.tasks(undefined, [], projects);
    const kick = tasks.find((t) => t.text === "draft spec");
    const road = tasks.find((t) => t.text === "publish roadmap");
    expect(kick?.project).toBe("Atlas");
    expect(road?.project).toBe("Atlas"); // via #project/atlas tag
  });

  it("computes real progress with open-task assignees", () => {
    const v = vault();
    const [p] = v.progress(undefined, [], projects);
    expect(p).toMatchObject({ project: "Atlas", total: 4, done: 1 });
    expect(p!.assignees.sort()).toEqual(["erin", "mara"]);
  });

  it("task lists are ACL-filtered (§5.4: dashboard aggregates leak nothing)", () => {
    const v = vault();
    const erinTasks = v.tasks(erin, grants, projects);
    expect(erinTasks.some((t) => t.text === "finalize budget")).toBe(false);
    const maraTasks = v.tasks(mara, grants, projects);
    expect(maraTasks.some((t) => t.text === "finalize budget")).toBe(true);
  });

  it("search supports tag:/path:/task:/assignee: filters and is ACL-filtered", () => {
    const v = vault();
    expect(v.search("tag:project", erin, grants).map((n) => n.id)).toEqual(["n-road"]);
    expect(v.search("path:marketing", erin, grants).map((n) => n.id)).toEqual(["n-client"]);
    expect(v.search("assignee:mara task:review", erin, grants).map((n) => n.id)).toEqual(["n-kick"]);
    expect(v.search("surprise", erin, grants)).toEqual([]); // #only note invisible in search
    expect(v.search("surprise", mara, grants).map((n) => n.id)).toEqual(["n-secret"]);
  });

  it("rebuilds deterministically from files alone (dashboard-from-markdown §13)", () => {
    const a = vault().progress(undefined, [], projects);
    const b = vault().progress(undefined, [], projects);
    expect(a).toEqual(b);
  });
});

describe("task line editing", () => {
  const content = "intro\n- [ ] alpha @erin\n- [x] beta ^t-abc123\n";

  it("toggles by line and by block id", () => {
    expect(setTaskChecked(content, { line: 1 }, true)).toContain("- [x] alpha");
    expect(setTaskChecked(content, { blockId: "t-abc123" }, false)).toContain("- [ ] beta ^t-abc123");
  });

  it("returns null when the line is gone (orphaning, §7.2)", () => {
    expect(setTaskChecked("nothing here", { blockId: "t-abc123" }, true)).toBeNull();
  });

  it("promotes a task by appending a stable block id, idempotently", () => {
    const res = promoteTaskLine(content, 1)!;
    expect(res.content).toMatch(/- \[ \] alpha @erin \^t-[a-z0-9]{6}/);
    const again = promoteTaskLine(content, 2)!;
    expect(again).toMatchObject({ blockId: "t-abc123", content });
    expect(promoteTaskLine(content, 0)).toBeNull();
  });

  it("sets, moves, and clears start:/due: tokens (Gantt edits)", () => {
    const set = setTaskDates(content, { line: 1 }, { start: "2026-07-06", due: "2026-07-09" })!;
    expect(set).toContain("- [ ] alpha @erin start:2026-07-06 due:2026-07-09");
    // moving rewrites in place, no duplicate tokens
    const moved = setTaskDates(set, { line: 1 }, { start: "2026-07-08", due: "2026-07-11" })!;
    expect(moved).toContain("- [ ] alpha @erin start:2026-07-08 due:2026-07-11");
    expect(moved.match(/start:/g)).toHaveLength(1);
    // partial update leaves the other token alone; null removes
    const dueOnly = setTaskDates(moved, { line: 1 }, { start: null })!;
    expect(dueOnly).toContain("- [ ] alpha @erin due:2026-07-11");
    expect(dueOnly).not.toContain("start:");
    const cleared = setTaskDates(dueOnly, { line: 1 }, { due: null })!;
    expect(cleared).toContain("- [ ] alpha @erin\n");
  });

  it("keeps the block id a line suffix when dating a promoted task", () => {
    const dated = setTaskDates(content, { blockId: "t-abc123" }, { start: "2026-07-06", due: "2026-07-07" })!;
    expect(dated).toContain("- [x] beta start:2026-07-06 due:2026-07-07 ^t-abc123");
    expect(setTaskDates("nothing here", { blockId: "t-abc123" }, { due: "2026-07-07" })).toBeNull();
  });

  it("appendLine handles trailing newlines (quick capture)", () => {
    expect(appendLine("", "- [ ] new")).toBe("- [ ] new\n");
    expect(appendLine("x\n", "- [ ] new")).toBe("x\n- [ ] new\n");
    expect(appendLine("x", "- [ ] new")).toBe("x\n- [ ] new\n");
  });
});

describe("suggested links", () => {
  it("ranks lexically similar unlinked notes, excluding linked ones", () => {
    const v = new VaultIndex([
      { path: "a.md", content: "---\nid: a\ntitle: Acme Contract\n---\nacme pricing contract renewal terms acme" },
      { path: "b.md", content: "---\nid: b\ntitle: Acme Meeting\n---\nacme renewal pricing discussion contract" },
      { path: "c.md", content: "---\nid: c\ntitle: Holiday Party\n---\nsnacks balloons music playlist" },
      { path: "d.md", content: "---\nid: d\ntitle: Linked Already\n---\nacme contract pricing renewal, linked from a" },
    ]);
    const a = { ...v.get("a")!, content: v.get("a")!.content + "\n[[Linked Already]]" };
    const withLink = new VaultIndex([
      { path: "a.md", content: a.content },
      { path: "b.md", content: v.get("b")!.content },
      { path: "c.md", content: v.get("c")!.content },
      { path: "d.md", content: v.get("d")!.content },
    ]);
    const note = withLink.getByPath("a.md")!;
    const related = suggestRelated(note, withLink.all(), (t) => withLink.resolveLink(t));
    expect(related[0]?.id).toBe("b");
    expect(related.some((r) => r.id === "d")).toBe(false); // already linked
    expect(related.some((r) => r.id === "c")).toBe(false); // unrelated
  });
});
