import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, isAbort, latestOnly, type Me } from "./api.js";
import { daysTo } from "./categories.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { DatesButton, EntityHeader, OrrWarnings, shelfOf, statusOf, statusProblems, StatusMenu, useRelations, type StatusId } from "./entity/index.js";
import { slugOf } from "./orrery/model.js";
import { areaOf, useNoteAreas } from "./projectArea.js";
import { GroupMenu, useProjectGroups } from "./projectGroup.js";
import { ProjectOverview } from "./ProjectOverview.js";
import { isPage } from "./projectPages.js";
import { ProjectReader } from "./ProjectReader.js";
import { AddStepDialog, ProjectBoard, ProjectTimeline, ProjectTodo } from "./ProjectViews.js";
import { writeKey } from "./storage.js";
import { Button, ProgressRing, Tabs } from "./ui/controls.js";
import { Orr } from "./ui/orr/Orr.js";
import { Menu } from "./ui/overlays.js";
import { navigate, routeHref, type ProjectTab } from "./ui/router.js";
import { Notice, Skeleton } from "./ui/states.js";
import { attempt } from "./ui/writes.js";
import { onWs } from "./ws.js";
import type { ProjectFile, ProjectNote, ProjectPerson, ProjectWorkspace } from "@orrama/schema/responses";
import { SectionBar } from "./ui/shell/SectionBar.js";
export type { ProjectFile, ProjectNote, ProjectPerson, ProjectWorkspace };

/**
 * The tabs; Overview is the project's own address, the others sit under it. Reader shows only
 * when the project has a page to read (an .html document), or when its address is open.
 */
export type Tab = "overview" | ProjectTab;
const TABS: Tab[] = ["overview", "timeline", "documents", "todo", "reader"];
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", timeline: "Timeline", documents: "Documents", todo: "To-do", reader: "Reader" };
/** The tab used last: the board's links open a project on it (the address stays the truth). */
export const LAST_TAB_KEY = "orrama-proj-view";

export const tabHref = (slug: string, tab: Tab) => routeHref({ kind: "project", slug, ...(tab === "overview" ? {} : { tab }) });

/** "103 days left", "due today", "5 days over". */
export function leftLabel(deadline: string): { text: string; late: boolean } | null {
  const left = deadline ? daysTo(deadline) : null;
  if (left === null) return null;
  if (left < 0) return { text: `${-left} ${left === -1 ? "day" : "days"} over`, late: true };
  if (left === 0) return { text: "due today", late: false };
  return { text: `${left} ${left === 1 ? "day" : "days"} left`, late: false };
}

/**
 * The project page (structure.md §2.5): the richest entity page. Its header (breadcrumb, the
 * progress ring, status as a menu, dates as text, the area, the steps), the graph's warnings as
 * Orr's work, then four tabs at their own addresses: `/projects/<slug>` (Overview),
 * `…/timeline`, `…/documents`, `…/todo`.
 *
 * Everything on it is the project note: goals, the prompt, decisions and the inbox are `##`
 * sections, people are `[[links]]`, steps are checkboxes, status and dates are front matter,
 * and the documents sit in `04-Projects/<slug>/files/` beside it. Nothing here is a database
 * row, so the page survives a re-index and the note still reads like a note anywhere else.
 */
