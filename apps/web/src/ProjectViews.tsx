import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, daysTo, isoLocal } from "@basalt/core";
import { api } from "./api.js";
import { DocViewer } from "./DocViewer.js";
import { TaskCard, type PlannableTask } from "./TaskCard.js";
import type { ProjectWorkspace } from "./Project.js";
import type { Board, BoardEdge, BoardNode, FileNode, GroupNode, ProjectTask } from "@basalt/schema/responses";
import { Icon } from "./ui/Icon.js";

/**
 * The project page's three working views, from the approved Sep 2026 mock:
 *
 *   Timeline  — one column per week, a card per dated step, key deadlines red;
 *               drag a card to another week and its dates move by whole weeks
 *               (POST /api/tasks/dates, so the note's `due:` changes).
 *   To-do     — the steps grouped by the project note's own `##` sections.
 *   Documents — the project's files as cards on a board, in boxes, linked;
 *               saved to documents.canvas beside the note (routes/projects.ts).
 *
 * All three are views over the note and its folder: nothing here lives only in
 * the database.
 */

export type { ProjectTask };

/** A section's colour, by the order it first appears: the note's structure picks it. */
const INKS = ["var(--ink-azure)", "var(--ink-lilac)", "var(--ink-pink)", "var(--ink-cyan)", "var(--ink-magenta)", "var(--ink-amber)"];
export function sectionColours(tasks: ProjectTask[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of tasks) if (!m.has(t.section)) m.set(t.section, INKS[m.size % INKS.length]!);
  return m;
}
/** "Research plan — due 19 October, the block's decisive deadline" → "Research plan". */
export const shortSection = (s: string) => s.split(/\s+[—–-]\s+|,/)[0]!.trim();

const fmt = (iso: string, o: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { ...o, timeZone: "UTC" });
const DAY = 86_400_000;
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
/** Monday of the week an ISO date falls in, as a day number. */
const mondayOf = (iso: string) => {
  const n = dayNum(iso);
  return n - ((new Date(n * DAY).getUTCDay() + 6) % 7);
};

