import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Me } from "./api.js";
import { CharacterAvatar } from "./avatars.js";
import { onWs } from "./ws.js";

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
  expectedFinish: string;
  atRisk: boolean;
  blockId: string | null;
  plannedDate: string | null;
}

interface PlanData {
  team: { slug: string; name: string; color: string };
  source: "heuristic" | "ai";
  hoursPerDay: number;
  assignees: { assignee: string; totalHours: number; tasks: PlanTask[] }[];
  atRisk: number;
  totalHours: number;
}

interface Member {
  id: string;
  username: string;
  avatar: string;
  displayName: string;
}

const DAY_MS = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const mondayOf = (d: Date) => {
  const x = new Date(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  x.setHours(12, 0, 0, 0);
  return x;
};

/**
 * Planning: your week as a calendar. Unplanned tasks wait in the backlog with
 * their estimates; drag them onto a day. Teammates' calendars render in
 * parallel columns (read-only) so the team's week is one picture.
 */
export function Planning({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [teamSlug, setTeamSlug] = useState<string | null>(me.teams[0]?.slug ?? null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [mode, setMode] = useState<"week" | "month">("week");
  const [people, setPeople] = useState<Set<string>>(new Set([me.username]));
  const [dragTask, setDragTask] = useState<PlanTask | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (teamSlug) setPlan(await api<PlanData>("GET", `/api/plan/${teamSlug}`));
  }, [teamSlug]);

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
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const allTasks = useMemo(() => plan?.assignees.flatMap((a) => a.tasks) ?? [], [plan]);
  const backlog = useMemo(
    () => allTasks.filter((t) => t.assignee === me.username && !t.plannedDate),
    [allTasks, me.username],
  );
  const memberFor = (username: string) => members.find((m) => m.username === username);
  const teamUsernames = useMemo(() => {
    const set = new Set(allTasks.map((t) => t.assignee).filter((a): a is string => !!a));
    set.add(me.username);
    return [...set].sort((a, b) => (a === me.username ? -1 : b === me.username ? 1 : a.localeCompare(b)));
  }, [allTasks, me.username]);

  const schedule = async (task: Pick<PlanTask, "noteId" | "line" | "blockId">, date: string | null) => {
    await api("POST", "/api/tasks/schedule", { noteId: task.noteId, line: task.line, blockId: task.blockId, date });
    await load();
  };

  /** Payload rides on the DataTransfer so drops work even before state commits. */
  const startDrag = (e: React.DragEvent, t: PlanTask) => {
    setDragTask(t);
    e.dataTransfer.setData("text/task", JSON.stringify({ noteId: t.noteId, line: t.line, blockId: t.blockId }));
    e.dataTransfer.effectAllowed = "move";
  };
  const taskFromDrop = (e: React.DragEvent): Pick<PlanTask, "noteId" | "line" | "blockId"> | null => {
    const raw = e.dataTransfer.getData("text/task");
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through */
      }
    }
    return dragTask;
  };

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => new Date(weekStart.getTime() + i * DAY_MS)),
    [weekStart],
  );
  const today = iso(new Date());
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
        <div className="scope-tabs" role="tablist" aria-label="Team">
          {me.teams.map((t) => (
            <button
              key={t.slug}
              role="tab"
              aria-selected={teamSlug === t.slug}
              className={`scope-tab ${teamSlug === t.slug ? "active" : ""}`}
              style={{ "--team": t.color } as React.CSSProperties}
              onClick={() => setTeamSlug(t.slug)}
            >
              <span className="scope-dot" />
              {t.name}
            </button>
          ))}
        </div>

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

        <div className="people-picker" aria-label="Show calendars for">
          {teamUsernames.map((u) => {
            const m = memberFor(u);
            return (
              <button
                key={u}
                className={`person-chip ${people.has(u) ? "active" : ""}`}
                onClick={() => togglePerson(u)}
                title={u === me.username ? `${u} (you)` : u}
              >
                {m ? <CharacterAvatar id={m.avatar} size={22} /> : <span className="avatar sm">{u[0]}</span>}
                <span>{u === me.username ? "me" : u}</span>
              </button>
            );
          })}
        </div>

        {plan && (
          <span className="plan-source" title={`Assuming ${plan.hoursPerDay} focused hours per day`}>
            {plan.source === "ai" ? "AI estimates" : "heuristic estimates"}
          </span>
        )}
      </header>

      <div className="plan-body">
        <aside className="backlog" aria-label="Unplanned tasks">
          <h3>
            Backlog <span className="ft-count">{backlog.length}</span>
          </h3>
          <p className="backlog-hint">Your unplanned tasks — drag onto a day.</p>
          {backlog.map((t) => (
            <div
              key={`${t.noteId}:${t.line}`}
              className={`cal-task ${t.atRisk ? "risk" : ""}`}
              draggable
              onDragStart={(e) => startDrag(e, t)}
              onDragEnd={() => {
                setDragTask(null);
                setDropDay(null);
              }}
            >
              <span className="cal-task-est">{t.estimateHours}h</span>
              <span className="cal-task-text">{t.text}</span>
              {t.due && <span className={`cal-task-due ${t.due < today ? "overdue" : ""}`}>due {t.due.slice(5)}</span>}
            </div>
          ))}
          {backlog.length === 0 && <p className="empty">Everything is planned. Rare air.</p>}
        </aside>

        {mode === "week" ? (
          <div className="cal-week" style={{ ["--lanes" as string]: selected.length }}>
            {days.map((d) => {
              const day = iso(d);
              const isToday = day === today;
              const droppable = dropDay === day && dragTask;
              return (
                <div
                  key={day}
                  className={`cal-day ${isToday ? "today" : ""} ${droppable ? "droppable" : ""} ${d.getDay() === 0 || d.getDay() === 6 ? "weekend" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropDay(day);
                  }}
                  onDragLeave={() => setDropDay((x) => (x === day ? null : x))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropDay(null);
                    const t = taskFromDrop(e);
                    if (t) void schedule(t, day);
                  }}
                >
                  <header className="cal-day-head">
                    <span className="cal-day-name">{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                    <span className="cal-day-num">{d.getDate()}</span>
                  </header>
                  <div className="cal-lanes">
                    {selected.map((u) => {
                      const mine = u === me.username;
                      const dayTasks = allTasks.filter((t) => t.assignee === u && t.plannedDate === day);
                      const hours = dayTasks.reduce((s, t) => s + t.estimateHours, 0);
                      const over = plan && hours > plan.hoursPerDay;
                      const m = memberFor(u);
                      return (
                        <div key={u} className={`cal-lane ${over ? "over" : ""}`}>
                          {selected.length > 1 && (
                            <span className="cal-lane-owner" title={u}>
                              {m ? <CharacterAvatar id={m.avatar} size={16} /> : u[0]}
                            </span>
                          )}
                          {dayTasks.map((t) => (
                            <div
                              key={`${t.noteId}:${t.blockId ?? t.line}`}
                              className={`cal-task placed ${t.due && day > t.due ? "risk" : ""} ${mine ? "" : "readonly"}`}
                              style={{ minHeight: Math.max(t.estimateHours * 14, 26) }}
                              draggable={mine}
                              onDragStart={(e) => mine && startDrag(e, t)}
                              onDragEnd={() => {
                                setDragTask(null);
                                setDropDay(null);
                              }}
                              onDoubleClick={() => onOpenNote(t.noteId)}
                              title={`${t.text} — ${t.estimateHours}h (${t.noteTitle})${t.due ? ` · due ${t.due}` : ""}`}
                            >
                              <span className="cal-task-est">{t.estimateHours}h</span>
                              <span className="cal-task-text">{t.text}</span>
                              {mine && (
                                <button
                                  className="cal-unplan"
                                  title="Back to backlog"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void schedule(t, null);
                                  }}
                                >
                                  ×
                                </button>
                              )}
                            </div>
                          ))}
                          {hours > 0 && (
                            <span className={`cal-lane-sum ${over ? "over" : ""}`}>
                              {hours}h{over ? " ▲" : ""}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <MonthGrid
            anchor={weekStart}
            tasks={allTasks.filter((t) => t.assignee && people.has(t.assignee))}
            onPickWeek={(d) => {
              setWeekStart(mondayOf(d));
              setMode("week");
            }}
          />
        )}
      </div>
    </div>
  );
}

function MonthGrid({
  anchor,
  tasks,
  onPickWeek,
}: {
  anchor: Date;
  tasks: PlanTask[];
  onPickWeek: (d: Date) => void;
}) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12);
  const start = mondayOf(first);
  const weeks = Array.from({ length: 6 }, (_, w) =>
    Array.from({ length: 7 }, (_, d) => new Date(start.getTime() + (w * 7 + d) * DAY_MS)),
  );
  const today = iso(new Date());
  return (
    <div className="cal-month">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
        <span key={d} className="cal-month-dow">
          {d}
        </span>
      ))}
      {weeks.flat().map((d) => {
        const day = iso(d);
        const dayTasks = tasks.filter((t) => t.plannedDate === day);
        const hours = dayTasks.reduce((s, t) => s + t.estimateHours, 0);
        const otherMonth = d.getMonth() !== anchor.getMonth();
        return (
          <button
            key={day}
            className={`cal-month-day ${day === today ? "today" : ""} ${otherMonth ? "dim" : ""}`}
            onClick={() => onPickWeek(d)}
            title={`${day} · ${dayTasks.length} tasks`}
          >
            <span className="cal-month-num">{d.getDate()}</span>
            {hours > 0 && (
              <span className="cal-month-load">
                <span className="cal-month-bar" style={{ width: `${Math.min(hours / 8, 1) * 100}%` }} />
                {hours}h
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
