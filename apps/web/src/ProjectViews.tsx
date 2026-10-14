import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { addDays, isoLocal } from "@basalt/core/dates";
import { api } from "./api.js";
import { daysTo } from "./categories.js";
import { DocViewer } from "./DocViewer.js";
import { parseDateInput } from "./entity/index.js";
import { Gantt } from "./Gantt.js";
import { TaskCard, type PlannableTask } from "./TaskCard.js";
import type { ProjectWorkspace } from "./Project.js";
import type { Board, BoardEdge, BoardNode, DashboardTask, FileNode, GroupNode, ProjectTask } from "@basalt/schema/responses";
import { Bar, Button, Checkbox, Segmented, Tabs, type TaskState } from "./ui/controls.js";
import { dateLabel, dayMonthLabel } from "./ui/dates.js";
import { Field, Input, SearchField } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { HeadMark } from "./ui/orr/Orr.js";
import { Dialog, Menu, toast } from "./ui/overlays.js";
import { EmptyState, Notice, Skeleton } from "./ui/states.js";
import { attempt } from "./ui/writes.js";
import { readKey, writeKey } from "./storage.js";

/**
 * The project page's three working tabs (structure.md §2.5, the boards project-timeline,
 * project-todo and project-documents):
 *
 *   Timeline  — one column per week, a card per dated step, key deadlines in the one red fill;
 *               drag a card to another week and its dates move by whole weeks
 *               (POST /api/tasks/dates, so the note's `due:` changes). The Gantt lives here.
 *   To-do     — the steps grouped by the project note's own `##` sections, late first.
 *   Documents — the project's files as cards on a board, in boxes, linked; saved to
 *               documents.canvas beside the note (routes/projects.ts).
 *
 * All three are views over the note and its folder: nothing here lives only in the database.
 */

export type { ProjectTask };

/* ---------------------------------------------------------------- shared pieces */

/** The checkbox's four states, read off the step's own checkbox. */
export const taskState = (t: { status?: string; checked: boolean }): TaskState =>
  t.checked || t.status === "done" ? "done" : t.status === "in-progress" ? "progress" : t.status === "blocked" ? "blocked" : "open";

/** When a step is due, said as Orrama says it: "today", "3 days late", "Mon 19 Oct". */
export function dueOf(t: { due?: string; checked: boolean }, today: string = isoLocal()): { text: string; late: boolean } {
  if (!t.due) return { text: t.checked ? "done" : "", late: false };
  if (t.checked) return { text: `done · ${dayMonthLabel(t.due)}`, late: false };
  const d = daysTo(t.due);
  if (d === null) return { text: t.due, late: false };
  if (d < 0) return { text: `${-d} ${d === -1 ? "day" : "days"} late`, late: true };
  if (d === 0) return { text: "today", late: false };
  if (d === 1) return { text: "tomorrow", late: false };
  return { text: dateLabel(t.due, new Date(`${today}T12:00:00`)), late: false };
}

/** "Research plan — due 19 October, the block's decisive deadline" → "Research plan". */
export const shortSection = (s: string) => s.split(/\s+[—–-]\s+|,/)[0]!.trim();

/** The task card Planning uses, with the planner's hours when it knows the step. */
export function useTaskCard(onChanged: () => Promise<void>, onOpenNote: (id: string) => void) {
  const [card, setCard] = useState<PlannableTask | null>(null);
  const open = useCallback(async (t: ProjectTask | DashboardTask) => {
    let hit: PlannableTask | undefined;
    try {
      const plan = await api<{ assignees: { tasks: PlannableTask[] }[] }>("GET", "/api/plan");
      hit = plan.assignees.flatMap((a) => a.tasks).find((p) => p.noteId === t.noteId && p.line === t.line);
    } catch {
      /* the card still opens, without estimates */
    }
    setCard(
      hit ?? {
        noteId: t.noteId, noteTitle: t.noteTitle, line: t.line, blockId: t.blockId ?? null, text: t.text,
        project: t.project, due: t.due ?? null, priority: t.priority ?? null,
        estimateHours: 0, scheduledHours: 0, remainingHours: 0, atRisk: false,
      },
    );
  }, []);
  const node = card && <TaskCard task={card} onClose={() => setCard(null)} onOpenNote={onOpenNote} onScheduled={onChanged} />;
  return { open, node };
}

/** Upload files into 04-Projects/<slug>/files/, one after another. */
export async function uploadProjectFiles(slug: string, files: FileList | File[], onFile: (name: string) => void, onError: (msg: string) => void) {
  for (const file of Array.from(files)) {
    onFile(file.name);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("could not read file"));
        reader.readAsDataURL(file);
      });
      await api("POST", `/api/projects/${encodeURIComponent(slug)}/files`, { name: file.name, dataBase64 });
    } catch (e) {
      onError(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
    }
  }
}

/**
 * Add a step: a `- [ ] …` line in the note's `## Tasks` (the capture route, as the Inbox's "as a
 * step"), with its `due:` when one is given. A date is typed, as in the header.
 */
