import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Me } from "./api.js";
import { CharacterAvatar } from "./avatars.js";
import { TaskCard } from "./TaskCard.js";
import { onWs } from "./ws.js";

/* ---------- data shapes ---------- */

interface TimeBlock {
  id: string;
  date: string;
  startMin: number;
  durationMin: number;
}

interface PlanTask {
  noteId: string;
  noteTitle: string;
  line: number;
  text: string;
  project: string | null;
  assignee: string | null;
  due: string | null;
  priority: number | null;
  estimateHours: number;
  atRisk: boolean;
  blockId: string | null;
  objectId: string | null;
  blocks: TimeBlock[];
  scheduledHours: number;
  remainingHours: number;
}

interface PlanData {
  team: { slug: string; name: string; color: string };
  source: "heuristic" | "ai";
  hoursPerDay: number;
  assignees: { assignee: string; totalHours: number; tasks: PlanTask[] }[];
}

interface CalEvent {
  id: string;
  title: string;
  date: string;
  startMin: number;
  durationMin: number;
  username: string;
  mine: boolean;
  /** Set on occurrences from a subscribed ICS feed (Google/uni/…): render-only. */
  source?: "ics";
  readonly?: boolean;
  feedLabel?: string;
  allDay?: boolean;
}

interface Member {
  id: string;
  username: string;
  avatar: string;
  displayName: string;
}

type Popup =
  | { kind: "block"; block: TimeBlock; task: PlanTask; anchor: { x: number; y: number } }
  | { kind: "event"; event: CalEvent; anchor: { x: number; y: number } }
  | { kind: "new-event"; date: string; startMin: number; anchor: { x: number; y: number } }
  | null;

/* ---------- time helpers ---------- */

