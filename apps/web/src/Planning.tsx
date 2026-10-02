import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mondayOf, shiftMonth } from "./calendarMath.js";
import { api, isAbort, latestOnly, type Me } from "./api.js";
import { IconWand } from "./icons.js";
import { TaskCard } from "./TaskCard.js";
import { onWs } from "./ws.js";
import type { CalEvent, DayMarker, PlanData, PlanTask, TimeBlock } from "@basalt/schema/responses";

/* ---------- data shapes ---------- */

/** One block the auto-scheduler suggests. Nothing is written until "Book". */
interface Proposal {
  noteId: string;
  line: number;
  blockId: string | null;
  text: string;
  project: string | null;
  due: string | null;
  atRisk: boolean;
  date: string;
  startMin: number;
  durationMin: number;
  estimateHours: number;
}

type Popup =
  | { kind: "block"; block: TimeBlock; task: PlanTask; anchor: { x: number; y: number } }
  | { kind: "event"; event: CalEvent; anchor: { x: number; y: number } }
  | { kind: "new-event"; date: string; startMin: number; anchor: { x: number; y: number } }
  | null;

/* ---------- time helpers ---------- */

const DAY_MS = 86_400_000;
/**
 * The grid's default window. A full 24h of hairlines is mostly a picture of
 * when nothing happens — two thirds of it is asleep — so the day opens on the
 * hours that get used and *widens itself* around anything outside them (see
 * `windowFor`). "Full day" forces the whole 24h back.
 */