export function AddStepDialog({ w, due, onClose, onAdded }: { w: ProjectWorkspace; due?: string; onClose: () => void; onAdded: () => Promise<void> }) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState(due ? dateLabel(due) : "");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const parsed = parseDateInput(when);
  const submit = async () => {
    if (!text.trim() || parsed === null || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const line = text.trim().replace(/\n/g, " ") + (parsed ? ` due:${parsed}` : "");
      await api("POST", `/api/projects/${encodeURIComponent(w.slug)}/capture`, { text: line, task: true });
      await onAdded();
      onClose();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Add a step"
      onClose={onClose}
      actions={
        <>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="solid" disabled={!text.trim() || parsed === null || busy} onClick={() => void submit()}>
            Add the step
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="The step">
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Thijs to sign the data agreement" />
        </Field>
        <Field label="Due (optional)" help={parsed === null ? undefined : parsed ? dateLabel(parsed) : "No date"} error={parsed === null ? "Not a date yet: try 19 Oct" : null}>
          <Input value={when} onChange={(e) => setWhen(e.target.value)} placeholder="e.g. Fri 16 Oct" />
        </Field>
        <p className="q3 pj-hint">It goes under “Tasks” in {w.path.split("/").pop()}.</p>
        {failed && <Notice title="Not added" text="The note could not be written. Try again." />}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- Timeline */

const DAY = 86_400_000;
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
/** Monday of the week an ISO date falls in, as a day number. */
const mondayOf = (iso: string) => {
  const n = dayNum(iso);
  return n - ((new Date(n * DAY).getUTCDay() + 6) % 7);
};
/** Which projects have the Gantt open under their Timeline (the old board kept a JSON list of names under basalt-gantt). */
const GANTT_KEY = "basalt-proj-gantt";

export function ProjectTimeline({ w, lane, onChanged, onOpenNote }: { w: ProjectWorkspace; lane?: string; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const tasks = w.tasks as ProjectTask[];
  const today = isoLocal();
  const [everything, setEverything] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  // The Gantt, per project, stays open where it was left.
  const [gantt, setGantt] = useState(() => (readKey(GANTT_KEY) ?? "").split("\n").includes(w.slug));
  const rail = useRef<HTMLDivElement>(null);
  const card = useTaskCard(onChanged, onOpenNote);

  const toggleGantt = () => {
    const open = new Set((readKey(GANTT_KEY) ?? "").split("\n").filter(Boolean));
    if (gantt) open.delete(w.slug);
    else open.add(w.slug);
    writeKey(GANTT_KEY, [...open].join("\n"));
    setGantt(!gantt);
  };

  const dated = tasks.filter((t) => t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) && (everything || !t.checked || t.key));
  // The weeks the project spans: its own start and deadline, stretched to hold every dated
  // step, and never less than six columns from the week before this one.
  const bounds = [w.start, w.deadline, today, ...dated.map((t) => t.due!), ...dated.map((t) => t.start ?? t.due!)].filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const thisWeek = mondayOf(today);
  const first = Math.min(mondayOf(bounds.reduce((a, b) => (a < b ? a : b), today)), thisWeek - 7);
  const last = Math.max(mondayOf(bounds.reduce((a, b) => (a > b ? a : b), today)), first + 35);
  const weeks: number[] = [];
  for (let n = first; n <= last && weeks.length < 104; n += 7) weeks.push(n);

  // Open on the week before this one, so this week is the second column (the board); on a
  // phone, where a column is most of the screen, on this week itself.
  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>(".pj-week.now");
    if (!el || !rail.current) return;
    const narrow = el.offsetWidth * 2 > rail.current.clientWidth;
    rail.current.scrollLeft = Math.max(0, el.offsetLeft - (narrow ? 0 : el.offsetWidth));
  }, [w.slug]);

  // A drop that didn't save puts the card back (the reload) and says why, with Retry (WEB-010).
  const move = async (t: ProjectTask, toWeek: number) => {
    const shift = toWeek - mondayOf(t.due!);
    if (!shift) return;
    const due = isoOf(dayNum(t.due!) + shift);
    const moved = await attempt("The step wasn't moved.", () =>
      api("POST", "/api/tasks/dates", {
        noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, due,
        ...(t.start ? { start: isoOf(dayNum(t.start) + shift) } : {}),
      }),
    );
    if (moved) toast(`Moved “${t.text.slice(0, 48)}${t.text.length > 48 ? "…" : ""}” to ${dateLabel(due)}.`);
    await onChanged();
  };

  const setDates = (t: DashboardTask, dates: { start?: string | null; due?: string | null }) =>
    attempt("The step's dates weren't changed.", async () => {
      await api("POST", "/api/tasks/dates", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, ...dates });
      await onChanged();
    });

  return (
    <section className="pj-timeline" style={{ ["--lane" as string]: lane ?? "var(--ink-3)" }}>
      <div className="pj-bar3">
        <Segmented
          label="Show"
          value={everything ? "all" : "open"}
          onChange={(v) => setEverything(v === "all")}
          items={[
            { id: "open", label: "Open work" },
            { id: "all", label: "Everything" },
          ]}
        />
        <span className="sp" />
        <span className="pj-hint">{w.canEdit ? "Drag a step to another week, or open it and type a date." : "Open a step for the detail."}</span>
      </div>
      {dated.length === 0 && tasks.length === 0 ? (
        <div className="card pj-empty">
          <EmptyState pose="sit" title="Nothing dated yet" text={<>A step with a date (<code>due:2026-10-19</code>) appears in its week.</>} />
        </div>
      ) : (
        <div className="pj-weeks" ref={rail} aria-label="Timeline by week" role="group">
          {weeks.map((wk) => {
            const inWeek = dated
              .filter((t) => mondayOf(t.due!) === wk)
              .sort((a, b) => Number(!!b.key) - Number(!!a.key) || a.due!.localeCompare(b.due!));
            const when = wk === thisWeek ? "now" : wk < thisWeek ? "past" : "";
            return (
              <div key={wk} className={`pj-week ${when}`} data-week={wk}>
                <div className="pj-wh">
                  <b>{dayMonthLabel(isoOf(wk))}</b>
                  {wk === thisWeek && <span>this week</span>}
                </div>
                <div className="pj-wi">
                  {inWeek.map((t) => (
                    <TimelineCard key={`${t.noteId}:${t.line}`} t={t} today={today} canEdit={w.canEdit} onOpen={() => void card.open(t)} onMove={(wk2) => void move(t, wk2)} />
                  ))}
                  {w.canEdit && wk >= thisWeek && (
                    <button type="button" className="pj-add" onClick={() => setAdding(wk === thisWeek ? today : isoOf(wk))}>
                      + Add a step to this week
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="pj-tlf">
        <div className="lgd">
          <span>
            <i className="lg du" />
            due
          </span>
          <span>
            <i className="lg key" />
            key deadline
          </span>
        </div>
        <span className="q3 pj-gantt-link">
          The Gantt, by section:{" "}
          <button type="button" className="ent-link" aria-expanded={gantt} onClick={toggleGantt}>
            {gantt ? "Hide the Gantt" : "Show the Gantt"}
          </button>
        </span>
      </div>
      {gantt && (
        <div className="card pj-gantt">
          <Gantt tasks={tasks} color={lane ?? "var(--ink-3)"} onSetDates={(t, d) => void setDates(t, d)} onOpen={onOpenNote} />
        </div>
      )}
      {adding && <AddStepDialog w={w} due={adding} onClose={() => setAdding(null)} onAdded={onChanged} />}
      {card.node}
    </section>
  );
}

function TimelineCard({ t, today, canEdit, onOpen, onMove }: { t: ProjectTask; today: string; canEdit: boolean; onOpen: () => void; onMove: (week: number) => void }) {
  const late = !t.checked && t.due! < today;
  const span = t.start ? dayNum(t.due!) - dayNum(t.start) + 1 : 0;
  const drag = useRef<{ x: number; y: number; ghost: HTMLElement | null; over: HTMLElement | null } | null>(null);
  const el = useRef<HTMLButtonElement>(null);
  const due = dueOf(t, today);
  const state = t.status === "blocked" ? " · blocked" : t.status === "in-progress" ? " · in progress" : "";

  const onDown = (e: React.PointerEvent) => {
    if (!canEdit || t.checked || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, ghost: null, over: null };
    el.current?.setPointerCapture?.(e.pointerId);
  };
  const onMoveP = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !el.current) return;
    if (!d.ghost && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
    if (!d.ghost) {
      d.ghost = el.current.cloneNode(true) as HTMLElement;
      d.ghost.classList.add("pj-ghost");
      d.ghost.style.width = `${el.current.offsetWidth}px`;
      document.body.appendChild(d.ghost);
      el.current.classList.add("lifted");
    }
    d.ghost.style.left = `${e.clientX + 8}px`;
    d.ghost.style.top = `${e.clientY + 8}px`;
    d.ghost.hidden = true;
    const wk = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".pj-week") ?? null;
    d.ghost.hidden = false;
    if (d.over !== wk) {
      d.over?.classList.remove("drop");
      d.over = wk;
      wk?.classList.add("drop");
    }
    const rail = el.current.closest<HTMLElement>(".pj-weeks");
    if (rail) {
      const r = rail.getBoundingClientRect();
      if (e.clientX > r.right - 40) rail.scrollLeft += 14;
      else if (e.clientX < r.left + 40) rail.scrollLeft -= 14;
    }
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    el.current?.releasePointerCapture?.(e.pointerId);
    if (!d) return;
    if (!d.ghost) return onOpen();
    d.ghost.remove();
    el.current?.classList.remove("lifted");
    d.over?.classList.remove("drop");
    if (d.over?.dataset.week) onMove(Number(d.over.dataset.week));
  };

  return (
    <button
      ref={el}
      type="button"
      className={`tm ${t.key && !t.checked ? "key" : "du"}${late ? " late" : ""}${t.checked ? " done" : ""}${canEdit && !t.checked ? " movable" : ""}`}
      onPointerDown={onDown}
      onPointerMove={onMoveP}
      onPointerUp={onUp}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={t.text}
    >
      <b>{t.text}</b>
      <small>
        {t.key && !t.checked ? "Key deadline" : shortSection(t.section)}
        {state} · {late ? due.text : t.checked ? due.text : dateLabel(t.due!)}
        {span > 1 && ` · ${span} days`}
      </small>
    </button>
  );
}

/* ---------------------------------------------------------------- To-do */

type Filter = "open" | "late" | "soon" | "all";
const HINTS: Record<Filter, string> = {
  open: "Late first, then by date. Grouped by the note's sections.",
  late: "Everything past its date.",
  soon: "Due in the next three weeks.",
  all: "Every step; done ones sink to the bottom.",
};
const STATUS_MENU: { id: string; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

export function ProjectTodo({ w, lane, onChanged, onOpenNote, onAdd }: { w: ProjectWorkspace; lane?: string; onChanged: () => Promise<void>; onOpenNote: (id: string) => void; onAdd: () => void }) {
  const tasks = w.tasks as ProjectTask[];
  const today = isoLocal();
  const soon = addDays(today, 21);
  const [filter, setFilter] = useState<Filter>("open");
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const card = useTaskCard(onChanged, onOpenNote);

  const isLate = (t: ProjectTask) => !t.checked && !!t.due && t.due < today;
  const passes: Record<Filter, (t: ProjectTask) => boolean> = {
    open: (t) => !t.checked,
    late: isLate,
    soon: (t) => !t.checked && !!t.due && t.due >= today && t.due <= soon,
    all: () => true,
  };
  const count = (f: Filter) => tasks.filter(passes[f]).length;

  const setStatus = (t: ProjectTask, status: string) =>
    attempt("The step's status wasn't changed.", async () => {
      await api("POST", "/api/tasks/status", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, status });
      await onChanged();
    });
  const check = (t: ProjectTask) =>
    attempt(t.checked ? "The step wasn't unticked." : "The step wasn't ticked.", async () => {
      await api("POST", "/api/tasks/check", { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, checked: !t.checked });
      await onChanged();
    });

  // The project note's own sections in the note's order, then each other note of the project.
  const firstLine = new Map<string, number>();
  for (const t of tasks) if (!firstLine.has(t.section)) firstLine.set(t.section, t.noteId === w.noteId ? t.line : Infinity);
  const sections = [...firstLine.keys()].sort((a, b) => firstLine.get(a)! - firstLine.get(b)! || a.localeCompare(b));
  const order = (a: ProjectTask, b: ProjectTask) =>
    Number(a.checked) - Number(b.checked) || Number(isLate(b)) - Number(isLate(a)) || Number(!!b.key) - Number(!!a.key) || (a.due ?? "9999").localeCompare(b.due ?? "9999");
  const groups = sections.map((section) => {
    const all = tasks.filter((t) => t.section === section);
    const done = all.filter((t) => t.checked);
    const rows = all.filter(passes[filter]).sort(order);
    return { section, all, rows, done };
  });

  return (
    <section className="pj-todo" style={{ ["--lane" as string]: lane ?? "var(--ink-3)" }}>
      <div className="pj-bar3">
        <Tabs
          bare
          label="Show"
          value={filter}
          onChange={setFilter}
          items={(["open", "late", "soon", "all"] as Filter[]).map((f) => ({ id: f, label: { open: "Open", late: "Late", soon: "Next 3 weeks", all: "All" }[f], count: count(f) }))}
        />
        <span className="sp" />
        <span className="pj-hint">{HINTS[filter]}</span>
        {w.canEdit && (
          <Button size="sm" icon="plus" onClick={onAdd}>
            Add a step
          </Button>
        )}
      </div>
      {tasks.length === 0 && (
        <div className="card pj-empty">
          <EmptyState
            pose="sit"
            title="No steps yet"
            text={<>Add one here, write a checkbox (<code>- [ ]</code>) in the note, or capture one in the Inbox.</>}
            actions={w.canEdit ? <Button onClick={onAdd}>Add a step</Button> : undefined}
          />
        </div>
      )}
      {tasks.length > 0 && groups.every((g) => g.rows.length === 0) && filter !== "all" && <p className="q3 pj-none">{filter === "late" ? "Nothing is late." : filter === "soon" ? "Nothing due in the next three weeks." : "Every step is done."}</p>}
      <div className="pj-sections">
        {groups.map(({ section, all, rows, done }) => {
          const folded = filter !== "all" && !unfolded.has(section);
          const doneHere = filter === "all" ? [] : done.filter((t) => !rows.includes(t));
          if (rows.length === 0 && (filter !== "open" || doneHere.length === 0)) return null;
          const cap = expanded.has(section) ? Infinity : 8;
          return (
            <section key={section} className="card pj-sec" aria-label={section}>
              <header className="pj-sh">
                <span className="ui-dot" style={{ background: "var(--lane)" }} />
                <h2>{section}</h2>
                <span className="q3">
                  {done.length} of {all.length}
                </span>
                <span className="pj-sbar" style={{ ["--prog" as string]: "var(--lane)" }}>
                  <Bar value={all.length ? done.length / all.length : 0} label={`${done.length} of ${all.length} done`} />
                </span>
              </header>
              <div className="pj-trows">
                {rows.slice(0, cap).map((t) => (
                  <TodoRow key={`${t.noteId}:${t.line}`} t={t} today={today} canEdit={w.canEdit} onOpen={() => void card.open(t)} onCheck={() => void check(t)} onStatus={(s) => void setStatus(t, s)} />
                ))}
                {!folded && doneHere.map((t) => <TodoRow key={`${t.noteId}:${t.line}`} t={t} today={today} canEdit={w.canEdit} onOpen={() => void card.open(t)} onCheck={() => void check(t)} onStatus={(s) => void setStatus(t, s)} />)}
              </div>
              <div className="pj-folds">
                {rows.length > cap && (
                  <button type="button" className="pj-fold" onClick={() => setExpanded((s) => new Set(s).add(section))}>
                    {rows.length - cap} more
                  </button>
                )}
                {doneHere.length > 0 && (
                  <button
                    type="button"
                    className="pj-fold"
                    aria-expanded={!folded}
                    onClick={() =>
                      setUnfolded((s) => {
                        const n = new Set(s);
                        if (n.has(section)) n.delete(section);
                        else n.add(section);
                        return n;
                      })
                    }
                  >
                    <Icon name={folded ? "chev-r" : "chev-d"} size={14} />
                    {doneHere.length} done
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {card.node}
    </section>
  );
}

/** A step's four states as a menu, at the end of its row (its checkbox only ticks it). */
export function StepMenu({ t, onStatus }: { t: { text: string; checked: boolean; status?: string }; onStatus: (s: string) => void }) {
  const [menu, setMenu] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  const status = t.checked ? "done" : (t.status ?? "todo");
  return (
    <>
      <button
        ref={at}
        type="button"
        className="btn quiet sm icon"
        aria-label={`Status of ${t.text}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={(e) => {
          e.stopPropagation();
          setMenu((v) => !v);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name="dots" size={16} />
      </button>
      {menu && (
        <Menu
          anchor={at}
          align="end"
          label="Status"
          onClose={() => setMenu(false)}
          items={STATUS_MENU.map((s) => ({ label: s.label, checked: s.id === status, onSelect: () => s.id !== status && onStatus(s.id) }))}
        />
      )}
    </>
  );
}

function TodoRow({ t, today, canEdit, onOpen, onCheck, onStatus }: { t: ProjectTask; today: string; canEdit: boolean; onOpen: () => void; onCheck: () => void; onStatus: (s: string) => void }) {
  const due = dueOf(t, today);
  const note = t.status === "in-progress" && !t.checked ? "in progress" : t.status === "blocked" && !t.checked ? "blocked" : "";
  return (
    <div className={`pj-trow${t.checked ? " done" : ""}`}>
      <Checkbox state={taskState(t)} label={t.checked ? `Reopen ${t.text}` : `Complete ${t.text}`} onToggle={canEdit ? onCheck : undefined} />
      {/* The step's words open its card, and stretch over the row (§1.7 #7); the checkbox and
          the menu sit above them, so no control is inside another. */}
      <button type="button" className="pj-ttl pj-open" title={t.text} onClick={onOpen}>
        <span className="t">{t.text}</span>
        {note && <span className="nt">{note}</span>}
      </button>
      {t.key && !t.checked ? <span className="chip-dl s">Key deadline</span> : <span />}
      <span className={`pj-dd${due.late ? " late" : ""}`}>{due.text}</span>
      {canEdit ? (
        <span className="pj-tact">
          <StepMenu t={t} onStatus={onStatus} />
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Documents board */

const nameOf = (n: FileNode) => n.file.split("/").pop()!;
const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE");
const newId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;
/** The JSON Canvas colours a new box cycles through. The board draws boxes uncoloured; the colour is kept in the file for Obsidian. */
const BOX_COLOURS = ["1", "2", "3", "4", "5", "6"];

export function ProjectBoard({ w, onChanged }: { w: ProjectWorkspace; onChanged: () => Promise<void> }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const canvas = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const [, setTick] = useState(0); // redraw edges once cards have measured
  const slug = encodeURIComponent(w.slug);

  const load = useCallback(async () => {
    try {
      setBoard(await api<Board>("GET", `/api/projects/${slug}/board`));
      setError(null);
    } catch {
      setError({ title: "The board could not be opened", text: "Check that the server is running, then come back to this tab." });
    }
  }, [slug]);
  useEffect(() => void load(), [load, w.files.length]);
  useEffect(() => {
    const id = requestAnimationFrame(() => setTick((n) => n + 1));
    return () => cancelAnimationFrame(id);
  }, [board]);

  // Saves are debounced: a drag is many moves and one write. What is waiting is kept, so
  // leaving the board (another tab, another page) sends it at once instead of dropping it
  // (WEB-014).
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<Board | null>(null);
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current);
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    api("PUT", `/api/projects/${slug}/board`, { nodes: next.nodes, edges: next.edges }).catch(() =>
      setError({ title: "The last change to the board was not saved", text: "Check that the server is running and move a card again; the board saves what it shows." }),
    );
  }, [slug]);
  const commit = (next: Board) => {
    setBoard(next);
    if (!next.canEdit) return;
    pending.current = next;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 400);
  };
  useEffect(() => flush, [flush]);

  const files = (
    <input
      ref={upload}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        const list = e.target.files;
        e.target.value = "";
        if (!list?.length) return;
        // Each file that didn't upload is listed by name (uploadProjectFiles never throws).
        const failed: string[] = [];
        void uploadProjectFiles(w.slug, list, setBusy, (m) => failed.push(m)).then(() => {
          setBusy("");
          setUploadErrors(failed);
          return onChanged();
        });
      }}
    />
  );

  if (!board) return error ? <Notice title={error.title} text={error.text} /> : <Skeleton rows={3} label="Opening the board" />;
  const editable = !!board.canEdit;

  const cards = board.nodes.filter((n): n is FileNode => n.type === "file");
  const groups = board.nodes.filter((n): n is GroupNode => n.type === "group");
  const width = Math.max(960, ...board.nodes.map((n) => n.x + n.width + 40));
  const height = Math.max(520, ...board.nodes.map((n) => n.y + n.height + 40));

  const patchNode = (id: string, change: Partial<BoardNode>) => ({ ...board, nodes: board.nodes.map((n) => (n.id === id ? ({ ...n, ...change } as BoardNode) : n)) });
  const plainEdge = (e: BoardEdge): BoardEdge => ({ id: e.id, fromNode: e.fromNode, toNode: e.toNode, ...(e.label ? { label: e.label } : {}) });
  const accept = (id: string) => commit({ ...board, edges: board.edges.map((x) => (x.id === id ? plainEdge(x) : x)) });
  const drop = (id: string) => commit({ ...board, edges: board.edges.filter((x) => x.id !== id) });

  /** Drag a card, or a box together with the cards inside it. */
  const startDrag = (e: React.PointerEvent, node: BoardNode) => {
    if (!editable || e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY;
    const carry = node.type === "group"
      ? cards.filter((c) => c.x + c.width / 2 > node.x && c.x + c.width / 2 < node.x + node.width && c.y + c.height / 2 > node.y && c.y + c.height / 2 < node.y + node.height)
      : [];
    const start = new Map([[node.id, { x: node.x, y: node.y }], ...carry.map((c) => [c.id, { x: c.x, y: c.y }] as const)]);
    let moved = false;
    let latest = board;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const move = (m: PointerEvent) => {
      const dx = m.clientX - sx, dy = m.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      latest = { ...latest, nodes: latest.nodes.map((n) => (start.has(n.id) ? { ...n, x: Math.max(0, start.get(n.id)!.x + dx), y: Math.max(0, start.get(n.id)!.y + dy) } : n)) };
      setBoard(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (moved) commit(latest);
      else if (node.type === "file") clickCard(node);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const clickCard = (n: FileNode) => {
    if (!linking) return setReading(nameOf(n));
    if (!picked) return setPicked(n.id);
    if (picked !== n.id && !board.edges.some((e) => [e.fromNode, e.toNode].sort().join() === [picked, n.id].sort().join())) {
      commit({ ...board, edges: [...board.edges, { id: newId("e"), fromNode: picked, toNode: n.id }] });
    }
    setPicked(null);
  };

  const resizeBox = (e: React.PointerEvent, g: GroupNode) => {
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    let latest = board;
    const move = (m: PointerEvent) => {
      latest = { ...latest, nodes: latest.nodes.map((n) => (n.id === g.id ? { ...n, width: Math.max(220, g.width + m.clientX - sx), height: Math.max(120, g.height + m.clientY - sy) } : n)) };
      setBoard(latest);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      commit(latest);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const addBox = () => {
    const sc = canvas.current;
    const g: GroupNode = { id: newId("g"), type: "group", label: "New box", color: BOX_COLOURS[groups.length % BOX_COLOURS.length], x: (sc?.scrollLeft ?? 0) + 40, y: (sc?.scrollTop ?? 0) + 40, width: 480, height: 220 };
    commit({ ...board, nodes: [g, ...board.nodes] });
    setRenaming(g.id);
  };

  const suggestions = board.edges.filter((e) => e.basaltSuggested);
  const q = query.trim().toLowerCase();

  // Connectors run between the facing edges of two cards, never centre to centre.
  const rect = (id: string) => {
    const n = board.nodes.find((x) => x.id === id)!;
    const el = canvas.current?.querySelector<HTMLElement>(`[data-node="${id}"]`);
    return { x: n.x, y: n.y, w: n.width, h: el?.offsetHeight ?? n.height };
  };
  const route = (e: BoardEdge) => {
    const a0 = rect(e.fromNode), b0 = rect(e.toNode);
    const ca = { x: a0.x + a0.w / 2, y: a0.y + a0.h / 2 }, cb = { x: b0.x + b0.w / 2, y: b0.y + b0.h / 2 };
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    const horiz = Math.abs(dx) > (a0.w + b0.w) / 2 - 20 && Math.abs(dx) >= Math.abs(dy) * 0.8;
    const a = horiz ? { x: dx > 0 ? a0.x + a0.w : a0.x, y: ca.y } : { x: ca.x, y: dy > 0 ? a0.y + a0.h : a0.y };
    const b = horiz ? { x: dx > 0 ? b0.x : b0.x + b0.w, y: cb.y } : { x: cb.x, y: dy > 0 ? b0.y : b0.y + b0.h };
    const k = Math.max(24, (horiz ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) / 2);
    const c1 = horiz ? { x: a.x + Math.sign(dx) * k, y: a.y } : { x: a.x, y: a.y + Math.sign(dy) * k };
    const c2 = horiz ? { x: b.x - Math.sign(dx) * k, y: b.y } : { x: b.x, y: b.y - Math.sign(dy) * k };
    const at = (t: number) => {
      const u = 1 - t;
      return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
    };
    return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, a, b, at };
  };
  const lit = (e: BoardEdge) => !!focus && (e.fromNode === focus || e.toNode === focus);
  const edgeClick = (ev: React.MouseEvent, e: BoardEdge) => {
    if (!editable) return;
    if (e.basaltSuggested) {
      if (ev.shiftKey) accept(e.id);
      else setTip(e.id);
    } else drop(e.id);
  };
  const cardName = (id: string) => {
    const n = board.nodes.find((x) => x.id === id);
    return n?.type === "file" ? nameOf(n).replace(/\.[^.]+$/, "") : "";
  };
  const tipEdge = tip ? board.edges.find((e) => e.id === tip && e.basaltSuggested) : undefined;
  const tipAt = tipEdge ? route(tipEdge).at(0.5) : null;

  return (
    <div className="pj-board">
      {files}
      <div className="pj-bar3">
        <SearchField label="Find a document" placeholder="Find a document" className="pj-find" value={query} onChange={(e) => setQuery(e.target.value)} />
        {editable && (
          <>
            <Button size="sm" icon="upload" disabled={!!busy} onClick={() => upload.current?.click()}>
              {busy ? `Uploading ${busy}…` : "Upload"}
            </Button>
            <Button size="sm" icon="plus" onClick={addBox}>
              Box
            </Button>
            <Button
              size="sm"
              icon="link"
              kind={linking ? "default" : "quiet"}
              aria-pressed={linking}
              onClick={() => {
                setLinking((v) => !v);
                setPicked(null);
              }}
            >
              {linking ? (picked ? "Now the other card" : "Pick the first card") : "Link two"}
            </Button>
            {suggestions.length > 0 && (
              <Button size="sm" orr onClick={() => setTip(suggestions[0]!.id)}>
                {suggestions.length} suggested {suggestions.length === 1 ? "link" : "links"}
              </Button>
            )}
          </>
        )}
        <span className="sp" />
        <span className="pj-hint">
          {cards.length} {cards.length === 1 ? "document" : "documents"} · {board.edges.length} {board.edges.length === 1 ? "link" : "links"}
        </span>
      </div>
      {error && <Notice title={error.title} text={error.text} />}
      {uploadErrors.length > 0 && <Notice title={uploadErrors.length === 1 ? "A file was not uploaded" : `${uploadErrors.length} files were not uploaded`} text={uploadErrors.join(" · ")} />}
      {board.unreadable && <Notice title="documents.canvas could not be read" text="This is the default layout. Moving anything replaces the file with it." />}
      {cards.length === 0 && groups.length === 0 ? (
        <div className="card pj-empty">
          <EmptyState
            pose="carry"
            title="No documents yet"
            text={<>Files you upload land in <code>04-Projects/{w.slug}/files/</code>, where Finder and Obsidian see them too.</>}
            actions={editable ? <Button onClick={() => upload.current?.click()}>Upload a file</Button> : undefined}
          />
        </div>
      ) : (
        <div className="pj-canvas" ref={canvas}>
          <div className="pj-plane" style={{ width, height }}>
            <svg className="pj-edges" width={width} height={height} aria-hidden="true">
              {board.edges.map((e) => {
                const r = route(e);
                return (
                  <g key={e.id} className={`pj-edge${e.basaltSuggested ? " sugg" : ""}${lit(e) ? " lit" : ""}${focus && !lit(e) ? " faded" : ""}`} onClick={(ev) => edgeClick(ev, e)}>
                    <path className="hit" d={r.d} />
                    <path className="line" d={r.d} />
                    <circle cx={r.a.x} cy={r.a.y} r={3} />
                    <circle cx={r.b.x} cy={r.b.y} r={3} />
                    <title>{`${e.label ?? "Linked"}${e.basaltSuggested ? " (suggested by Orr)" : ""}${editable ? (e.basaltSuggested ? ". Click to decide." : ". Click to remove.") : ""}`}</title>
                  </g>
                );
              })}
            </svg>
            {groups.map((g) => (
              <div key={g.id} className="pj-box" data-node={g.id} style={{ left: g.x, top: g.y, width: g.width, height: g.height }}>
                {/* The head takes the pointer to drag, so a double-click lands on it, not on the
                    label: rename is handled here. */}
                <div className="pj-box-head" onPointerDown={(e) => renaming !== g.id && startDrag(e, g)} onDoubleClick={() => editable && setRenaming(g.id)}>
                  {renaming === g.id ? (
                    <input
                      className="pj-box-input"
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      defaultValue={g.label}
                      aria-label="Box name"
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        commit(patchNode(g.id, { label: e.target.value.trim() || "Untitled" }));
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <span className="pj-box-label">{g.label}</span>
                  )}
                  {editable && renaming !== g.id && (
                    <span className="pj-box-btns">
                      <button type="button" aria-label={`Rename ${g.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setRenaming(g.id)}>
                        <Icon name="pen" size={12} />
                      </button>
                      <button type="button" aria-label={`Delete box ${g.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => commit({ ...board, nodes: board.nodes.filter((n) => n.id !== g.id) })}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  )}
                </div>
                {editable && <span className="pj-grip" onPointerDown={(e) => resizeBox(e, g)} aria-hidden="true" />}
              </div>
            ))}
            {cards.map((c) => {
              const name = nameOf(c);
              const hit = q && name.toLowerCase().includes(q);
              return (
                <div
                  key={c.id}
                  data-node={c.id}
                  role="button"
                  tabIndex={0}
                  className={`pj-card${picked === c.id ? " picked" : ""}${q ? (hit ? " hit" : " dim") : ""}${editable ? " movable" : ""}`}
                  style={{ left: c.x, top: c.y, width: c.width }}
                  onPointerDown={(e) => (editable ? startDrag(e, c) : undefined)}
                  onClick={() => !editable && clickCard(c)}
                  onKeyDown={(e) => e.key === "Enter" && clickCard(c)}
                  onMouseEnter={() => setFocus(c.id)}
                  onMouseLeave={() => setFocus(null)}
                  onFocus={() => setFocus(c.id)}
                  onBlur={() => setFocus(null)}
                  title={`${name}: ${linking ? "click to link" : "click to open"}`}
                >
                  <span className="pj-ext">{extOf(name)}</span>
                  <span className="pj-cn">{name.replace(/\.[^.]+$/, "")}</span>
                </div>
              );
            })}
            <svg className="pj-labels" width={width} height={height} aria-hidden="true">
              {board.edges.map((e) => {
                if (!e.label || !lit(e) || e.basaltSuggested) return null;
                const m = route(e).at(e.fromNode === focus ? 0.72 : 0.28);
                return (
                  <text key={e.id} x={m.x} y={m.y - 7} textAnchor="middle">
                    {e.label}
                  </text>
                );
              })}
            </svg>
            {tipEdge && tipAt && (
              <SuggestTip x={tipAt.x} y={tipAt.y} onClose={() => setTip(null)}>
                <span>{tipEdge.label ? `${tipEdge.label}. Link them?` : `Link ${cardName(tipEdge.fromNode)} and ${cardName(tipEdge.toNode)}?`}</span>
                <Button
                  size="sm"
                  onClick={() => {
                    accept(tipEdge.id);
                    setTip(null);
                  }}
                >
                  Link
                </Button>
                <Button
                  size="sm"
                  kind="quiet"
                  onClick={() => {
                    drop(tipEdge.id);
                    setTip(null);
                  }}
                >
                  No
                </Button>
              </SuggestTip>
            )}
          </div>
        </div>
      )}
      <p className="pj-hint pj-dhint">
        {editable ? "Drag cards and boxes; a box carries its cards. Dashed lines are Orr's suggestions." : "Point at a card to see its links; click it to open."}
      </p>
      {reading && <DocViewer base={`/api/projects/${slug}/files`} name={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

/** Orr's question about one suggested link, beside it on the board. Escape closes it. */
function SuggestTip({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div ref={box} className="pj-tip" role="dialog" aria-label="Suggested link" style={{ left: Math.max(8, x - 200), top: y + 12 }}>
      <HeadMark size={16} />
      {children}
    </div>
  );
}