const DAY_MS = 86_400_000;
const DAY_START = 0; // 00:00 — show the whole day; the grid scrolls and opens near "now"
const DAY_END = 24 * 60; // 24:00
const PX_PER_MIN = 52 / 60; // 52px per hour
const SNAP = 30;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(12, 0, 0, 0);
  return x;
};
const fmtMin = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fmtH = (min: number) => (min % 60 === 0 ? `${min / 60}h` : `${(min / 60).toFixed(1)}h`);
const snapMin = (min: number) => Math.round(min / SNAP) * SNAP;
const clampStart = (min: number) => Math.max(DAY_START, Math.min(snapMin(min), DAY_END - SNAP));

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
  const [teamSlug, setTeamSlug] = useState<string | null>(me.teams[0]?.slug ?? null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [mode, setMode] = useState<"week" | "month">("week");
  const [people, setPeople] = useState<Set<string>>(new Set([me.username]));
  const [popup, setPopup] = useState<Popup>(null);
  const [nowTick, setNowTick] = useState(Date.now());

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  );

  const load = useCallback(async () => {
    if (teamSlug) setPlan(await api<PlanData>("GET", `/api/plan/${teamSlug}`));
    const from = iso(new Date(weekStart.getTime() - 7 * DAY_MS));
    const to = iso(new Date(weekStart.getTime() + 42 * DAY_MS));
    setEvents(await api<CalEvent[]>("GET", `/api/events?from=${from}&to=${to}`));
  }, [teamSlug, weekStart]);

  useEffect(() => {
    void load();
    api<Member[]>("GET", "/api/members").then(setMembers);
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

  const allTasks = useMemo(() => plan?.assignees.flatMap((a) => a.tasks) ?? [], [plan]);
  const backlog = useMemo(
    () => allTasks.filter((t) => t.assignee === me.username && t.remainingHours > 0),
    [allTasks, me.username],
  );
  /**
   * A 47-item backlog is a wall, not a plan. Default to what is actually
   * actionable — overdue, due within a fortnight, or already in progress — and
   * keep the rest one click away.
   */
  const [backlogAll, setBacklogAll] = useState(false);
  const soon = useMemo(() => {
    const horizon = new Date();
    horizon.setDate(horizon.getDate() + 14);
    const cut = iso(horizon);
    return backlog.filter((t) => (t.due && t.due <= cut) || t.atRisk);
  }, [backlog]);
  const shownBacklog = backlogAll ? backlog : (soon.length > 0 ? soon : backlog).slice(0, 8);
  const memberFor = (u: string) => members.find((m) => m.username === u);
  const teamUsernames = useMemo(() => {
    const set = new Set(allTasks.map((t) => t.assignee).filter((a): a is string => !!a));
    for (const e of events) set.add(e.username);
    set.add(me.username);
    return [...set].sort((a, b) => (a === me.username ? -1 : b === me.username ? 1 : a.localeCompare(b)));
  }, [allTasks, events, me.username]);
  const selected = teamUsernames.filter((u) => people.has(u));

  const togglePerson = (u: string) => {
    const next = new Set(people);
    if (next.has(u)) next.delete(u);
    else next.add(u);
    if (next.size === 0) next.add(me.username);
    setPeople(next);
  };

  return (
    <div className="planning">
      <header className="view-head plan-head">
        <div className="week-nav">
          <button className="ghost" onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * DAY_MS))} aria-label="Previous week">
            ‹
          </button>
          <button className="ghost week-today" onClick={() => setWeekStart(mondayOf(new Date()))}>
            {mode === "week"
              ? `${days[0]!.toLocaleDateString(undefined, { day: "numeric", month: "short" })} – ${days[6]!.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
              : weekStart.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </button>
          <button className="ghost" onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * DAY_MS))} aria-label="Next week">
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

        {plan && (
          <span className="plan-source" title={`Estimates are a budget; calendar blocks spend it.`}>
            {plan.source === "ai" ? "AI estimates" : "heuristic estimates"}
          </span>
        )}
      </header>

      <div className="plan-body">
        <aside className="backlog" aria-label="Unplanned tasks">
          <h3>
            Backlog <span className="ft-count">{shownBacklog.length}</span>
            {backlog.length > shownBacklog.length && (
              <button className="backlog-toggle" onClick={() => setBacklogAll(true)}>
                show all {backlog.length}
              </button>
            )}
            {backlogAll && backlog.length > 8 && (
              <button className="backlog-toggle" onClick={() => setBacklogAll(false)}>
                show less
              </button>
            )}
          </h3>
          <p className="backlog-hint">
            {backlogAll ? "Everything unplanned." : "Due in the next two weeks or at risk."} Drag onto the grid — books 2h, the rest stays here.
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
              <span className="cal-task-est">
                {t.remainingHours}h{t.scheduledHours > 0 ? ` of ${t.estimateHours}h` : ""}
              </span>
              <span className="cal-task-text">{t.text}</span>
              {t.due && <span className={`cal-task-due ${t.due < iso(new Date()) ? "overdue" : ""}`}>due {t.due.slice(5)}</span>}
            </div>
          ))}
          {shownBacklog.length === 0 && <p className="empty">Nothing due soon — the calendar is ahead of you.</p>}
        </aside>

        {mode === "week" ? (
          <WeekGrid
            me={me}
            days={days}
            selected={selected}
            memberFor={memberFor}
            tasks={allTasks}
            events={events}
            nowTick={nowTick}
            onReload={load}
            onPopup={setPopup}
          />
        ) : (
          <MonthGrid
            anchor={weekStart}
            tasks={allTasks.filter((t) => t.assignee && people.has(t.assignee))}
            events={events.filter((e) => people.has(e.username))}
            onPickWeek={(d) => {
              setWeekStart(mondayOf(d));
              setMode("week");
            }}
          />
        )}
      </div>

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
  me,
  days,
  selected,
  memberFor,
  tasks,
  events,
  nowTick,
  onReload,
  onPopup,
}: {
  me: Me;
  days: Date[];
  selected: string[];
  memberFor: (u: string) => Member | undefined;
  tasks: PlanTask[];
  events: CalEvent[];
  nowTick: number;
  onReload: () => Promise<void>;
  onPopup: (p: Popup) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Full 24h grid: open scrolled to ~1h before now so you land in the working day, not midnight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const n = new Date().getHours() * 60 + new Date().getMinutes();
    el.scrollTop = Math.max(0, (n - 60) * PX_PER_MIN);
  }, []);
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

  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = DAY_START; m <= DAY_END; m += 60) out.push(m);
    return out;
  }, []);
  const gridHeight = (DAY_END - DAY_START) * PX_PER_MIN;
  const today = iso(new Date(nowTick));
  const nowMin = new Date(nowTick).getHours() * 60 + new Date(nowTick).getMinutes();

  /** Day + minute under a pointer/drop position. */
  const locate = (clientX: number, clientY: number): { date: string; min: number } | null => {
    const body = bodyRef.current;
    if (!body) return null;
    const rect = body.getBoundingClientRect();
    const dayWidth = rect.width / 7;
    const dayIdx = Math.max(0, Math.min(6, Math.floor((clientX - rect.left) / dayWidth)));
    const min = DAY_START + (clientY - rect.top + body.scrollTop - (body.scrollTop ? 0 : 0)) / PX_PER_MIN;
    return { date: iso(days[dayIdx]!), min };
  };

  // Pointer-driven move/resize for my items. Click without movement opens the popup.
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
        const duration = Math.max(SNAP, snapMin(loc.min - d.startMin));
        if (duration !== d.durationMin) setDrag({ ...d, durationMin: Math.min(duration, DAY_END - d.startMin), moved: true });
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
  }, [days]);

  // An item's *effective* day honors an in-flight drag: while dragging, the
  // stored date hasn't changed yet (that waits on the drop PATCH), so bucket by
  // the live drag date instead — otherwise crossing a day boundary drops the
  // item out of its old column before the new one has claimed it, and it blinks
  // out mid-drag.
  const effectiveDate = (itemKind: "block" | "event", id: string, stored: string) =>
    drag && drag.itemKind === itemKind && drag.id === id ? drag.date : stored;

  const laneItems = (u: string, date: string) => {
    const blocks: { block: TimeBlock; task: PlanTask }[] = [];
    for (const t of tasks) {
      if (t.assignee !== u) continue;
      for (const b of t.blocks) if (effectiveDate("block", b.id, b.date) === date) blocks.push({ block: b, task: t });
    }
    const evs = events.filter((e) => e.username === u && !e.allDay && effectiveDate("event", e.id, e.date) === date);
    const allDay = events.filter((e) => e.username === u && e.date === date && e.allDay);
    return { blocks, evs, allDay };
  };

  /** Live geometry for an item, honoring an in-flight drag. */
  const geo = (id: string, itemKind: "block" | "event", date: string, startMin: number, durationMin: number) => {
    const d = dragRef.current;
    const active = d && d.id === id && d.itemKind === itemKind;
    const s = active ? d.startMin : startMin;
    const dur = active ? d.durationMin : durationMin;
    const dt = active ? d.date : date;
    return { top: (s - DAY_START) * PX_PER_MIN, height: dur * PX_PER_MIN, startMin: s, durationMin: dur, date: dt, dragging: !!active };
  };

  return (
    <div className="cal-grid" role="grid" aria-label="Week calendar">
      <div className="cal-grid-head">
        <span className="cal-gutter-spacer" />
        {days.map((d) => {
          const day = iso(d);
          return (
            <div key={day} className={`cal-col-head ${day === today ? "today" : ""}`}>
              <span className="cal-day-name">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="cal-day-num">{d.getDate()}</span>
              {selected.length > 1 && (
                <span className="cal-head-lanes">
                  {selected.map((u) => {
                    const m = memberFor(u);
                    return (
                      <span key={u} className="cal-head-owner" title={u}>
                        {m ? <CharacterAvatar id={m.avatar} size={14} /> : u[0]}
                      </span>
                    );
                  })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="cal-grid-scroll" ref={scrollRef}>
        <div className="cal-gutter" style={{ height: gridHeight }}>
          {hours.map((m) => (
            <span key={m} className="cal-hour-label" style={{ top: (m - DAY_START) * PX_PER_MIN }}>
              {fmtMin(m)}
            </span>
          ))}
        </div>

        <div className="cal-grid-body" ref={bodyRef} style={{ height: gridHeight }}>
          {hours.map((m) => (
            <span key={m} className="cal-hour-line" style={{ top: (m - DAY_START) * PX_PER_MIN }} />
          ))}

          {days.map((d) => {
            const day = iso(d);
            return (
              <div
                key={day}
                className={`cal-col ${day === today ? "today" : ""}`}
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
                {selected.map((u) => {
                  const mine = u === me.username;
                  const { blocks, evs, allDay } = laneItems(u, day);
                  return (
                    <div
                      key={u}
                      className={`cal-lane ${mine ? "mine" : ""}`}
                      onDoubleClick={(e) => {
                        if (!mine) return;
                        const loc = locate(e.clientX, e.clientY);
                        if (loc) onPopup({ kind: "new-event", date: day, startMin: clampStart(loc.min), anchor: { x: e.clientX, y: e.clientY } });
                      }}
                    >
                      {mine && <span className="cal-lane-hint">double-click for event</span>}
                      {allDay.map((ev, i) => (
                        <span key={ev.id} className="cal-allday" style={{ top: 2 + i * 18 }} title={`${ev.title}${ev.feedLabel ? ` — ${ev.feedLabel}` : ""}`}>
                          {ev.title}
                        </span>
                      ))}
                      {blocks.map(({ block, task }) => {
                        const g = geo(block.id, "block", block.date, block.startMin, block.durationMin);
                        if (g.date !== day) return null;
                        return (
                          <div
                            key={block.id}
                            className={`cal-item task ${task.due && day > task.due ? "risk" : ""} ${mine ? "" : "readonly"} ${g.dragging ? "dragging" : ""}`}
                            style={{ top: g.top, height: g.height }}
                            onPointerDown={(e) => {
                              if (!mine || (e.target as HTMLElement).closest(".cal-resize")) return;
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
                            {mine && (
                              <span
                                className="cal-resize"
                                onPointerDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDrag({ kind: "resize", itemKind: "block", id: block.id, date: block.date, startMin: block.startMin, durationMin: block.durationMin, moved: false });
                                }}
                              />
                            )}
                          </div>
                        );
                      })}
                      {evs.map((ev) => {
                        const g = geo(ev.id, "event", ev.date, ev.startMin, ev.durationMin);
                        if (g.date !== day) return null;
                        return (
                          <div
                            key={ev.id}
                            className={`cal-item event ${ev.source === "ics" ? "ics" : ""} ${ev.mine && !ev.readonly ? "" : "readonly"} ${g.dragging ? "dragging" : ""}`}
                            style={{ top: g.top, height: g.height }}
                            onPointerDown={(e) => {
                              if (!ev.mine || ev.readonly || (e.target as HTMLElement).closest(".cal-resize")) return;
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
                            {ev.mine && !ev.readonly && (
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
                    </div>
                  );
                })}
                {day === today && nowMin >= DAY_START && nowMin <= DAY_END && (
                  <span className="cal-now" style={{ top: (nowMin - DAY_START) * PX_PER_MIN }} />
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
              {popup.event.source === "ics" ? `${popup.event.feedLabel} (subscribed calendar)` : popup.event.username}
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
  onPickWeek,
}: {
  anchor: Date;
  tasks: PlanTask[];
  events: CalEvent[];
  onPickWeek: (d: Date) => void;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
  const start = mondayOf(first);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * DAY_MS));
  const today = iso(new Date());
  const blockMin = new Map<string, number>();
  for (const t of tasks) for (const b of t.blocks) blockMin.set(b.date, (blockMin.get(b.date) ?? 0) + b.durationMin);
  for (const e of events) {
    if (e.allDay) continue; // an all-day chip isn't 24h of load
    blockMin.set(e.date, (blockMin.get(e.date) ?? 0) + e.durationMin);
  }

  return (
    <div className="cal-month">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
        <span key={d} className="cal-month-dow">
          {d}
        </span>
      ))}
      {cells.map((d) => {
        const day = iso(d);
        const min = blockMin.get(day) ?? 0;
        return (
          <button
            key={day}
            className={`cal-month-day ${day === today ? "today" : ""} ${d.getMonth() !== anchor.getMonth() ? "dim" : ""}`}
            onClick={() => onPickWeek(d)}
          >
            <span className="cal-month-num">{d.getDate()}</span>
            {min > 0 && (
              <span className="cal-month-load">
                <span className="cal-month-bar" style={{ width: `${Math.min(min / 480, 1) * 100}%` }} />
                {fmtH(min)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