const DEFAULT_START = 7 * 60;
const DEFAULT_END = 23 * 60;
const PX_PER_MIN = 52 / 60; // 52px per hour
const SNAP = 30;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fmtMin = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fmtH = (min: number) => (min % 60 === 0 ? `${min / 60}h` : `${(min / 60).toFixed(1)}h`);
const hoursLabel = (h: number) => (Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`);
/** Same formatting as the Dashboard agenda: the currency's own decimals, and a
 *  charge signed "−€13.99" so a bare minus never reads as a typo. */
const money = (amount: number, currency: string | null) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: currency || "EUR",
    signDisplay: amount < 0 ? "always" : "auto",
  }).format(amount);

/** The visible hour window: the default, widened to hold anything that falls outside it. */
function windowFor(fullDay: boolean, spans: { startMin: number; durationMin: number }[]) {
  if (fullDay) return [0, 24 * 60] as const;
  let lo = DEFAULT_START;
  let hi = DEFAULT_END;
  for (const s of spans) {
    lo = Math.min(lo, Math.floor(s.startMin / 60) * 60);
    hi = Math.max(hi, Math.ceil((s.startMin + s.durationMin) / 60) * 60);
  }
  return [Math.max(0, lo), Math.min(24 * 60, hi)] as const;
}

/* ---------- component ---------- */

export function Planning({
  me,
  onOpenNote,
  onOpenProject,
}: {
  me: Me;
  onOpenNote: (id: string) => void;
  onOpenProject?: (slug: string) => void;
}) {
  const [card, setCard] = useState<PlanTask | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  // Flip weeks quickly and an older week's events must not land last.
  const [nextLoad] = useState(latestOnly);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [markers, setMarkers] = useState<DayMarker[]>([]);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [mode, setMode] = useState<"week" | "month">("week");
  const [popup, setPopup] = useState<Popup>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [fullDay, setFullDay] = useState(() => localStorage.getItem("basalt-plan-fullday") === "1");
  const [filter, setFilter] = useState<"soon" | "risk" | "all">("soon");
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const [booking, setBooking] = useState(false);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  );
  const today = iso(new Date(nowTick));

  /** Both grids at once: the week on screen, plus the six-week month block it sits in. */
  const range = useMemo(() => {
    const monthStart = mondayOf(new Date(weekStart.getFullYear(), weekStart.getMonth(), 1, 12));
    const from = new Date(Math.min(weekStart.getTime() - 7 * DAY_MS, monthStart.getTime()));
    const to = new Date(Math.max(weekStart.getTime() + 21 * DAY_MS, monthStart.getTime() + 41 * DAY_MS));
    return { from: iso(from), to: iso(to) };
  }, [weekStart]);

  const load = useCallback(async () => {
    const signal = nextLoad();
    try {
      const [p, e, m] = await Promise.all([
        api<PlanData>("GET", "/api/plan", undefined, { signal }),
        api<CalEvent[]>("GET", `/api/events?from=${range.from}&to=${range.to}`, undefined, { signal }),
        api<DayMarker[]>("GET", `/api/calendar/markers?from=${range.from}&to=${range.to}`, undefined, { signal }),
      ]);
      setPlan(p);
      setEvents(e);
      setMarkers(m);
    } catch (err) {
      if (!isAbort(err)) throw err;
    }
  }, [range, nextLoad]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 500);
    });
    const tick = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => {
      off();
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [load]);

  const allTasks = useMemo(
    // The server decides whose a task is (forYou): assigned to you, or to
    // nobody in a note you can edit. Filtering on the @name here hid every
    // task without one.
    () => (plan?.assignees ?? []).flatMap((a) => a.tasks).filter((t) => t.forYou),
    [plan],
  );
  const backlog = useMemo(() => allTasks.filter((t) => t.remainingHours > 0), [allTasks]);

  /**
   * A 43-item backlog is a wall, not a plan. The default is what is actually
   * actionable — already late or landing inside a fortnight — and the other two
   * cuts are one click away rather than hidden behind a "show all".
   */
  const soon = useMemo(() => {
    const horizon = new Date(nowTick);
    horizon.setDate(horizon.getDate() + 14);
    const cut = iso(horizon);
    return backlog.filter((t) => t.due && t.due <= cut);
  }, [backlog, nowTick]);
  const atRisk = useMemo(() => backlog.filter((t) => t.atRisk), [backlog]);
  const shownBacklog = filter === "all" ? backlog : filter === "risk" ? atRisk : soon;

  /* The week in numbers — the strip under the title, so the tab says something
     even on a week you have not touched yet. */
  const stats = useMemo(() => {
    const weekDays = days.map(iso);
    const inWeek = (d: string) => d >= weekDays[0]! && d <= weekDays[6]!;
    const bookedMin = allTasks.flatMap((t) => t.blocks).reduce((s, b) => (inWeek(b.date) ? s + b.durationMin : s), 0);
    const meetingMin = events.reduce((s, e) => (inWeek(e.date) && !e.allDay ? s + e.durationMin : s), 0);
    const capacity = (plan?.hoursPerDay ?? 6) * 5 * 60; // five working days
    return {
      bookedMin,
      meetingMin,
      capacity,
      unplanned: Math.round(backlog.reduce((s, t) => s + t.remainingHours, 0) * 10) / 10,
      due: markers.filter((m) => m.kind === "due" && inWeek(m.date)).length,
      atRisk: atRisk.length,
      overdue: backlog.filter((t) => t.due && t.due < today).length,
    };
  }, [allTasks, events, days, plan, backlog, markers, atRisk, today]);

  const openMarker = (m: DayMarker) => {
    const task = m.line !== null && allTasks.find((t) => t.noteId === m.noteId && t.line === m.line);
    if (task) setCard(task);
    else if (m.noteId) onOpenNote(m.noteId);
  };

  const autoPlan = async () => {
    setPlanning(true);
    try {
      const res = await api<{ proposals: Proposal[]; unplaced: number }>("POST", "/api/plan/auto", {
        from: iso(days[0]!),
        to: iso(days[6]!),
      });
      setProposals(res.proposals);
      if (res.proposals.length > 0) setMode("week");
    } finally {
      setPlanning(false);
    }
  };

  /** Booking goes through the ordinary block endpoint — one path promotes the
   *  checkbox and writes the block, whoever asked for it. */
  const bookProposals = async () => {
    if (!proposals) return;
    setBooking(true);
    try {
      for (const p of proposals) {
        await api("POST", "/api/tasks/blocks", {
          noteId: p.noteId,
          line: p.line,
          blockId: p.blockId ?? undefined,
          date: p.date,
          startMin: p.startMin,
          durationMin: p.durationMin,
          estimateHours: p.estimateHours,
        });
      }
      setProposals(null);
      await load();
    } finally {
      setBooking(false);
    }
  };

  const proposalHours = proposals ? proposals.reduce((s, p) => s + p.durationMin, 0) / 60 : 0;

  return (
    <div className="planning">
      <header className="plan-top">
        <div className="plan-title">
          <h1 className="plan-h1">Planning</h1>
          <p className="plan-sub">Your week, against everything the vault has dated.</p>
        </div>
        <div className="plan-top-right">
          <div className="week-nav">
            <button
              className="ghost"
              onClick={() => setWeekStart(mode === "week" ? new Date(weekStart.getTime() - 7 * DAY_MS) : shiftMonth(weekStart, -1))}
              aria-label={mode === "week" ? "Previous week" : "Previous month"}
            >
              ‹
            </button>
            <button className="ghost week-today" onClick={() => setWeekStart(mondayOf(new Date()))}>
              {mode === "week"
                ? `${days[0]!.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${days[6]!.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
                : weekStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </button>
            <button
              className="ghost"
              onClick={() => setWeekStart(mode === "week" ? new Date(weekStart.getTime() + 7 * DAY_MS) : shiftMonth(weekStart, +1))}
              aria-label={mode === "week" ? "Next week" : "Next month"}
            >
              ›
            </button>
          </div>
          <div className="scope-tabs">
            <button className={`scope-tab ${mode === "week" ? "active" : ""}`} onClick={() => setMode("week")}>
              Week
            </button>
            <button className={`scope-tab ${mode === "month" ? "active" : ""}`} onClick={() => setMode("month")}>
              Month
            </button>
          </div>
        </div>
      </header>

      <div className="plan-strip" role="group" aria-label="This week in numbers">
        <div className="plan-tile">
          <span className="plan-tile-lbl">Booked</span>
          <span className="plan-tile-val">
            {fmtH(stats.bookedMin)}
            <em>of {fmtH(stats.capacity)}</em>
          </span>
          <span className="plan-tile-bar">
            <span style={{ width: `${Math.min(stats.bookedMin / stats.capacity, 1) * 100}%` }} />
          </span>
        </div>
        <div className="plan-tile">
          <span className="plan-tile-lbl">Meetings</span>
          <span className="plan-tile-val">{fmtH(stats.meetingMin)}</span>
          <span className="plan-tile-note">events and subscribed calendars</span>
        </div>
        <div className="plan-tile">
          <span className="plan-tile-lbl">Unplanned</span>
          <span className="plan-tile-val">{hoursLabel(stats.unplanned)}</span>
          <span className="plan-tile-note">{backlog.length} open steps, estimated</span>
        </div>
        <div className="plan-tile">
          <span className="plan-tile-lbl">Due this week</span>
          <span className="plan-tile-val">{stats.due}</span>
          <span className="plan-tile-note">deadlines on the grid</span>
        </div>
        <div className={`plan-tile ${stats.overdue > 0 ? "bad" : ""}`}>
          <span className="plan-tile-lbl">Late</span>
          <span className="plan-tile-val">{stats.overdue}</span>
          <span className="plan-tile-note">{stats.atRisk} more will be, at this pace</span>
        </div>
      </div>

      <div className="plan-body">
        <aside className="backlog" aria-label="Unplanned tasks">
          <div className="backlog-head">
            <h3>Backlog</h3>
            <div className="backlog-filters">
              {(
                [
                  ["soon", "Soon", soon.length],
                  ["risk", "At risk", atRisk.length],
                  ["all", "All", backlog.length],
                ] as const
              ).map(([key, label, n]) => (
                <button
                  key={key}
                  className={`backlog-filter ${filter === key ? "on" : ""}`}
                  onClick={() => setFilter(key)}
                  aria-pressed={filter === key}
                >
                  {label} <span>{n}</span>
                </button>
              ))}
            </div>
          </div>

          {proposals ? (
            <div className="plan-proposal" role="status">
              <p className="plan-proposal-line">
                <strong>
                  {proposals.length} block{proposals.length === 1 ? "" : "s"}
                </strong>{" "}
                · {hoursLabel(Math.round(proposalHours * 10) / 10)} suggested
              </p>
              <p className="plan-proposal-hint">
                {proposals.length > 0
                  ? "Shown dashed on the grid. Click one to drop it."
                  : "No room left this week — nothing to book."}
              </p>
              <div className="plan-proposal-actions">
                <button className="primary" disabled={booking || proposals.length === 0} onClick={bookProposals}>
                  {booking ? "Booking…" : "Book them"}
                </button>
                <button className="ghost" onClick={() => setProposals(null)}>
                  Discard
                </button>
              </div>
            </div>
          ) : (
            <button className="plan-auto" onClick={autoPlan} disabled={planning || backlog.length === 0}>
              <IconWand />
              {planning ? "Working…" : "Plan my week"}
            </button>
          )}

          <p className="backlog-hint">
            {filter === "all"
              ? "Everything still unplanned."
              : filter === "risk"
                ? "On the current queue, these finish after their deadline."
                : "Late, or landing inside a fortnight."}{" "}
            Drag one onto a day to book it.
          </p>

          {shownBacklog.map((t) => (
            <div
              key={`${t.noteId}:${t.line}`}
              className={`cal-task ${t.atRisk ? "risk" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => setCard(t)}
              onKeyDown={(e) => e.key === "Enter" && setCard(t)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  "text/task",
                  JSON.stringify({ noteId: t.noteId, line: t.line, blockId: t.blockId, estimateHours: t.estimateHours }),
                );
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <span className="cal-task-text">{t.text}</span>
              <span className="cal-task-meta">
                <span className="cal-task-est">
                  {hoursLabel(t.remainingHours)}
                  {t.scheduledHours > 0 ? ` left of ${hoursLabel(t.estimateHours)}` : ""}
                </span>
                {t.project && <span className="cal-task-project">{t.project}</span>}
                {t.due && <span className={`cal-task-due ${t.due < today ? "overdue" : ""}`}>{t.due.slice(5)}</span>}
              </span>
            </div>
          ))}
          {shownBacklog.length === 0 && (
            <p className="empty">
              {filter === "soon" ? "Nothing due soon — the calendar is ahead of you." : "Nothing here."}
            </p>
          )}
        </aside>

        {mode === "week" ? (
          <WeekGrid
            days={days}
            tasks={allTasks}
            events={events}
            markers={markers}
            proposals={proposals ?? []}
            nowTick={nowTick}
            fullDay={fullDay}
            hoursPerDay={plan?.hoursPerDay ?? 6}
            onFullDay={(v) => {
              setFullDay(v);
              localStorage.setItem("basalt-plan-fullday", v ? "1" : "0");
            }}
            onDropProposal={(p) => setProposals((cur) => (cur ? cur.filter((x) => x !== p) : cur))}
            onReload={load}
            onPopup={setPopup}
            onOpenMarker={openMarker}
          />
        ) : (
          <MonthGrid
            anchor={weekStart}
            tasks={allTasks}
            events={events}
            markers={markers}
            hoursPerDay={plan?.hoursPerDay ?? 6}
            onPickWeek={(d) => {
              setWeekStart(mondayOf(d));
              setMode("week");
            }}
            onOpenMarker={openMarker}
          />
        )}
      </div>

      {plan && (
        <p className="plan-foot">
          Estimates are {plan.source === "ai" ? "refined by AI" : "heuristic"} — a budget the calendar spends. Days hold{" "}
          {plan.hoursPerDay}h of focused work.
        </p>
      )}

      {popup && <CalPopup popup={popup} onClose={() => setPopup(null)} onReload={load} onOpenNote={onOpenNote} />}
      {card && (
        <TaskCard
          task={card}
          onClose={() => setCard(null)}
          onOpenNote={onOpenNote}
          onOpenProject={onOpenProject}
          onScheduled={load}
        />
      )}
    </div>
  );
}

/* ---------- week grid ---------- */

function WeekGrid({
  days,
  tasks,
  events,
  markers,
  proposals,
  nowTick,
  fullDay,
  hoursPerDay,
  onFullDay,
  onDropProposal,
  onReload,
  onPopup,
  onOpenMarker,
}: {
  days: Date[];
  tasks: PlanTask[];
  events: CalEvent[];
  markers: DayMarker[];
  proposals: Proposal[];
  nowTick: number;
  fullDay: boolean;
  hoursPerDay: number;
  onFullDay: (v: boolean) => void;
  onDropProposal: (p: Proposal) => void;
  onReload: () => Promise<void>;
  onPopup: (p: Popup) => void;
  onOpenMarker: (m: DayMarker) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [marksOpen, setMarksOpen] = useState(false);
  const [drag, setDrag] = useState<{
    kind: "move" | "resize";
    itemKind: "block" | "event";
    id: string;
    date: string;
    startMin: number;
    durationMin: number;
    moved: boolean;
  } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const dayKeys = useMemo(() => days.map(iso), [days]);
  const inWeek = useCallback((d: string) => d >= dayKeys[0]! && d <= dayKeys[6]!, [dayKeys]);

  const blocks = useMemo(() => {
    const out: { block: TimeBlock; task: PlanTask }[] = [];
    for (const t of tasks) for (const b of t.blocks) if (inWeek(b.date)) out.push({ block: b, task: t });
    return out;
  }, [tasks, inWeek]);
  const timed = useMemo(() => events.filter((e) => !e.allDay && inWeek(e.date)), [events, inWeek]);

  // The window follows the content: a 06:30 block or a 23:40 lecture widens the
  // grid rather than falling off the bottom of it.
  const [dayStart, dayEnd] = useMemo(
    () => windowFor(fullDay, [...blocks.map((b) => b.block), ...timed, ...proposals]),
    [fullDay, blocks, timed, proposals],
  );
  const gridHeight = (dayEnd - dayStart) * PX_PER_MIN;
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = dayStart; m <= dayEnd; m += 60) out.push(m);
    return out;
  }, [dayStart, dayEnd]);

  const today = iso(new Date(nowTick));
  const nowMin = new Date(nowTick).getHours() * 60 + new Date(nowTick).getMinutes();

  // Open scrolled to ~an hour before now, so you land in the working day.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, (nowMin - 60 - dayStart) * PX_PER_MIN);
    // Only on mount and when the window itself changes — not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayStart, dayEnd]);

  /** Day + minute under a pointer/drop position. */
  const locate = (clientX: number, clientY: number): { date: string; min: number } | null => {
    const body = bodyRef.current;
    if (!body) return null;
    const rect = body.getBoundingClientRect();
    const dayWidth = rect.width / 7;
    const dayIdx = Math.max(0, Math.min(6, Math.floor((clientX - rect.left) / dayWidth)));
    return { date: dayKeys[dayIdx]!, min: dayStart + (clientY - rect.top) / PX_PER_MIN };
  };
  const clampStart = (min: number) => Math.max(0, Math.min(Math.round(min / SNAP) * SNAP, 24 * 60 - SNAP));

  // Pointer-driven move/resize. A click without movement opens the popup instead.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const loc = locate(e.clientX, e.clientY);
      if (!loc) return;
      if (d.kind === "move") {
        const startMin = clampStart(loc.min - d.durationMin / 2);
        if (loc.date !== d.date || Math.abs(startMin - d.startMin) >= SNAP) {
          setDrag({ ...d, date: loc.date, startMin, moved: true });
        }
      } else {
        const duration = Math.max(SNAP, Math.round((loc.min - d.startMin) / SNAP) * SNAP);
        if (duration !== d.durationMin) setDrag({ ...d, durationMin: Math.min(duration, 24 * 60 - d.startMin), moved: true });
      }
    };
    const onUp = async () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      if (!d.moved) return;
      const url = d.itemKind === "block" ? `/api/blocks/${d.id}` : `/api/events/${d.id}`;
      await api("PATCH", url, { date: d.date, startMin: d.startMin, durationMin: d.durationMin });
      await onReload();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKeys, dayStart]);

  // An item's *effective* day honors an in-flight drag: while dragging, the
  // stored date hasn't changed yet (that waits on the drop PATCH), so bucket by
  // the live drag date instead — otherwise crossing a day boundary drops the
  // item out of its old column before the new one has claimed it, and it blinks
  // out mid-drag.
  const effectiveDate = (itemKind: "block" | "event", id: string, stored: string) =>
    drag && drag.itemKind === itemKind && drag.id === id ? drag.date : stored;

  /** Live geometry for an item, honoring an in-flight drag. */
  const geo = (id: string, itemKind: "block" | "event", date: string, startMin: number, durationMin: number) => {
    const d = dragRef.current;
    const active = d && d.id === id && d.itemKind === itemKind;
    const s = active ? d.startMin : startMin;
    const dur = active ? d.durationMin : durationMin;
    return { top: (s - dayStart) * PX_PER_MIN, height: dur * PX_PER_MIN, startMin: s, durationMin: dur, date: active ? d.date : date, dragging: !!active };
  };

  /** Task hours booked on a day — the load bar under each column head. */
  const loadOf = (date: string) =>
    blocks.reduce((s, b) => (effectiveDate("block", b.block.id, b.block.date) === date ? s + b.block.durationMin : s), 0);

  const marksFor = (date: string) => ({
    allDay: events.filter((e) => e.allDay && e.date === date),
    // Key deadlines first: a crowded day shows two chips before "all".
    marks: markers.filter((m) => m.date === date).sort((a, b) => Number(b.key) - Number(a.key)),
  });
  const crowded = dayKeys.some((d) => {
    const { allDay, marks } = marksFor(d);
    return allDay.length + marks.length > 2;
  });

  return (
    <div className="cal-grid" role="grid" aria-label="Week calendar">
      <div className="cal-grid-head">
        <div className="cal-gutter-spacer">
          <button className="cal-window-toggle" onClick={() => onFullDay(!fullDay)} title="Show the whole 24 hours">
            {fullDay ? "24h" : `${dayStart / 60}–${dayEnd / 60}`}
          </button>
        </div>
        {days.map((d) => {
          const day = iso(d);
          const load = loadOf(day);
          return (
            <div key={day} className={`cal-col-head ${day === today ? "today" : ""}`}>
              <span className="cal-day-name">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="cal-day-num">{d.getDate()}</span>
              {load > 0 && <span className="cal-col-hours">{fmtH(load)}</span>}
              <span className={`cal-col-load ${load > hoursPerDay * 60 ? "over" : ""}`} aria-hidden>
                <span style={{ width: `${Math.min(load / (hoursPerDay * 60), 1) * 100}%` }} />
              </span>
            </div>
          );
        })}
      </div>

      {/* The dated band: deadlines, milestones, money and all-day events — none
          of which own an hour, and all of which used to be invisible here. */}
      <div className={`cal-marks ${marksOpen ? "open" : ""}`}>
        <div className="cal-marks-gutter">
          <span>dated</span>
          {crowded && (
            <button className="cal-marks-toggle" onClick={() => setMarksOpen(!marksOpen)}>
              {marksOpen ? "less" : "all"}
            </button>
          )}
        </div>
        {dayKeys.map((day) => {
          const { allDay, marks } = marksFor(day);
          const items = [
            ...allDay.map((e) => ({ key: e.id, cls: "ics", label: e.title, title: e.feedLabel ?? "All day", onClick: undefined })),
            ...marks.map((m) => ({
              key: m.id,
              cls:
                m.kind === "due"
                  ? `due ${m.overdue ? "overdue" : ""} ${m.key ? "key" : ""}`
                  : m.kind === "milestone"
                    ? "milestone"
                    : `money ${m.kind === "income" ? "in" : ""}`,
              label: m.amount !== null ? `${m.title} ${money(m.amount, m.currency)}` : m.title,
              title: m.source ?? m.title,
              onClick: () => onOpenMarker(m),
            })),
          ];
          const shown = marksOpen ? items : items.slice(0, 2);
          return (
            <div key={day} className={`cal-marks-cell ${day === today ? "today" : ""}`}>
              {shown.map((it) => (
                <button
                  key={it.key}
                  className={`cal-mark ${it.cls}`}
                  title={`${it.label} — ${it.title}`}
                  onClick={it.onClick}
                  disabled={!it.onClick}
                >
                  {it.label}
                </button>
              ))}
              {!marksOpen && items.length > shown.length && (
                <button className="cal-mark more" onClick={() => setMarksOpen(true)}>
                  +{items.length - shown.length}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="cal-grid-scroll" ref={scrollRef}>
        <div className="cal-gutter" style={{ height: gridHeight }}>
          {hours.map((m) => (
            <span key={m} className="cal-hour-label" style={{ top: (m - dayStart) * PX_PER_MIN }}>
              {fmtMin(m)}
            </span>
          ))}
        </div>

        <div className="cal-grid-body" ref={bodyRef} style={{ height: gridHeight }}>
          {hours.map((m) => (
            <span key={m} className="cal-hour-line" style={{ top: (m - dayStart) * PX_PER_MIN }} />
          ))}

          {/* A week with nothing in it is a legitimate state, not a loading one —
              say which, and say what to do about it. */}
          {blocks.length === 0 && timed.length === 0 && proposals.length === 0 && (
            <p className="cal-empty">
              Nothing booked this week. Drag a step across, double-click for an event, or let Basalt lay one out.
            </p>
          )}

          {days.map((d) => {
            const day = iso(d);
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div
                key={day}
                className={`cal-col ${day === today ? "today" : ""} ${weekend ? "weekend" : ""}`}
                onDoubleClick={(e) => {
                  const loc = locate(e.clientX, e.clientY);
                  if (loc) onPopup({ kind: "new-event", date: day, startMin: clampStart(loc.min), anchor: { x: e.clientX, y: e.clientY } });
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={async (e) => {
                  e.preventDefault();
                  const raw = e.dataTransfer.getData("text/task");
                  if (!raw) return;
                  const t = JSON.parse(raw) as { noteId: string; line: number; blockId: string | null; estimateHours: number };
                  const loc = locate(e.clientX, e.clientY);
                  if (!loc) return;
                  await api("POST", "/api/tasks/blocks", {
                    noteId: t.noteId,
                    line: t.line,
                    blockId: t.blockId ?? undefined,
                    date: day,
                    startMin: clampStart(loc.min),
                    estimateHours: t.estimateHours,
                  });
                  await onReload();
                }}
              >
                {proposals
                  .filter((p) => p.date === day)
                  .map((p, i) => (
                    <button
                      key={`${p.noteId}-${p.line}-${p.date}-${p.startMin}-${i}`}
                      className="cal-item ghost"
                      style={{ top: (p.startMin - dayStart) * PX_PER_MIN, height: p.durationMin * PX_PER_MIN }}
                      title="Suggested — click to drop it from the plan"
                      onClick={() => onDropProposal(p)}
                    >
                      <span className="cal-item-time">
                        {fmtMin(p.startMin)} · {fmtH(p.durationMin)}
                      </span>
                      <span className="cal-item-title">{p.text}</span>
                    </button>
                  ))}

                {blocks
                  .filter(({ block }) => effectiveDate("block", block.id, block.date) === day)
                  .map(({ block, task }) => {
                    const g = geo(block.id, "block", block.date, block.startMin, block.durationMin);
                    return (
                      <div
                        key={block.id}
                        className={`cal-item task ${task.due && day > task.due ? "risk" : ""} ${g.dragging ? "dragging" : ""}`}
                        style={{ top: g.top, height: g.height }}
                        onPointerDown={(e) => {
                          if ((e.target as HTMLElement).closest(".cal-resize")) return;
                          e.preventDefault();
                          setDrag({ kind: "move", itemKind: "block", id: block.id, date: block.date, startMin: block.startMin, durationMin: block.durationMin, moved: false });
                        }}
                        onClick={(e) => {
                          if (dragRef.current?.moved) return;
                          onPopup({ kind: "block", block, task, anchor: { x: e.clientX, y: e.clientY } });
                        }}
                      >
                        <span className="cal-item-time">
                          {fmtMin(g.startMin)} · {fmtH(g.durationMin)}
                        </span>
                        <span className="cal-item-title">{task.text}</span>
                        <span
                          className="cal-resize"
                          onPointerDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setDrag({ kind: "resize", itemKind: "block", id: block.id, date: block.date, startMin: block.startMin, durationMin: block.durationMin, moved: false });
                          }}
                        />
                      </div>
                    );
                  })}

                {timed
                  .filter((ev) => effectiveDate("event", ev.id, ev.date) === day)
                  .map((ev) => {
                    const g = geo(ev.id, "event", ev.date, ev.startMin, ev.durationMin);
                    const editable = ev.mine && !ev.readonly;
                    return (
                      <div
                        key={ev.id}
                        className={`cal-item event ${ev.source === "ics" ? "ics" : ""} ${editable ? "" : "readonly"} ${g.dragging ? "dragging" : ""}`}
                        style={{ top: g.top, height: g.height }}
                        onPointerDown={(e) => {
                          if (!editable || (e.target as HTMLElement).closest(".cal-resize")) return;
                          e.preventDefault();
                          setDrag({ kind: "move", itemKind: "event", id: ev.id, date: ev.date, startMin: ev.startMin, durationMin: ev.durationMin, moved: false });
                        }}
                        onClick={(e) => {
                          if (dragRef.current?.moved) return;
                          onPopup({ kind: "event", event: ev, anchor: { x: e.clientX, y: e.clientY } });
                        }}
                      >
                        <span className="cal-item-time">
                          {fmtMin(g.startMin)} · {fmtH(g.durationMin)}
                          {ev.feedLabel ? ` · ${ev.feedLabel}` : ""}
                        </span>
                        <span className="cal-item-title">{ev.title}</span>
                        {editable && (
                          <span
                            className="cal-resize"
                            onPointerDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setDrag({ kind: "resize", itemKind: "event", id: ev.id, date: ev.date, startMin: ev.startMin, durationMin: ev.durationMin, moved: false });
                            }}
                          />
                        )}
                      </div>
                    );
                  })}

                {day === today && nowMin >= dayStart && nowMin <= dayEnd && (
                  <span className="cal-now" style={{ top: (nowMin - dayStart) * PX_PER_MIN }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------- popup ---------- */

function CalPopup({
  popup,
  onClose,
  onReload,
  onOpenNote,
}: {
  popup: NonNullable<Popup>;
  onClose: () => void;
  onReload: () => Promise<void>;
  onOpenNote: (id: string) => void;
}) {
  const [title, setTitle] = useState(popup.kind === "event" ? popup.event.title : "");
  const [duration, setDuration] = useState(
    popup.kind === "block" ? popup.block.durationMin : popup.kind === "event" ? popup.event.durationMin : 60,
  );

  const style: React.CSSProperties = {
    left: Math.min(popup.anchor.x, window.innerWidth - 320),
    top: Math.min(popup.anchor.y, window.innerHeight - 300),
  };

  const patchDuration = async (next: number) => {
    const dur = Math.max(SNAP, next);
    setDuration(dur);
    if (popup.kind === "block") await api("PATCH", `/api/blocks/${popup.block.id}`, { durationMin: dur });
    if (popup.kind === "event") await api("PATCH", `/api/events/${popup.event.id}`, { durationMin: dur });
    await onReload();
  };

  return (
    <>
      <div className="cal-popup-backdrop" onClick={onClose} />
      <div className="cal-popup" style={style} role="dialog">
        {popup.kind === "block" && (
          <>
            <p className="cal-popup-title">{popup.task.text}</p>
            <p className="cal-popup-meta">
              {popup.task.project && <span>{popup.task.project} · </span>}
              <button className="ghost cal-popup-note" onClick={() => onOpenNote(popup.task.noteId)}>
                {popup.task.noteTitle} ↗
              </button>
            </p>
            <div className="cal-popup-budget">
              <span>estimate {popup.task.estimateHours}h</span>
              <span>booked {popup.task.scheduledHours}h</span>
              <span className={popup.task.remainingHours > 0 ? "" : "done"}>left {popup.task.remainingHours}h</span>
            </div>
            {popup.task.due && (
              <p className="cal-popup-meta">
                due {popup.task.due}
                {popup.block.date > popup.task.due && <span className="cal-popup-risk"> — this block lands after the deadline</span>}
              </p>
            )}
            <DurationStepper value={duration} onChange={patchDuration} />
            <div className="cal-popup-actions">
              <button
                className="ghost danger"
                onClick={async () => {
                  await api("DELETE", `/api/blocks/${popup.block.id}`);
                  await onReload();
                  onClose();
                }}
              >
                Remove from calendar
              </button>
            </div>
          </>
        )}

        {popup.kind === "event" && (
          <>
            {popup.event.mine && !popup.event.readonly ? (
              <input
                className="cal-popup-input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={async () => {
                  if (title.trim() && title !== popup.event.title) {
                    await api("PATCH", `/api/events/${popup.event.id}`, { title });
                    await onReload();
                  }
                }}
                aria-label="Event title"
              />
            ) : (
              <p className="cal-popup-title">{popup.event.title}</p>
            )}
            <p className="cal-popup-meta">
              {popup.event.date} · {fmtMin(popup.event.startMin)} ·{" "}
              {popup.event.source === "ics" ? `${popup.event.feedLabel} (subscribed calendar)` : "your calendar"}
            </p>
            {popup.event.mine && !popup.event.readonly && (
              <>
                <DurationStepper value={duration} onChange={patchDuration} />
                <div className="cal-popup-actions">
                  <button
                    className="ghost danger"
                    onClick={async () => {
                      await api("DELETE", `/api/events/${popup.event.id}`);
                      await onReload();
                      onClose();
                    }}
                  >
                    Delete event
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {popup.kind === "new-event" && (
          <>
            <p className="cal-popup-title">New event</p>
            <p className="cal-popup-meta">
              {popup.date} · {fmtMin(popup.startMin)}
            </p>
            <input
              className="cal-popup-input"
              placeholder="Meeting with…"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && title.trim()) {
                  await api("POST", "/api/events", { title, date: popup.date, startMin: popup.startMin, durationMin: duration });
                  await onReload();
                  onClose();
                }
              }}
              aria-label="Event title"
            />
            <DurationStepper value={duration} onChange={(v) => setDuration(Math.max(SNAP, v))} />
            <div className="cal-popup-actions">
              <button
                className="primary"
                disabled={!title.trim()}
                onClick={async () => {
                  await api("POST", "/api/events", { title, date: popup.date, startMin: popup.startMin, durationMin: duration });
                  await onReload();
                  onClose();
                }}
              >
                Add event
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function DurationStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="cal-stepper" aria-label="Duration">
      <button className="ghost" onClick={() => onChange(value - SNAP)} aria-label="Shorter">
        −
      </button>
      <span>{fmtH(value)}</span>
      <button className="ghost" onClick={() => onChange(value + SNAP)} aria-label="Longer">
        +
      </button>
    </div>
  );
}

/* ---------- month ---------- */

function MonthGrid({
  anchor,
  tasks,
  events,
  markers,
  hoursPerDay,
  onPickWeek,
  onOpenMarker,
}: {
  anchor: Date;
  tasks: PlanTask[];
  events: CalEvent[];
  markers: DayMarker[];
  hoursPerDay: number;
  onPickWeek: (d: Date) => void;
  onOpenMarker: (m: DayMarker) => void;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
  const start = mondayOf(first);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * DAY_MS));
  const today = iso(new Date());

  const load = new Map<string, number>();
  for (const t of tasks) for (const b of t.blocks) load.set(b.date, (load.get(b.date) ?? 0) + b.durationMin);
  for (const e of events) {
    if (e.allDay) continue; // an all-day chip isn't 24h of load
    load.set(e.date, (load.get(e.date) ?? 0) + e.durationMin);
  }

  /** Everything worth a line in a 90px cell, most consequential first. */
  const cellItems = (day: string) => [
    ...markers.filter((m) => m.date === day && m.kind === "due" && m.key).map((m) => ({ key: m.id, cls: `due key ${m.overdue ? "overdue" : ""}`, label: m.title, marker: m })),
    ...markers.filter((m) => m.date === day && m.kind === "milestone").map((m) => ({ key: m.id, cls: "milestone", label: m.title, marker: m })),
    ...markers.filter((m) => m.date === day && m.kind === "due" && !m.key).map((m) => ({ key: m.id, cls: `due ${m.overdue ? "overdue" : ""}`, label: m.title, marker: m })),
    ...events.filter((e) => e.date === day).map((e) => ({ key: e.id, cls: e.source === "ics" ? "ics" : "event", label: e.allDay ? e.title : `${fmtMin(e.startMin)} ${e.title}`, marker: null })),
    ...markers
      .filter((m) => m.date === day && (m.kind === "charge" || m.kind === "income"))
      .map((m) => ({ key: m.id, cls: `money ${m.kind === "income" ? "in" : ""}`, label: `${m.title} ${money(m.amount ?? 0, m.currency)}`, marker: m })),
  ];

  return (
    <div className="cal-month">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
        <span key={d} className="cal-month-dow">
          {d}
        </span>
      ))}
      {cells.map((d) => {
        const day = iso(d);
        const min = load.get(day) ?? 0;
        const items = cellItems(day);
        const shown = items.slice(0, 3);
        return (
          <div
            key={day}
            className={`cal-month-day ${day === today ? "today" : ""} ${d.getMonth() !== anchor.getMonth() ? "dim" : ""}`}
          >
            <button className="cal-month-num" onClick={() => onPickWeek(d)} title="Open this week">
              {d.getDate()}
            </button>
            {min > 0 && (
              <span className="cal-month-load" title={`${fmtH(min)} booked`}>
                <span className={`cal-month-bar ${min > hoursPerDay * 60 ? "over" : ""}`} style={{ width: `${Math.min(min / (hoursPerDay * 60), 1) * 100}%` }} />
              </span>
            )}
            {shown.map((it) => (
              <button
                key={it.key}
                className={`cal-mark ${it.cls}`}
                title={it.label}
                onClick={() => (it.marker ? onOpenMarker(it.marker) : onPickWeek(d))}
              >
                {it.label}
              </button>
            ))}
            {items.length > shown.length && (
              <button className="cal-mark more" onClick={() => onPickWeek(d)}>
                +{items.length - shown.length} more
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
