import { useCallback, useEffect, useMemo, useState } from "react";
import { api, isAbort, type DashboardData, type DashboardTask, type Me } from "./api.js";
import { useAreas } from "./categories.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import type { GraphData, GraphRelations, GraphSchema, HiddenProject, ProjectRow as ProjectListRow } from "@orrama/schema/responses";
import { boardGroups, boardProject, ProjectRow, ProjectSteps, shelfRows, SHELVES, type BoardPerson, type BoardProject } from "./OverviewHead.js";
import { LAST_TAB_KEY, tabHref, type Tab } from "./Project.js";
import { areaOf } from "./projectArea.js";
import { statusOf } from "./entity/index.js";
import { useTaskCard } from "./ProjectViews.js";
import { readKey } from "./storage.js";
import { Button, Chip } from "./ui/controls.js";
import { Icon } from "./ui/Icon.js";
import { PageHeader, Row, RowList } from "./ui/layout.js";
import { NameDialog } from "./ui/NameDialog.js";
import { toast, type MenuItem } from "./ui/overlays.js";
import { navigate, useRoute } from "./ui/router.js";
import { EmptyState, Notice, Skeleton } from "./ui/states.js";
import { attempt } from "./ui/writes.js";
import { onWs } from "./ws.js";
import { SectionBar } from "./ui/shell/SectionBar.js";

interface Loaded {
  dashboard: DashboardData;
  list: ProjectListRow[];
  /** Projects removed from the board (owners only; empty for anyone else). */
  hidden: HiddenProject[];
  people: Map<string, BoardPerson[]>;
  warnings: Map<string, string[]>;
}

/**
 * Projects (structure.md §2.4, was Overview): every project and its state at a glance, one row
 * each (OverviewHead.tsx), filtered by life area (`/projects?area=school`), with three shelves
 * under the board: Paused, Cancelled and Done (completed and archived work together), each
 * opened at its own address (`/projects?shelf=done`). Every step, percentage and date is a view
 * over the checkboxes in the notes; status and dates are the notes' front matter.
 *
 * What it reads, all existing endpoints: the board's steps (`/api/dashboard`, no team), each
 * project's note and dates (`/api/projects`), the areas (`/api/vault/tree`), the people a project
 * note links to (`/api/vault/graph`), and, when the vault has an ontology, the graph's warnings
 * about each project (`/api/graph/relations`).
 */
