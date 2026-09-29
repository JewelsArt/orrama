import { useMemo, useRef, useState } from "react";
import type { DashboardTask } from "./api.js";

/**
 * Per-project Gantt view (Overview board's alternate steps panel). Bars are
 * start:→due: tokens on the Markdown task lines — dragging a bar edits the
 * file through /api/tasks/dates, so the chart survives a re-index like every
 * other dashboard surface. Undated tasks wait in the unscheduled strip below;
 * drag one onto the timeline to give it dates.
 */

const DAY_PX = 26;
const MS_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DEFAULT_SPAN = 2; // days added after the drop day when scheduling from the strip

function toDay(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / MS_DAY;
}
function toIso(day: number): string {
  return new Date(day * MS_DAY).toISOString().slice(0, 10);
}
function todayDay(): number {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / MS_DAY;
}

type DragMode = "move" | "resize-l" | "resize-r";
interface DragState {
  key: string;
  mode: DragMode;
  originX: number;
  delta: number; // days, applied live while dragging
}

export interface GanttProps {
  tasks: DashboardTask[];
  color: string;
  onSetDates: (t: DashboardTask, dates: { start?: string | null; due?: string | null }) => void;
  onOpen: (id: string) => void;
}

const ROW_CAP = 12;

export function Gantt({ tasks, color, onSetDates, onOpen }: GanttProps) {
  const [showAll, setShowAll] = useState(false);
  // The ref is the source of truth during a drag (event closures can be a render
  // behind); state mirrors it purely to repaint the bar at the new offset.
  const dragRef = useRef<DragState | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  const dated = useMemo(
    () =>
      tasks
        .filter((t) => t.start || t.due)
        .sort((a, b) => (a.start ?? a.due!).localeCompare(b.start ?? b.due!) || (a.due ?? "").localeCompare(b.due ?? "")),
    [tasks],
  );
  const rows = showAll ? dated : dated.slice(0, ROW_CAP);
  const unscheduled = tasks.filter((t) => !t.start && !t.due && !t.checked);

  const today = todayDay();
  const { min, days } = useMemo(() => {
    const ds = rows.flatMap((t) => [t.start, t.due].filter(Boolean).map((d) => toDay(d!)));
    const lo = Math.min(...(ds.length ? ds : [today])) - 3;
    const hi = Math.max(...(ds.length ? ds : [today]), today) + 8;
    return { min: lo, days: hi - lo + 1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, today]);

  const width = days * DAY_PX;
  // Weekend stripe + Monday rule, aligned to the range's first weekday.
  const dow = (min + 4) % 7; // day 0 (1970-01-01) was a Thursday
  const satOffset = ((6 - dow) % 7) * DAY_PX;
  const monOffset = ((8 - dow) % 7) * DAY_PX;
  const trackBg = {
    backgroundImage: `repeating-linear-gradient(90deg, var(--gantt-weekend) 0 ${2 * DAY_PX}px, transparent ${2 * DAY_PX}px ${7 * DAY_PX}px), repeating-linear-gradient(90deg, var(--border) 0 1px, transparent 1px ${7 * DAY_PX}px)`,
    backgroundPositionX: `${satOffset}px, ${monOffset}px`,
  };

  const keyOf = (t: DashboardTask) => `${t.noteId}:${t.line}`;

  const commit = (t: DashboardTask, mode: DragMode, delta: number) => {
    if (delta === 0) return;
    const s = t.start ? toDay(t.start) : undefined;
    const e = t.due ? toDay(t.due) : undefined;
    if (mode === "move") {
      onSetDates(t, {
        ...(s !== undefined ? { start: toIso(s + delta) } : {}),
        ...(e !== undefined ? { due: toIso(e + delta) } : {}),
      });
    } else if (mode === "resize-l") {
      const anchor = e ?? s!;
      onSetDates(t, { start: toIso(Math.min((s ?? anchor) + delta, anchor)) });
    } else {
      const anchor = s ?? e!;
      onSetDates(t, { due: toIso(Math.max((e ?? anchor) + delta, anchor)) });
    }
  };

  const startDrag = (ev: React.PointerEvent, t: DashboardTask, mode: DragMode) => {
    ev.preventDefault();
    try {
      (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    } catch {
      // pointer already gone (or synthetic event) — drag still tracks via move/up
    }
    dragRef.current = { key: keyOf(t), mode, originX: ev.clientX, delta: 0 };
    setDrag(dragRef.current);
  };

  const dropDay = (ev: React.DragEvent): number => {
    const rect = rowsRef.current!.getBoundingClientRect();
    return min + Math.max(0, Math.min(days - 1, Math.floor((ev.clientX - rect.left) / DAY_PX)));
  };

  return (
    <div className="gantt" style={{ ["--pc" as string]: color, ["--gantt-day" as string]: `${DAY_PX}px` }}>
      <div className="gantt-split">
      <div className="gantt-names">
        <div className="gantt-names-head" />
        {rows.map((t) => (
          <button
            key={`${t.noteId}:${t.line}-lbl`}
            className={`gantt-name ${t.checked ? "done" : ""}`}
            title={t.text}
            onClick={() => onOpen(t.noteId)}
          >
            {t.text}
          </button>
        ))}
      </div>
      <div className="gantt-scroll">
        <div className="gantt-canvas" style={{ width }}>
          <GanttHead min={min} days={days} today={today} />
          <div
            className="gantt-rows"
            ref={rowsRef}
            style={trackBg}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const raw = e.dataTransfer.getData("text/gantt-task");
              if (!raw) return;
              e.preventDefault();
              const ref = JSON.parse(raw) as { noteId: string; line: number };
              const t = tasks.find((x) => x.noteId === ref.noteId && x.line === ref.line);
              const day = dropDay(e);
              if (t) onSetDates(t, { start: toIso(day), due: toIso(day + DEFAULT_SPAN) });
            }}
          >
            <span className="gantt-today" style={{ left: (today - min) * DAY_PX }} aria-hidden />
            {rows.map((t) => {
              const key = keyOf(t);
              const d = drag?.key === key ? drag : null;
              let s = t.start ? toDay(t.start) : toDay(t.due!);
              let e = t.due ? toDay(t.due) : s;
              if (d) {
                if (d.mode !== "resize-r") s = Math.min(s + d.delta, d.mode === "resize-l" ? e : Infinity);
                if (d.mode !== "resize-l") e = Math.max(e + d.delta, d.mode === "resize-r" ? s : -Infinity);
              }
              const status = t.checked ? "done" : t.status === "in-progress" ? "work" : "todo";
              const narrow = e - s < 3; // label won't fit — hang it off the right edge
              return (
                <div key={key} className="gantt-row">
                  <div
                    className={`gantt-bar ${status} ${narrow ? "narrow" : ""} ${d ? "dragging" : ""}`}
                    style={{ left: s * DAY_PX - min * DAY_PX, width: (e - s + 1) * DAY_PX - 3 }}
                    title={`${t.text} · ${toIso(s)} → ${toIso(e)}`}
                    onPointerDown={(ev) => startDrag(ev, t, "move")}
                    onPointerMove={(ev) => {
                      const cur = dragRef.current;
                      if (cur?.key !== key) return;
                      const delta = Math.round((ev.clientX - cur.originX) / DAY_PX);
                      if (delta !== cur.delta) {
                        dragRef.current = { ...cur, delta };
                        setDrag(dragRef.current);
                      }
                    }}
                    onPointerUp={() => {
                      const cur = dragRef.current;
                      if (cur?.key !== key) return;
                      dragRef.current = null;
                      setDrag(null);
                      commit(t, cur.mode, cur.delta);
                    }}
                  >
                    <span className="gantt-grip l" onPointerDown={(ev) => { ev.stopPropagation(); startDrag(ev, t, "resize-l"); }} />
                    <span className="gantt-grip r" onPointerDown={(ev) => { ev.stopPropagation(); startDrag(ev, t, "resize-r"); }} />
                  </div>
                  <button
                    className="gantt-unset ghost"
                    style={{ left: (e + 1) * DAY_PX - min * DAY_PX + 4 }}
                    title="Remove dates (back to unscheduled)"
                    onClick={() => onSetDates(t, { start: null, due: null })}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            {dated.length === 0 && (
              <p className="gantt-empty" style={{ left: (today - min) * DAY_PX + DAY_PX }}>
                Drag a step here to schedule it.
              </p>
            )}
          </div>
        </div>
      </div>
      </div>

      {dated.length > ROW_CAP && (
        <button className="gantt-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `+ ${dated.length - ROW_CAP} more scheduled steps`}
        </button>
      )}

      {unscheduled.length > 0 && (
        <div className="gantt-strip">
          <span className="gantt-strip-lbl">
            Unscheduled · {unscheduled.length} — drag onto the timeline
          </span>
          <div className="gantt-chips">
            {unscheduled.map((t) => (
              <span
                key={keyOf(t)}
                className="gantt-chip"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/gantt-task", JSON.stringify({ noteId: t.noteId, line: t.line }));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => onOpen(t.noteId)}
                title={t.text}
              >
                {t.text}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GanttHead({ min, days, today }: { min: number; days: number; today: number }) {
  const cells = [];
  for (let i = 0; i < days; i++) {
    const day = min + i;
    const date = new Date(day * MS_DAY);
    const dom = date.getUTCDate();
    const isMon = (day + 4) % 7 === 1; // (day+4)%7 mirrors getUTCDay(): 0=Sun


    cells.push(
      <span key={day} className={`gantt-d ${day === today ? "today" : ""}`}>
        {dom === 1 ? <b>{MONTHS[date.getUTCMonth()]}</b> : isMon ? dom : ""}
      </span>,
    );
  }
  return <div className="gantt-head">{cells}</div>;
}