export function Project({ me, slug, tab = "overview", page, onOpenNote }: { me: Me; slug: string; tab?: Tab; page?: string; onOpenNote: (id: string) => void }) {
  const [w, setW] = useState<ProjectWorkspace | null>(null);
  const [error, setError] = useState<{ missing: boolean } | null>(null);
  const [version, setVersion] = useState(0);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const [nextLoad] = useState(latestOnly);
  const load = useCallback(async () => {
    try {
      setW(await api<ProjectWorkspace>("GET", `/api/projects/${encodeURIComponent(slug)}`, undefined, { signal: nextLoad() }));
      setError(null);
      setVersion((v) => v + 1);
    } catch (err) {
      if (isAbort(err)) return;
      setError({ missing: err instanceof ApiError && err.status === 404 });
    }
  }, [slug, nextLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    writeKey(LAST_TAB_KEY, tab);
  }, [tab]);

  // Someone else editing the note (or the agent appending a decision) refreshes here.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 600);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  // Header writes go one after another, so the last value set is the last one written — two
  // in flight used to land in either order (WEB-023).
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const patch = useCallback(
    (body: Record<string, unknown>) => {
      const run = writes.current.then(async () => {
        await api("PATCH", `/api/projects/${encodeURIComponent(slug)}`, body);
        await load();
      });
      writes.current = run.catch(() => {});
      return run;
    },
    [slug, load],
  );

  const relations = useRelations(w?.noteId, version);
  const areas = useNoteAreas(w?.noteId);
  const groupRows = useProjectGroups(w ? version : null);

  if (error)
    return (
      <div className="pj-page">
        <Notice
          title={error.missing ? "There is no project here" : "The project could not be loaded"}
          text={error.missing ? "It may have been renamed, or its note is not one you can read." : "Check that the server is running, then try again."}
          actions={
            error.missing ? (
              <Button size="sm" onClick={() => navigate({ kind: "projects" })}>
                Go to Projects
              </Button>
            ) : (
              <Button size="sm" onClick={() => void load()}>
                Try again
              </Button>
            )
          }
        />
      </div>
    );
  if (!w)
    return (
      <div className="pj-page">
        <Skeleton rows={4} label="Opening the project" />
      </div>
    );

  const pct = w.total === 0 ? 0 : Math.round((w.done / w.total) * 100);
  const status = statusOf(w.status);
  const area = areaOf(areas.get(w.noteId), w.domain);
  const pages = w.files.filter((f) => isPage(f.name)).length;
  const left = w.deadline && status !== "completed" && status !== "archived" && status !== "cancelled" ? leftLabel(w.deadline) : null;
  const finished = w.total > 0 && w.done === w.total && shelfOf(w) === "completed" && status !== "completed" && status !== "archived";
  const setStatus = (id: StatusId) => void attempt("The status wasn't changed.", () => patch({ status: id }));
  // The graph's warnings about this project; its own say about a missing status, when it has
  // one, rather than ours twice.
  const warnings = relations.warnings.some((x) => /status/i.test(x)) ? relations.warnings : [...statusProblems(w.status), ...relations.warnings];

  return (
    <div className="pj-page">
      <EntityHeader
        crumbs={[{ label: "Projects", href: routeHref({ kind: "projects" }), onOpen: () => navigate({ kind: "projects" }) }, { label: w.name }]}
        lead={
          <span style={status === "at-risk" ? ({ "--prog": "var(--warn)" } as React.CSSProperties) : undefined}>
            <ProgressRing value={w.total ? w.done / w.total : 0} size={44} label={`${pct}% done`} />
          </span>
        }
        title={w.name}
        meta={
          <>
            <StatusMenu value={w.status} canEdit={w.canEdit} capital onPick={setStatus} />
            <DatesButton
              canEdit={w.canEdit}
              slots={[
                { key: "start", label: "Start", value: w.start },
                { key: "deadline", label: "Deadline", value: w.deadline },
              ]}
              onCommit={(key, value) => patch({ [key]: value })}
            />
            {left && <span className={left.late ? "pj-late" : undefined}>{left.text}</span>}
            {area && (
              <a
                className="ent-link"
                href={routeHref({ kind: "projects", area: area.id })}
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  navigate({ kind: "projects", area: area.id });
                }}
              >
                <span className="ui-dot" style={{ background: area.color }} />
                {area.label}
              </a>
            )}
            <GroupMenu value={w.group} canEdit={w.canEdit} rows={groupRows} write={(group) => patch({ group })} />
            <a className="ent-link" href={tabHref(w.slug, "todo")} onClick={(e) => go(e, w.slug, "todo")}>
              {pct}% · {w.done} of {w.total} {w.total === 1 ? "step" : "steps"}
            </a>
          </>
        }
        actions={<HeadActions w={w} onAdd={() => setAdding(true)} onStatus={setStatus} onOpenNote={onOpenNote} ask={setConfirm} />}
      />

      <OrrWarnings warnings={warnings} />

      {finished && (
        <div className="oprop boxed pj-done" role="status">
          <Orr pose="jump" size={56} />
          <div>
            <p>
              <b>{w.name} is done.</b> Every step is ticked.
            </p>
            {w.canEdit && (
              <div className="acts">
                <Button size="sm" onClick={() => setStatus("archived")}>
                  Archive the project
                </Button>
                <Button size="sm" kind="quiet" onClick={() => setStatus("completed")}>
                  Mark it completed
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <SectionBar>
        <Tabs
          label="Project views"
          value={tab}
          onChange={(t) => navigate(tabHref(w.slug, t))}
          items={TABS.filter((t) => t !== "reader" || pages > 0 || tab === "reader").map((t) => ({
            id: t,
            label: TAB_LABEL[t],
            href: tabHref(w.slug, t),
            ...(t === "documents" ? { count: w.files.length } : t === "todo" ? { count: w.total } : t === "reader" ? { count: pages } : {}),
          }))}
        />
      </SectionBar>

      <div className="pj-tab" role="tabpanel" aria-label={TAB_LABEL[tab]}>
        {tab === "overview" && <ProjectOverview w={w} me={me} relations={relations} onChanged={load} onPatch={patch} onOpenNote={onOpenNote} />}
        {tab === "timeline" && <ProjectTimeline w={w} lane={area?.color} onChanged={load} onOpenNote={onOpenNote} />}
        {tab === "todo" && <ProjectTodo w={w} lane={area?.color} onChanged={load} onOpenNote={onOpenNote} onAdd={() => setAdding(true)} />}
        {tab === "documents" && <ProjectBoard w={w} onChanged={load} />}
        {tab === "reader" && <ProjectReader w={w} page={page} />}
      </div>

      {adding && <AddStepDialog w={w} onClose={() => setAdding(false)} onAdded={load} />}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

const go = (e: React.MouseEvent, slug: string, tab: Tab) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(tabHref(slug, tab));
};

/** Add a step, and the ⋯ menu: the Orrery, the note, and where the project stands. */
function HeadActions({
  w,
  onAdd,
  onStatus,
  onOpenNote,
  ask,
}: {
  w: ProjectWorkspace;
  onAdd: () => void;
  onStatus: (id: StatusId) => void;
  onOpenNote: (id: string) => void;
  ask: (r: ConfirmRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const status = statusOf(w.status);
  const shelf = shelfOf(w);
  // The Orrery's own convention (R4): the project's slug, else the note's file name.
  const center = w.slug || slugOf(w.path);
  return (
    <>
      {w.canEdit && (
        <Button icon="plus" className="ent-wide" onClick={onAdd}>
          Add a step
        </Button>
      )}
      <Button ref={more} icon="dots" aria-label="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      {open && (
        <Menu
          anchor={more}
          align="end"
          label="Project"
          onClose={() => setOpen(false)}
          items={[
            ...(w.canEdit ? [{ label: "Add a step", onSelect: onAdd }] : []),
            { label: "Show in the Orrery", onSelect: () => navigate({ kind: "orrery", center }) },
            { label: "Open the note", onSelect: () => onOpenNote(w.noteId) },
            ...(w.canEdit
              ? [
                  "-" as const,
                  shelf === "paused" || shelf === "cancelled" || shelf === "archived"
                    ? { label: "Back on the board", onSelect: () => onStatus("on-track") }
                    : { label: "Pause", onSelect: () => onStatus("paused") },
                  ...(status !== "completed" ? [{ label: "Mark completed", onSelect: () => onStatus("completed") }] : []),
                  ...(status !== "archived" ? [{ label: "Archive", onSelect: () => onStatus("archived") }] : []),
                  ...(status !== "cancelled"
                    ? [
                        {
                          label: "Cancel the project…",
                          danger: true,
                          onSelect: () =>
                            ask({
                              title: `Cancel “${w.name}”?`,
                              body: "It moves to the Cancelled shelf. The note, its steps, its documents and its history stay exactly as they are; you can bring it back any time.",
                              confirmLabel: "Cancel the project",
                              danger: true,
                              onConfirm: () => onStatus("cancelled"),
                            }),
                        },
                      ]
                    : []),
                ]
              : []),
          ]}
        />
      )}
    </>
  );
}