export function Overview({ me, area, onOpenNote }: { me: Me; area?: string; onOpenNote: (id: string) => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [allSteps, setAllSteps] = useState<Set<string>>(new Set());
  const route = useRoute();
  const shelf = route?.kind === "projects" ? (route.shelf ?? null) : null;
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [creating, setCreating] = useState(false);
  const areas = useAreas();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [dashboard, list, graph, schema, hidden] = await Promise.all([
        api<DashboardData>("GET", "/api/dashboard", undefined, { signal }),
        api<ProjectListRow[]>("GET", "/api/projects", undefined, { signal }),
        api<GraphData>("GET", "/api/vault/graph", undefined, { signal }),
        api<GraphSchema>("GET", "/api/graph/schema", undefined, { signal }).catch(() => null),
        me.isOwner ? api<HiddenProject[]>("GET", "/api/admin/projects/hidden", undefined, { signal }).catch((e) => (isAbort(e) ? Promise.reject(e) : [])) : Promise.resolve([] as HiddenProject[]),
      ]);
      // People: the contact and company notes a project note links to, either way (a
      // supervisor's own `supervises:` field counts as much as a link under ## People).
      const kindOf = new Map(graph.nodes.map((n) => [n.id, n.tags.includes("company") ? "company" : n.tags.includes("contact") ? "person" : null] as const));
      const titleOf = new Map(graph.nodes.map((n) => [n.id, n.title]));
      const noteIds = new Set(list.map((p) => p.noteId).filter((x): x is string => !!x));
      const people = new Map<string, BoardPerson[]>();
      for (const e of graph.edges) {
        for (const [mine, other] of [[e.from, e.to], [e.to, e.from]] as const) {
          const kind = kindOf.get(other);
          if (!noteIds.has(mine) || !kind) continue;
          const list2 = people.get(mine) ?? [];
          if (!list2.some((x) => x.id === other)) list2.push({ id: other, title: titleOf.get(other) ?? "", kind });
          people.set(mine, list2);
        }
      }
      // The graph's warnings, per project, only when the vault has an ontology to warn from.
      const warnings = new Map<string, string[]>();
      if (schema && schema.warnings.length > 0) {
        await Promise.all(
          [...noteIds].map((id) =>
            api<GraphRelations>("GET", `/api/graph/relations?entity=${encodeURIComponent(id)}`, undefined, { signal })
              .then((r) => warnings.set(id, r.warnings))
              .catch((e) => {
                if (isAbort(e)) throw e;
              }),
          ),
        );
      }
      setData({ dashboard, list, people, warnings, hidden });
      setFailed(false);
    } catch (e) {
      if (!isAbort(e)) setFailed(true);
    }
  }, [me.isOwner]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    return () => ac.abort();
  }, [load]);

  // Someone editing a note (here, in Obsidian, the agent) refreshes the board.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const lastTab = (readKey(LAST_TAB_KEY) as Tab | null) ?? "overview";
  const projects: BoardProject[] = useMemo(() => {
    if (!data) return [];
    const bySlug = new Map(data.list.map((p) => [p.slug, p]));
    return data.dashboard.projects
      .filter((p) => p.slug)
      .map((p) => {
        const row = bySlug.get(p.slug!);
        const noteId = row?.noteId ?? null;
        return boardProject({
          slug: p.slug!,
          projectId: p.projectId,
          name: row?.name ?? p.project,
          href: tabHref(p.slug!, ["overview", "timeline", "documents", "todo"].includes(lastTab) ? lastTab : "overview"),
          noteId,
          area: areaOf(row?.area, areas),
          group: row?.group ?? null,
          status: p.status,
          total: p.total,
          done: p.done,
          tasks: p.tasks,
          deadline: row?.deadline ?? null,
          lastActivityMs: p.lastActivityMs,
          people: (noteId && data.people.get(noteId)) || [],
          warnings: (noteId && data.warnings.get(noteId)) || [],
        });
      });
  }, [data, areas, lastTab]);

  const inArea = (p: BoardProject) => !area || p.area?.id === area;
  const active = projects.filter((p) => p.shelf === "active");
  // The board's order: what is late or next first, then by date, undated last.
  const shown = active
    .filter(inArea)
    .sort((a, b) => (a.next?.due ?? "9999").localeCompare(b.next?.due ?? "9999") || a.name.localeCompare(b.name));
  // One area at a time is split by the projects' groups (Work: Scooperz, Websites…); every area
  // at once stays one list, where the area's dot already tells them apart.
  const groups = area ? boardGroups(shown) : null;
  const shelved = shelf && shelf !== "removed" ? shelfRows(projects, shelf).filter(inArea) : [];
  const removed = data?.hidden ?? [];
  const openSteps = shown.reduce((s, p) => s + (p.total - p.done), 0);
  // Every area the person has, even an empty one: it is where its first project is made.
  const areaCounts = areas.map((c) => ({ ...c, n: active.filter((p) => p.area?.id === c.id).length }));

  const card = useTaskCard(() => load(), onOpenNote);
  const setStatus = (t: DashboardTask, status: string) =>
    attempt("The step's status wasn't changed.", async () => {
      await api("POST", "/api/tasks/status", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, status });
      await load();
    });
  const check = (t: DashboardTask) =>
    attempt(t.checked ? "The step wasn't unticked." : "The step wasn't ticked.", async () => {
      await api("POST", "/api/tasks/check", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, checked: !t.checked });
      await load();
    });
  const setLifecycle = (p: BoardProject, status: string) =>
    attempt(`${p.name} wasn't moved.`, async () => {
      await api("PATCH", `/api/projects/${encodeURIComponent(p.slug)}`, { status });
      await load();
    });

  const putBack = (h: HiddenProject) =>
    attempt(`${h.name} wasn't put back.`, async () => {
      await api("POST", `/api/admin/projects/${encodeURIComponent(h.id)}/back`);
      await load();
      toast(`${h.name} is back on the board.`);
    });

  /** The ⋯ menu on a row: where the project stands, and (owners) taking it off the board. */
  const menuFor = (p: BoardProject): (MenuItem | "-")[] => {
    const items: (MenuItem | "-")[] = [
      p.shelf === "active" ? { label: "Pause", onSelect: () => void setLifecycle(p, "paused") } : { label: "Back on the board", onSelect: () => void setLifecycle(p, "on-track") },
    ];
    if (p.shelf !== "done") items.push({ label: "Mark completed", onSelect: () => void setLifecycle(p, "completed") });
    if (statusOf(p.status) !== "archived") items.push({ label: "Archive", onSelect: () => void setLifecycle(p, "archived") });
    if (p.shelf !== "cancelled")
      items.push({
        label: "Cancel…",
        danger: true,
        onSelect: () =>
          setConfirm({
            title: `Cancel “${p.name}”?`,
            body: "It moves to the Cancelled shelf. The note, its steps, its documents and its history stay exactly as they are; you can bring it back any time.",
            confirmLabel: "Cancel the project",
            danger: true,
            onConfirm: () => void setLifecycle(p, "cancelled"),
          }),
      });
    if (me.isOwner && p.projectId)
      items.push("-", {
        label: "Remove from the board…",
        danger: true,
        onSelect: () =>
          setConfirm({
            title: `Remove “${p.name}” from the board?`,
            body: "Its note stays as it is. It waits under “Removed from the board”, where Put back brings it back.",
            confirmLabel: "Remove",
            danger: true,
            failed: `${p.name} wasn't removed from the board.`,
            onConfirm: async () => {
              await api("DELETE", `/api/admin/projects/${p.projectId}`);
              await load();
            },
          }),
      });
    return items;
  };

  const toggle = (set: Set<string>, key: string) => {
    const n = new Set(set);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  };

  const rows = (list: BoardProject[], onShelf = false) =>
    list.map((p) => (
      <div key={p.slug} className="pr-wrap">
        <ProjectRow
          p={p}
          open={open.has(p.slug)}
          onToggle={() => setOpen((s) => toggle(s, p.slug))}
          onOpen={() => navigate(p.href)}
          menu={menuFor(p)}
          onStatus={(id) => void setLifecycle(p, id)}
          people={!onShelf || p.people.length > 0}
        />
        {open.has(p.slug) && (
          <ProjectSteps
            p={p}
            canEdit
            all={allSteps.has(p.slug)}
            onAll={() => setAllSteps((s) => toggle(s, p.slug))}
            onCheck={(t) => void check(t)}
            onStatus={(t, s) => void setStatus(t, s)}
            onOpenStep={(t) => void card.open(t)}
            links={
              <>
                <a className="lk" href={tabHref(p.slug, "overview")} onClick={(e) => go(e, tabHref(p.slug, "overview"))}>
                  Open the project
                </a>
                <a className="lk" href={tabHref(p.slug, "timeline")} onClick={(e) => go(e, tabHref(p.slug, "timeline"))}>
                  Timeline and Gantt
                </a>
              </>
            }
          />
        )}
      </div>
    ));

  const columns = (
    <div className="pg ph" aria-hidden="true">
      <span />
      <span>Project · next step</span>
      <span>Status</span>
      <span>Next date</span>
      <span>Key deadline</span>
      <span>People</span>
      <span />
      <span />
    </div>
  );

  const create = async (name: string) => {
    // Made on a board filtered to an area, the project is in that area.
    const res = await api<{ slug: string }>("POST", "/api/projects", { name, ...(area && areas.some((c) => c.id === area) ? { area } : {}) });
    navigate(tabHref(res.slug, "overview"));
  };

  return (
    <div className="pjs">
      <PageHeader
        title="Projects"
        meta={data ? `${shown.length} open · ${openSteps} open ${openSteps === 1 ? "step" : "steps"}` : undefined}
        actions={
          <Button icon="plus" onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />

      {areaCounts.length > 0 && (
        <SectionBar>
        <div className="pjs-filters" role="group" aria-label="Area">
          <span className="lbl">Area</span>
          <Chip on={!area} onClick={() => navigate({ kind: "projects", shelf: shelf ?? undefined })}>
            All <span className="n">{active.length}</span>
          </Chip>
          {areaCounts.map((c) => (
            <Chip key={c.id} dot={c.color} on={area === c.id} onClick={() => navigate({ kind: "projects", area: area === c.id ? undefined : c.id, shelf: shelf ?? undefined })}>
              {c.label} <span className="n">{c.n}</span>
            </Chip>
          ))}
        </div>
        </SectionBar>
      )}

      {failed && !data && (
        <Notice
          title="The board could not be loaded"
          text="Check that the server is running, then try again."
          actions={
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      )}
      {!data && !failed && (
        <div className="card pjs-board">
          <Skeleton rows={5} label="Loading the projects" />
        </div>
      )}

      {data && shown.length > 0 && !groups && (
        <section className="card pjs-board" aria-label="Open projects">
          {columns}
          {rows(shown)}
        </section>
      )}
      {data && groups && (
        <div className="pjs-groups">
          {groups.map((g, i) => (
            <section key={g.key} className="card pjs-board" aria-label={g.label}>
              <header className="pjs-gh">
                <h2>{g.label}</h2>
                <span className="n">{g.projects.length}</span>
              </header>
              {i === 0 && columns}
              {rows(g.projects)}
            </section>
          ))}
        </div>
      )}

      {data && shown.length === 0 && (
        <div className="card pjs-empty">
          {projects.length === 0 && removed.length === 0 ? (
            <EmptyState
              pose="carry"
              title="No projects yet"
              text="Give it a name, then add its steps, dates, people and documents on its page."
              actions={<Button onClick={() => setCreating(true)}>Make a project</Button>}
            />
          ) : (
            <EmptyState
              pose="carry"
              title={area ? `Nothing open in ${areas.find((c) => c.id === area)?.label ?? area}` : "Nothing open"}
              text="Everything here is paused, finished or put away: the shelves below have it."
              actions={area ? <Button onClick={() => navigate({ kind: "projects", shelf: shelf ?? undefined })}>Show every area</Button> : <Button onClick={() => setCreating(true)}>Make a project</Button>}
            />
          )}
        </div>
      )}

      {data && (
        <div className="pjs-shelves">
          {SHELVES.map((s) => {
            const on = shelfRows(projects, s.id).filter(inArea);
            if (on.length === 0) return null;
            return (
              <div key={s.id} className="shelf">
                <button type="button" className="shelf-head" aria-expanded={shelf === s.id} onClick={() => navigate({ kind: "projects", area, shelf: shelf === s.id ? undefined : s.id })}>
                  <Icon name={shelf === s.id ? "chev-d" : "chev-r"} size={14} />
                  {s.label} {on.length}
                </button>
                <span className="shelf-names">
                  {on.map((p, i) => (
                    <span key={p.slug}>
                      {i > 0 && " · "}
                      <a className="ui-nm" href={p.href} onClick={(e) => go(e, p.href)}>
                        {p.name}
                      </a>
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
          {removed.length > 0 && (
            <div className="shelf">
              <button type="button" className="shelf-head" aria-expanded={shelf === "removed"} onClick={() => navigate({ kind: "projects", area, shelf: shelf === "removed" ? undefined : "removed" })}>
                <Icon name={shelf === "removed" ? "chev-d" : "chev-r"} size={14} />
                Removed from the board {removed.length}
              </button>
              <span className="shelf-names">{removed.map((h) => h.name).join(" · ")}</span>
            </div>
          )}
        </div>
      )}
      {data && shelf === "removed" && removed.length > 0 && (
        <section className="card pjs-board pjs-removed" aria-label="Removed from the board">
          <RowList label="Removed from the board">
            {removed.map((h) => (
              <Row
                key={h.id}
                title={h.name}
                trailing={
                  <Button size="sm" onClick={() => void putBack(h)}>
                    Put back
                  </Button>
                }
              />
            ))}
          </RowList>
        </section>
      )}
      {data && shelf && shelved.length > 0 && (
        <section className="card pjs-board pjs-shelf" aria-label={`${SHELVES.find((s) => s.id === shelf)!.label} projects`}>
          {rows(shelved, true)}
        </section>
      )}

      {card.node}
      {creating && (
        <NameDialog
          title="New project"
          label="What is it called?"
          placeholder="Graduation thesis"
          onSubmit={create}
          onClose={() => setCreating(false)}
        />
      )}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

const go = (e: React.MouseEvent, href: string) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(href);
};

