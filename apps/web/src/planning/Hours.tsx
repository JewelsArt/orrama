/**
 * The hour grid (structure.md §6 #15): the week in Hours, or one day. The dated band sits
 * between the day heads and the hours; the hour window follows the content and its label is
 * the switch to the whole 24 hours; the grid opens on the day's first item. Booked time and
 * your own events move and resize with the pointer; a double-click on an empty hour makes an
 * event; a step dropped from To plan is booked where it lands.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { dayOf } from "../calendarMath.js";
import { minutesLabel } from "../ui/dates.js";
import { DATED_LANE, bookedOn, firstScroll, hoursLabel, itemsOn, windowFor, type Item } from "./model.js";
import { TimeItem } from "./TimeItem.js";

/** One hour, in pixels (the board's --hh). */
export const HOUR_PX = 48;
const PX = HOUR_PX / 60;
export const SNAP = 30;
const BAND_SHOWN = 2;

/** A step dragged from To plan: what the drop books. */
export const TASK_MIME = "text/task";
export interface DraggedStep {
  noteId: string;
  line: number;
  blockId: string | null;
  text: string;
  estimateHours: number;
  remainingHours: number;
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface HoursProps {
  days: string[];
  items: Item[];
  today: string;
  now: Date;
  fullDay: boolean;
  onFullDay: (v: boolean) => void;
  onOpen: (item: Item, el: HTMLElement) => void;
  /** A double-click on an empty hour: the anchor is the ghost slot drawn there. */
  onNewEvent: (date: string, startMin: number, anchor: HTMLElement) => void;
  onBook: (step: DraggedStep, date: string, startMin: number) => void;
  onPatch: (item: Item, to: { date: string; startMin: number; durationMin: number }) => void;
  onOpenDay?: (date: string) => void;
  colorOf: (lane: string) => string | null;
  /** The ghost slot of an event being made, while its popover is open. */
  pending?: { date: string; startMin: number } | null;
}

interface Drag {
  kind: "move" | "resize";
  item: Item;
  date: string;
  startMin: number;
  durationMin: number;
  /** Where in the item the pointer took hold, in minutes from its top. */
  grip: number;
  moved: boolean;
}

/** Side-by-side columns for items that overlap in time, so none hides another. */
function columns(list: Item[]): Map<string, { col: number; of: number }> {
  const out = new Map<string, { col: number; of: number }>();
  const sorted = [...list].sort((a, b) => a.startMin! - b.startMin! || b.durationMin - a.durationMin);
  let cluster: { item: Item; col: number }[] = [];
  let end = -1;
  const flush = () => {
    const of = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.set(c.item.id, { col: c.col, of });
    cluster = [];
  };
  for (const item of sorted) {
    const s = item.startMin!;
    if (s >= end) {
      flush();
      end = -1;
    }
    const taken = new Set(cluster.filter((c) => c.item.startMin! + Math.max(c.item.durationMin, 15) > s).map((c) => c.col));
    let col = 0;
    while (taken.has(col)) col++;
    cluster.push({ item, col });
    end = Math.max(end, s + Math.max(item.durationMin, 15));
  }
  flush();
  return out;
}

export function Hours({ days, items, today, now, fullDay, onFullDay, onOpen, onNewEvent, onBook, onPatch, onOpenDay, colorOf, pending }: HoursProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [ghost, setGhost] = useState<{ date: string; startMin: number; durationMin: number } | null>(null);
  const [bandOpen, setBandOpen] = useState(false);

  const timed = useMemo(() => items.filter((i) => i.startMin !== null && !i.allDay && (i.kind === "bk" || i.kind === "ev" || i.kind === "fd" || i.kind === "pp")), [items]);
  const band = useMemo(() => items.filter((i) => !timed.includes(i)), [items, timed]);
  const [dayStart, dayEnd] = useMemo(() => windowFor(fullDay, timed), [fullDay, timed]);
  const height = (dayEnd - dayStart) * PX;
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let m = dayStart; m < dayEnd; m += 60) out.push(m);
    return out;
  }, [dayStart, dayEnd]);
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // Open on the first thing in the days shown (§2.2: not on a fixed 11:30).
  const firstKey = days.join(",");
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = (firstScroll(timed, dayStart) - dayStart) * PX;
    // Only when the days or the window change, not on every reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, dayStart]);

  /** The day and minute under a pointer. */
  const locate = (x: number, y: number): { date: string; min: number } | null => {
    const body = bodyRef.current;
    if (!body) return null;
    const r = body.getBoundingClientRect();
    const idx = Math.max(0, Math.min(days.length - 1, Math.floor(((x - r.left) / r.width) * days.length)));
    const min = dayStart + (y - r.top) / PX;
    if (!Number.isFinite(idx) || !Number.isFinite(min)) return null;
    return { date: days[idx]!, min };
  };
  const snap = (min: number) => Math.max(0, Math.min(Math.round(min / SNAP) * SNAP, 24 * 60 - SNAP));

  // Pointer-driven move and resize; a press without movement is a click and opens the item.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const at = locate(e.clientX, e.clientY);
      if (!at) return;
      if (d.kind === "move") {
        const startMin = snap(at.min - d.grip);
        if (at.date !== d.date || startMin !== d.startMin) setDrag({ ...d, date: at.date, startMin, moved: true });
      } else {
        const dur = Math.max(SNAP, Math.round((at.min - d.startMin) / SNAP) * SNAP);
        const capped = Math.min(dur, 24 * 60 - d.startMin);
        if (capped !== d.durationMin) setDrag({ ...d, durationMin: capped, moved: true });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      if (d.moved) onPatch(d.item, { date: d.date, startMin: d.startMin, durationMin: d.durationMin });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, dayStart]);

  const editable = (i: Item) => i.kind === "bk" || (i.kind === "ev" && !!i.event?.mine && !i.event.readonly);
  /** Where an item is drawn: its own place, or the drag's while it is being dragged. */
  const placed = (i: Item) => (drag && drag.item.id === i.id ? { date: drag.date, startMin: drag.startMin, durationMin: drag.durationMin } : { date: i.date, startMin: i.startMin!, durationMin: i.durationMin });

  const cols = days.length;
  const grid = { gridTemplateColumns: `54px repeat(${cols}, minmax(0, 1fr))` } as CSSProperties;
  const bandItems = (date: string) => itemsOn(band, date);
  const crowded = days.some((d) => bandItems(d).length > BAND_SHOWN);

  return (
    <section className={`hg plan-hg ${cols === 1 ? "one" : ""}`} aria-label={cols === 1 ? "The day in hours" : "The week in hours"} style={grid}>
      <div className="plan-hg-corner">
        <button type="button" className="plan-window" onClick={() => onFullDay(!fullDay)} title={fullDay ? "Show only the hours in use" : "Show the whole 24 hours"} aria-pressed={fullDay}>
          {fullDay ? "24h" : `${String(dayStart / 60).padStart(2, "0")}–${String(dayEnd / 60).padStart(2, "0")}`}
        </button>
      </div>
      {days.map((date) => {
        const d = dayOf(date)!;
        const booked = bookedOn(items, date);
        const inner = (
          <>
            <b>{WD[d.getDay()]}</b>
            {d.getDate()}
            {booked > 0 && <span className="h">{hoursLabel(booked)}</span>}
          </>
        );
        const cls = `hg-dh ${date < today ? "past" : ""} ${date === today ? "today" : ""}`;
        return onOpenDay ? (
          <button key={date} type="button" className={cls} onClick={() => onOpenDay(date)}>
            {inner}
          </button>
        ) : (
          <div key={date} className={cls}>
            {inner}
          </div>
        );
      })}

      <div className="hg-lab">
        dated
        {crowded && (
          <button type="button" className="plan-band-more" onClick={() => setBandOpen(!bandOpen)}>
            {bandOpen ? "less" : "all"}
          </button>
        )}
      </div>
      {days.map((date) => {
        const list = bandItems(date);
        const shown = bandOpen ? list : list.slice(0, BAND_SHOWN);
        return (
          <div key={`band:${date}`} className={`hg-band ${date < today ? "past" : ""} ${date === today ? "today" : ""}`}>
            {shown.map((i) => (
              <TimeItem key={i.id} item={i} size="band" today={today} onOpen={onOpen} color={i.lane === DATED_LANE ? null : colorOf(i.lane)} />
            ))}
            {!bandOpen && list.length > shown.length && (
              <button type="button" className="plus" onClick={() => setBandOpen(true)}>
                +{list.length - shown.length} more
              </button>
            )}
          </div>
        );
      })}

      <div className="plan-hg-scroll" ref={scrollRef} style={{ gridColumn: "1 / -1" }}>
        <div className="plan-hg-body" style={grid}>
          <div className="hg-hrs" style={{ height }}>
            {hours.map((m) => (
              <span key={m} style={{ top: (m - dayStart) * PX }}>
                {minutesLabel(m)}
              </span>
            ))}
          </div>
          <div className="plan-hg-cols" ref={bodyRef} style={{ gridColumn: `2 / ${cols + 2}`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {days.map((date) => {
              const mine = timed.filter((i) => placed(i).date === date);
              const lay = columns(mine.map((i) => ({ ...i, ...placed(i) })));
              const g = ghost?.date === date ? ghost : pending?.date === date ? { ...pending, durationMin: 60 } : null;
              return (
                <div
                  key={date}
                  className={`hg-col ${date < today ? "past" : ""} ${date === today ? "today" : ""}`}
                  style={{ height, backgroundSize: `100% ${HOUR_PX}px`, backgroundPositionY: `${-((dayStart % 60) * PX)}px` }}
                  onDoubleClick={(e) => {
                    if ((e.target as HTMLElement).closest(".tm")) return;
                    const at = locate(e.clientX, e.clientY);
                    if (!at) return;
                    const startMin = Math.floor(at.min / SNAP) * SNAP;
                    // The ghost slot is the popover's anchor: render it, then open.
                    const slot = e.currentTarget.querySelector<HTMLElement>(".plan-anchor");
                    if (slot) {
                      slot.style.top = `${(startMin - dayStart) * PX}px`;
                      onNewEvent(date, startMin, slot);
                    }
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(TASK_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    const at = locate(e.clientX, e.clientY);
                    if (at) {
                      const startMin = snap(at.min);
                      if (!ghost || ghost.date !== at.date || ghost.startMin !== startMin) setGhost({ date: at.date, startMin, durationMin: ghost?.durationMin ?? 120 });
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) setGhost(null);
                  }}
                  onDrop={(e) => {
                    setGhost(null);
                    const raw = e.dataTransfer.getData(TASK_MIME);
                    if (!raw) return;
                    e.preventDefault();
                    const at = locate(e.clientX, e.clientY);
                    if (at) onBook(JSON.parse(raw) as DraggedStep, date, snap(at.min));
                  }}
                >
                  <span className="plan-anchor" aria-hidden="true" />
                  {mine.map((i) => {
                    const p = placed(i);
                    const lay1 = lay.get(i.id) ?? { col: 0, of: 1 };
                    const short = p.durationMin * PX < 30;
                    const can = editable(i);
                    return (
                      <TimeItem
                        key={i.id}
                        item={i}
                        today={today}
                        nowMin={nowMin}
                        size="card"
                        className={`${short ? "s" : ""} ${drag?.item.id === i.id ? "plan-dragging" : ""}`}
                        color={colorOf(i.lane)}
                        style={{
                          top: (p.startMin - dayStart) * PX,
                          height: Math.max(p.durationMin * PX, 16),
                          left: `calc(${(lay1.col / lay1.of) * 100}% + 4px)`,
                          right: `calc(${((lay1.of - lay1.col - 1) / lay1.of) * 100}% + 4px)`,
                          touchAction: can ? "none" : undefined,
                        }}
                        onOpen={(item, el) => {
                          // A press that moved was a drag, not a click.
                          if (dragRef.current?.moved) return;
                          onOpen(item, el);
                        }}
                        onPointerDown={
                          can
                            ? (e) => {
                                if (e.button !== 0) return;
                                const handle = (e.target as HTMLElement).closest(".plan-resize");
                                const at = locate(e.clientX, e.clientY);
                                setDrag({ kind: handle ? "resize" : "move", item: i, date: p.date, startMin: p.startMin, durationMin: p.durationMin, grip: at ? Math.max(0, at.min - p.startMin) : 0, moved: false });
                              }
                            : undefined
                        }
                        resizable={can}
                      />
                    );
                  })}
                  {g && (
                    <div className="slot is-ghost" style={{ top: (g.startMin - dayStart) * PX, height: g.durationMin * PX }}>
                      {WD[dayOf(date)!.getDay()]} {minutesLabel(g.startMin)}–{minutesLabel(Math.min(g.startMin + g.durationMin, 24 * 60))}
                    </div>
                  )}
                  {date === today && nowMin >= dayStart && nowMin <= dayEnd && <div className="hg-now" style={{ top: (nowMin - dayStart) * PX }} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