/** The task card Planning uses, with the planner's hours when it knows the step. */
export function useTaskCard(onChanged: () => Promise<void>, onOpenNote: (id: string) => void) {
  const [card, setCard] = useState<PlannableTask | null>(null);
  const open = useCallback(async (t: ProjectTask) => {
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

/* ---------------------------------------------------------------- Timeline */

export function ProjectTimeline({ w, onChanged, onOpenNote }: { w: ProjectWorkspace; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const tasks = w.tasks as ProjectTask[];
  const today = isoLocal();
  const colours = useMemo(() => sectionColours(tasks), [tasks]);
  const [everything, setEverything] = useState(false);
  const [note, setNote] = useState("");
  const rail = useRef<HTMLDivElement>(null);
  const card = useTaskCard(onChanged, onOpenNote);

  const dated = tasks.filter((t) => t.due && (everything || !t.checked || t.key));
  // The weeks the project spans: its own start/deadline, stretched to hold every dated step.
  const bounds = [w.start, w.deadline, today, ...dated.map((t) => t.due!), ...dated.map((t) => t.start ?? t.due!)].filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const first = mondayOf(bounds.reduce((a, b) => (a < b ? a : b), today));
  const last = mondayOf(bounds.reduce((a, b) => (a > b ? a : b), today));
  const weeks: number[] = [];
  for (let n = first; n <= last && weeks.length < 104; n += 7) weeks.push(n);
  const thisWeek = mondayOf(today);

  useEffect(() => {
    const el = rail.current?.querySelector<HTMLElement>(".ptl-week.now");
    if (el && rail.current) rail.current.scrollLeft = Math.max(0, el.offsetLeft - el.offsetWidth);
  }, [w.slug]);

  const move = async (t: ProjectTask, toWeek: number) => {
    const shift = toWeek - mondayOf(t.due!);
    if (!shift) return;
    const due = isoOf(dayNum(t.due!) + shift);
    await api("POST", "/api/tasks/dates", {
      noteId: t.noteId, line: t.line, blockId: t.blockId, due,
      ...(t.start ? { start: isoOf(dayNum(t.start) + shift) } : {}),
    });
    setNote(`Moved “${t.text.slice(0, 48)}${t.text.length > 48 ? "…" : ""}” to ${fmt(due, { weekday: "short", day: "numeric", month: "short" })}.`);
    await onChanged();
  };

  return (
    <section className="proj-card ptl">
      <div className="ptl-bar">
        <div className="ptl-legend">
          {[...colours].map(([s, c]) => (
            <span key={s}><i style={{ background: c }} />{shortSection(s)}</span>
          ))}
          <span><i className="key" />Key deadline</span>
        </div>
        <div className="seg" role="group" aria-label="Show">
          <button className={`seg-btn ${!everything ? "active" : ""}`} aria-pressed={!everything} onClick={() => setEverything(false)}>Open work</button>
          <button className={`seg-btn ${everything ? "active" : ""}`} aria-pressed={everything} onClick={() => setEverything(true)}>Everything</button>
        </div>
      </div>
      {dated.length === 0 ? (
        <p className="empty">No dated steps yet. Add <code>due:YYYY-MM-DD</code> to a step and it appears here.</p>
      ) : (
        <div className="ptl-rail" ref={rail}>
          {weeks.map((wk) => {
            const inWeek = dated
              .filter((t) => mondayOf(t.due!) === wk)
              .sort((a, b) => Number(!!b.key) - Number(!!a.key) || a.due!.localeCompare(b.due!));
            const monthStart = new Date(wk * DAY).getUTCDate() <= 7;
            return (
              <div key={wk} className={`ptl-week ${wk === thisWeek ? "now" : ""} ${monthStart ? "month" : ""}`} data-week={wk}>
                <div className="ptl-head">
                  <b>{fmt(isoOf(wk))}</b>
                  <span>{wk === thisWeek ? "this week" : monthStart ? fmt(isoOf(wk), { month: "long" }) : ""}</span>
                </div>
                <div className="ptl-cards">
                  {inWeek.map((t) => (
                    <TimelineCard key={`${t.noteId}:${t.line}`} t={t} today={today} colour={colours.get(t.section)!} canEdit={w.canEdit} onOpen={() => void card.open(t)} onMove={(wk2) => void move(t, wk2)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="ptl-hint">
        {note || (w.canEdit ? "Drag a card to another week to move its date, click it for the detail." : "Click a card for the detail.")}
      </p>
      {card.node}
    </section>
  );
}

function TimelineCard({ t, today, colour, canEdit, onOpen, onMove }: { t: ProjectTask; today: string; colour: string; canEdit: boolean; onOpen: () => void; onMove: (week: number) => void }) {
  const late = !t.checked && t.due! < today;
  const span = t.start ? dayNum(t.due!) - dayNum(t.start) + 1 : 0;
  const drag = useRef<{ x: number; y: number; ghost: HTMLElement | null; over: HTMLElement | null } | null>(null);
  const el = useRef<HTMLButtonElement>(null);

  const onDown = (e: React.PointerEvent) => {
    if (!canEdit || t.checked) return;
    drag.current = { x: e.clientX, y: e.clientY, ghost: null, over: null };
    el.current?.setPointerCapture(e.pointerId);
  };
  const onMoveP = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !el.current) return;
    if (!d.ghost && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 6) return;
    if (!d.ghost) {
      d.ghost = el.current.cloneNode(true) as HTMLElement;
      d.ghost.classList.add("ghost");
      d.ghost.style.width = `${el.current.offsetWidth}px`;
      document.body.appendChild(d.ghost);
      el.current.classList.add("lifted");
    }
    d.ghost.style.left = `${e.clientX + 8}px`;
    d.ghost.style.top = `${e.clientY + 8}px`;
    d.ghost.hidden = true;
    const wk = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(".ptl-week") ?? null;
    d.ghost.hidden = false;
    if (d.over !== wk) {
      d.over?.classList.remove("drop");
      d.over = wk;
      wk?.classList.add("drop");
    }
    const rail = el.current.closest<HTMLElement>(".ptl-rail");
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
    if (!d || !d.ghost) return onOpen();
    d.ghost.remove();
    el.current?.classList.remove("lifted");
    d.over?.classList.remove("drop");
    if (d.over?.dataset.week) onMove(Number(d.over.dataset.week));
  };

  return (
    <button
      ref={el}
      className={`ptl-card ${t.checked ? "done" : ""} ${late ? "late" : ""} ${t.key ? "key" : ""} ${canEdit && !t.checked ? "movable" : ""}`}
      style={{ ["--phase" as string]: colour }}
      onPointerDown={onDown}
      onPointerMove={onMoveP}
      onPointerUp={onUp}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      title={t.text}
    >
      <span className="t">{t.text}</span>
      <span className="m">
        {t.key && "Key · "}
        {late ? `${daysTo(t.due!, today)}d late` : fmt(t.due!)}
        {span > 1 && <span className="len"> · {span}d</span>}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- To-do */

type Filter = "open" | "late" | "soon" | "all";
const HINTS: Record<Filter, string> = {
  open: "Late first, then by date. Done steps are folded away.",
  late: "Everything past its date.",
  soon: "Due in the next three weeks.",
  all: "Every step, done ones included.",
};

export function ProjectTodo({ w, onChanged, onOpenNote }: { w: ProjectWorkspace; onChanged: () => Promise<void>; onOpenNote: (id: string) => void }) {
  const tasks = w.tasks as ProjectTask[];
  const today = isoLocal();
  const soon = addDays(today, 21);
  const colours = useMemo(() => sectionColours(tasks), [tasks]);
  const [filter, setFilter] = useState<Filter>("open");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const card = useTaskCard(onChanged, onOpenNote);

  const isLate = (t: ProjectTask) => !t.checked && !!t.due && t.due < today;
  const pass = (t: ProjectTask) =>
    filter === "all" ? true : filter === "open" ? !t.checked : filter === "late" ? isLate(t) : !t.checked && !!t.due && t.due >= today && t.due <= soon;

  const setStatus = async (t: ProjectTask, status: string) => {
    await api("POST", "/api/tasks/status", { noteId: t.noteId, line: t.line, blockId: t.blockId, status });
    await onChanged();
  };
  const check = async (t: ProjectTask) => {
    await api("POST", "/api/tasks/check", { noteId: t.noteId, line: t.line, blockId: t.blockId, checked: !t.checked });
    await onChanged();
  };

  const groups = [...colours.keys()].map((section) => {
    const all = tasks.filter((t) => t.section === section);
    const rows = all
      .filter(pass)
      .sort((a, b) => Number(isLate(b)) - Number(isLate(a)) || Number(!!b.key) - Number(!!a.key) || (a.due ?? "9999").localeCompare(b.due ?? "9999"));
    return { section, all, rows, done: all.filter((t) => t.checked).length };
  });

  return (
    <div className="ptd">
      <div className="ptl-bar">
        <div className="seg" role="group" aria-label="Filter steps">
          {(["open", "late", "soon", "all"] as Filter[]).map((f) => (
            <button key={f} className={`seg-btn ${filter === f ? "active" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {{ open: "Open", late: "Late", soon: "Next 3 weeks", all: "All" }[f]}
            </button>
          ))}
        </div>
        <span className="ptl-hint">{HINTS[filter]}</span>
      </div>
      {tasks.length === 0 && <p className="empty">No steps yet. Add <code>- [ ]</code> lines to the note, or capture one in the inbox.</p>}
      {groups.map(({ section, all, rows, done }) => {
        if (rows.length === 0) return null;
        const cap = expanded.has(section) ? rows.length : 6;
        return (
          <section key={section} className="proj-card ptd-group" style={{ ["--phase" as string]: colours.get(section) }}>
            <header className="ptd-head">
              <span className="dot" />
              <h2>{section}</h2>
              <span className="ptd-prog" aria-label={`${done} of ${all.length} done`}><i style={{ width: `${(done / all.length) * 100}%` }} /></span>
              <span className="ptd-count">{done}/{all.length}</span>
            </header>
            <ul className="ptd-rows">
              {rows.slice(0, cap).map((t) => {
                const late = isLate(t);
                const days = t.due ? daysTo(today, t.due) : null;
                const status = t.status;
                return (
                  <li key={`${t.noteId}:${t.line}`} className={`ptd-row ${t.checked ? "done" : ""}`}>
                    <button className="ptd-box" disabled={!w.canEdit} aria-label={`${t.checked ? "Reopen" : "Complete"} ${t.text}`} onClick={() => void check(t)} />
                    <button className="ptd-text" onClick={() => void card.open(t)}>{t.text}</button>
                    <span className="ptd-chips">
                      {t.key && <span className="ptd-chip key">Key deadline</span>}
                      {!t.checked && (
                        <select
                          className={`ptd-status ${status === "in-progress" || status === "blocked" ? status : ""}`}
                          value={status === "in-progress" || status === "blocked" ? status : "todo"}
                          disabled={!w.canEdit}
                          aria-label={`Status of ${t.text}`}
                          onChange={(e) => void setStatus(t, e.target.value)}
                        >
                          <option value="todo">To do</option>
                          <option value="in-progress">In progress</option>
                          <option value="blocked">Blocked</option>
                        </select>
                      )}
                      {t.due && (
                        <span className={`ptd-chip ${late ? "late" : days !== null && days >= 0 && days <= 7 && !t.checked ? "soon" : ""}`}>
                          {late ? `${-(days ?? 0)}d late` : fmt(t.due)}
                        </span>
                      )}
                      {t.priority === 1 && !t.checked && <span className="ptd-chip p1">P1</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
            {rows.length > cap && (
              <button className="ptd-more" onClick={() => setExpanded((s) => new Set(s).add(section))}>Show {rows.length - cap} more</button>
            )}
          </section>
        );
      })}
      {card.node}
    </div>
  );
}

/* ---------------------------------------------------------------- Documents board */

/** JSON Canvas preset colours onto Basalt's inks (green stays status-only). */
const PRESET: Record<string, string> = { "1": "var(--ink-pink)", "2": "var(--ink-amber)", "3": "var(--ink-magenta)", "4": "var(--ink-azure)", "5": "var(--ink-cyan)", "6": "var(--ink-lilac)" };
const boxColour = (g: GroupNode) => PRESET[g.color ?? "6"] ?? PRESET["6"]!;
const nameOf = (n: FileNode) => n.file.split("/").pop()!;
const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE");
const newId = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

export function ProjectBoard({ w, onUpload }: { w: ProjectWorkspace; onUpload: () => void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reading, setReading] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0); // redraw edges once cards have measured
  const slug = encodeURIComponent(w.slug);

  const load = useCallback(async () => {
    try {
      setBoard(await api<Board>("GET", `/api/projects/${slug}/board`));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load the board");
    }
  }, [slug]);
  useEffect(() => void load(), [load, w.files.length]);
  useEffect(() => { const id = requestAnimationFrame(() => setTick((n) => n + 1)); return () => cancelAnimationFrame(id); }, [board]);

  // Saves are debounced: a drag is many moves and one write.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const commit = (next: Board) => {
    setBoard(next);
    if (!next.canEdit) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api("PUT", `/api/projects/${slug}/board`, { nodes: next.nodes, edges: next.edges }).catch((e) =>
        setError(e instanceof Error ? `Not saved: ${e.message}` : "Not saved"),
      );
    }, 400);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  if (error && !board) return <p className="form-error">{error}</p>;
  if (!board) return <p className="empty">Opening the board…</p>;
  const editable = !!board.canEdit;

  const cards = board.nodes.filter((n): n is FileNode => n.type === "file");
  const groups = board.nodes.filter((n): n is GroupNode => n.type === "group");
  const width = Math.max(960, ...board.nodes.map((n) => n.x + n.width + 40));
  const height = Math.max(520, ...board.nodes.map((n) => n.y + n.height + 40));

  const patchNode = (id: string, change: Partial<BoardNode>) => ({ ...board, nodes: board.nodes.map((n) => (n.id === id ? ({ ...n, ...change } as BoardNode) : n)) });

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
    target.setPointerCapture(e.pointerId);
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
    target.setPointerCapture(e.pointerId);
    let latest = board;
    const move = (m: PointerEvent) => {
      latest = { ...latest, nodes: latest.nodes.map((n) => (n.id === g.id ? { ...n, width: Math.max(220, g.width + m.clientX - sx), height: Math.max(120, g.height + m.clientY - sy) } : n)) };
      setBoard(latest);
    };
    const up = () => { target.removeEventListener("pointermove", move); target.removeEventListener("pointerup", up); commit(latest); };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const addBox = () => {
    const sc = canvas.current;
    const colours = Object.keys(PRESET);
    const g: GroupNode = { id: newId("g"), type: "group", label: "New box", color: colours[groups.length % colours.length], x: (sc?.scrollLeft ?? 0) + 40, y: (sc?.scrollTop ?? 0) + 40, width: 480, height: 220 };
    commit({ ...board, nodes: [g, ...board.nodes] });
    setRenaming(g.id);
  };

  const suggested = board.edges.filter((e) => e.basaltSuggested).length;
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
    if (ev.shiftKey && e.basaltSuggested) commit({ ...board, edges: board.edges.map((x) => (x.id === e.id ? { id: x.id, fromNode: x.fromNode, toNode: x.toNode, ...(x.label ? { label: x.label } : {}) } : x)) });
    else commit({ ...board, edges: board.edges.filter((x) => x.id !== e.id) });
  };

  return (
    <div className="pbd">
      <div className="ptl-bar">
        <div className="pbd-tools">
          <input className="pbd-search" type="search" placeholder="Find a document" aria-label="Find a document" value={query} onChange={(e) => setQuery(e.target.value)} />
          {editable && (
            <>
              <button className="proj-mini" onClick={onUpload}>Upload</button>
              <button className="proj-mini" onClick={addBox}>Add box</button>
              <button className={`proj-mini ${linking ? "on" : ""}`} aria-pressed={linking} onClick={() => { setLinking((v) => !v); setPicked(null); }}>Link two cards</button>
              {suggested > 0 && (
                <button className="proj-mini" onClick={() => commit({ ...board, edges: board.edges.map((e) => ({ id: e.id, fromNode: e.fromNode, toNode: e.toNode, ...(e.label ? { label: e.label } : {}) })) })}>
                  Accept {suggested} suggested
                </button>
              )}
            </>
          )}
        </div>
        <span className="ptl-hint">{error || (linking ? (picked ? "Now click the card to link it to." : "Click the first card.") : `${cards.length} documents · ${board.edges.length} links`)}</span>
      </div>
      {board.unreadable && <p className="form-error">documents.canvas could not be read, so this is the default layout. Editing will replace it.</p>}
      <div className="pbd-canvas" ref={canvas}>
        <div className="pbd-plane" style={{ width, height }}>
          <svg className="pbd-edges" width={width} height={height} aria-hidden="true">
            {board.edges.map((e) => {
              const r = route(e);
              return (
                <g key={e.id} className={`pbd-edge ${e.basaltSuggested ? "sugg" : ""} ${lit(e) ? "lit" : ""} ${focus && !lit(e) ? "faded" : ""}`} onClick={(ev) => edgeClick(ev, e)}>
                  <path className="hit" d={r.d} />
                  <path className="line" d={r.d} />
                  <circle cx={r.a.x} cy={r.a.y} r={3} />
                  <circle cx={r.b.x} cy={r.b.y} r={3} />
                  <title>{`${e.label ?? "Linked"}${e.basaltSuggested ? " (suggested)" : ""}${editable ? (e.basaltSuggested ? ". Shift-click to accept, click to remove." : ". Click to remove.") : ""}`}</title>
                </g>
              );
            })}
          </svg>
          {groups.map((g) => (
            <div key={g.id} className="pbd-box" data-node={g.id} style={{ left: g.x, top: g.y, width: g.width, height: g.height, ["--zc" as string]: boxColour(g) }}>
              {/* The head captures the pointer to drag, so a double-click lands on
                  it, not on the label: rename is handled here. */}
              <div className="pbd-box-head" onPointerDown={(e) => renaming !== g.id && startDrag(e, g)} onDoubleClick={() => editable && setRenaming(g.id)}>
                {renaming === g.id ? (
                  <input
                    className="pbd-box-input"
                    autoFocus
                    onFocus={(e) => e.target.select()}
                    defaultValue={g.label}
                    aria-label="Box name"
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => { commit(patchNode(g.id, { label: e.target.value.trim() || "Untitled" })); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }}
                  />
                ) : (
                  <span className="pbd-box-label">{g.label}</span>
                )}
                {editable && renaming !== g.id && (
                  <>
                    <button className="pbd-box-btn" aria-label={`Rename ${g.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => setRenaming(g.id)}><Icon name="pen" size={12} /></button>
                    <button className="pbd-box-btn" aria-label={`Delete box ${g.label}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => commit({ ...board, nodes: board.nodes.filter((n) => n.id !== g.id) })}><Icon name="x" size={12} /></button>
                  </>
                )}
              </div>
              {editable && <span className="pbd-grip" onPointerDown={(e) => resizeBox(e, g)} />}
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
                className={`pbd-card ${picked === c.id ? "picked" : ""} ${q ? (hit ? "hit" : "dim") : ""} ${editable ? "movable" : ""}`}
                style={{ left: c.x, top: c.y, width: c.width }}
                onPointerDown={(e) => (editable ? startDrag(e, c) : undefined)}
                onClick={() => !editable && clickCard(c)}
                onKeyDown={(e) => e.key === "Enter" && clickCard(c)}
                onMouseEnter={() => setFocus(c.id)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(c.id)}
                onBlur={() => setFocus(null)}
                title={`${name} — ${linking ? "click to link" : "click to open"}`}
              >
                <span className="proj-ext">{extOf(name)}</span>
                <b>{name.replace(/\.[^.]+$/, "")}</b>
              </div>
            );
          })}
          <svg className="pbd-labels" width={width} height={height} aria-hidden="true">
            {board.edges.map((e) => {
              if (!e.label) return null;
              const on = lit(e);
              const m = route(e).at(on ? (e.fromNode === focus ? 0.72 : 0.28) : 0.5);
              return <text key={e.id} className={on ? "on" : ""} x={m.x} y={m.y - 6} textAnchor="middle">{e.label}</text>;
            })}
          </svg>
        </div>
      </div>
      <p className="ptl-hint">
        {editable
          ? "Point at a card to see its links. Drag cards and boxes (a box carries its cards); resize a box from its corner. Click a line to remove it; dashed lines are suggestions — Shift-click one to keep it."
          : "Point at a card to see its links, click it to open."}
      </p>
      {reading && <DocViewer base={`/api/projects/${slug}/files`} name={reading} onClose={() => setReading(null)} />}
    </div>
  );
}
