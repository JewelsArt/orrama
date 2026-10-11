/**
 * The week as lanes (structure.md §2.2, the Planning board): life areas run across the seven
 * days, the dated row (key deadlines, money, milestones) sits above the horizon, Orr stands on
 * the horizon at now with the past dotted behind him, and the next three weeks run down the
 * right edge. A lane's name shows it alone; a day's name opens that day; an empty cell adds a
 * step due that day; anything movable drags to another day, and its note changes with it.
 */
import { useState, type CSSProperties, type DragEvent } from "react";
import { addDays, dayOf } from "../calendarMath.js";
import { Button, DeadlineChip } from "../ui/controls.js";
import { minutesLabel } from "../ui/dates.js";
import { Orr } from "../ui/orr/Orr.js";
import { DATED_LANE, bookedOn, hoursLabel, itemsOn, money, nextWeeks, nowAlong, weekLanes, type Item } from "./model.js";
import { ITEM_MIME, TimeItem } from "./TimeItem.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LONG_WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface LanesProps {
  weekStart: Date;
  days: string[];
  /** The week's items and the next three weeks'. */
  items: Item[];
  today: string;
  now: Date;
  /** Steps in the notes with nothing planned: the empty week's offer. */
  unplanned: number;
  onOpen: (item: Item, el: HTMLElement) => void;
  onMove: (item: Item, date: string) => void;
  onAdd: (date: string) => void;
  onOpenDay: (date: string) => void;
  onOpenMonth: () => void;
  onPickSome: () => void;
  colorOf: (lane: string) => string | null;
}

/** Let a cell take a dragged item. */
export function dropTarget(date: string, items: Item[], onMove: (item: Item, date: string) => void) {
  return {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(ITEM_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("is-drop");
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => e.currentTarget.classList.remove("is-drop"),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.currentTarget.classList.remove("is-drop");
      const id = e.dataTransfer.getData(ITEM_MIME);
      const item = items.find((i) => i.id === id);
      if (!item) return;
      e.preventDefault();
      if (item.date !== date) onMove(item, date);
    },
  };
}

export const startDrag = (item: Item, e: DragEvent<HTMLElement>) => {
  e.dataTransfer.setData(ITEM_MIME, item.id);
  e.dataTransfer.effectAllowed = "move";
};

export function Lanes({ weekStart, days, items, today, now, unplanned, onOpen, onMove, onAdd, onOpenDay, onOpenMonth, onPickSome, colorOf }: LanesProps) {
  const [alone, setAlone] = useState<string | null>(null);
  const week = items.filter((i) => i.date >= days[0]! && i.date <= days[6]!);
  const { lanes, quiet } = weekLanes(week.filter((i) => i.lane !== DATED_LANE));
  const shown = alone ? lanes.filter((l) => l.id === alone) : lanes;
  const dated = week.filter((i) => i.lane === DATED_LANE);
  const along = nowAlong(weekStart, now);
  const past = days[6]! < today;
  const pct = along !== null ? `${(along * 100).toFixed(2)}%` : past ? "100%" : "0%";
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const futFrom = addDays(weekStart, 7);
  const futTo = addDays(weekStart, 27);
  const fut = nextWeeks(items, isoOf(futFrom), isoOf(futTo));
  const nothing = week.filter((i) => i.lane !== DATED_LANE).length === 0;
  const rows = 3 + (nothing ? 1 : shown.length) + (alone ? 0 : quiet.length);

  const cell = (date: string, laneItems: Item[], color: string | null, extra: string, row: number, add: boolean) => {
    const d = dayOf(date)!;
    const col = days.indexOf(date) + 2;
    return (
      <div
        key={`${row}:${date}`}
        className={`wk-c ${extra} ${date < today ? "past" : ""} ${date === today ? "today" : ""}`}
        style={{ gridColumn: col, gridRow: row, ...(color ? ({ "--lane": color } as CSSProperties) : {}) }}
        {...dropTarget(date, items, onMove)}
      >
        {itemsOn(laneItems, date).map((i) => (
          <TimeItem key={i.id} item={i} today={today} nowMin={nowMin} onOpen={onOpen} onDragStart={startDrag} color={i.lane === DATED_LANE ? null : colorOf(i.lane)} />
        ))}
        {add && (
          <button type="button" className="add" onClick={() => onAdd(date)}>
            + Add to {LONG_WD[d.getDay()]}
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="wk plan-wk" aria-label="The week in lanes" style={{ gridTemplateRows: `auto auto 46px repeat(${rows - 3}, auto)` }}>
      <div className="wk-lh sky" style={{ gridColumn: 1, gridRow: 1 }} />
      {days.map((date, n) => {
        const d = dayOf(date)!;
        const booked = bookedOn(week, date);
        return (
          <button
            key={date}
            type="button"
            className={`wk-dh ${date < today ? "past" : ""} ${date === today ? "today" : ""}`}
            style={{ gridColumn: n + 2, gridRow: 1 }}
            onClick={() => onOpenDay(date)}
            aria-label={`Open ${LONG_WD[d.getDay()]} ${d.getDate()} ${LONG_MO[d.getMonth()]}`}
          >
            <b>{WD[d.getDay()]}</b>
            {d.getDate()}
            {booked > 0 && <span className="h">{hoursLabel(booked)}</span>}
          </button>
        );
      })}

      <aside className="wk-fut" aria-label="Next three weeks">
        <h3>
          Next three weeks
          <small>
            {futFrom.getDate()} {LONG_MO[futFrom.getMonth()]} – {futTo.getDate()} {LONG_MO[futTo.getMonth()]}
          </small>
        </h3>
        {fut.shown.map((i) => (
          <button key={i.id} type="button" className="wk-fi" onClick={(e) => onOpen(i, e.currentTarget)}>
            <span className="d">
              {WD[dayOf(i.date)!.getDay()]} {dayOf(i.date)!.getDate()}
            </span>
            <div>
              <b>{i.title}</b>
              <small>{futureSub(i)}</small>
              {i.kind === "key" && <DeadlineChip small>Key deadline</DeadlineChip>}
            </div>
          </button>
        ))}
        {fut.shown.length === 0 && <p className="plan-fut-none">Nothing dated yet.</p>}
        {fut.more > 0 && (
          <button type="button" className="plan-fut-more" onClick={onOpenMonth}>
            {fut.more} more in the month
          </button>
        )}
      </aside>

      <div className="wk-lh sky" style={{ gridColumn: 1, gridRow: 2 }}>
        <b>Dated</b>
        <small>deadlines, money</small>
      </div>
      {days.map((date) => cell(date, dated, null, "plan-dated", 2, false))}

      <div className="wk-lh sky plan-nowlab" style={{ gridColumn: 1, gridRow: 3 }}>
        <small>{along !== null ? "now" : ""}</small>
      </div>
      {days.map((date, n) => (
        <div key={`hc:${date}`} className={`wk-hc ${date === today ? "today" : ""}`} style={{ gridColumn: n + 2, gridRow: 3 }} />
      ))}
      <div className="wk-hz" style={{ gridColumn: "2 / 9", gridRow: 3 }} aria-hidden={along === null}>
        {pct !== "0%" && <div className="behind" style={{ width: pct }} />}
        {pct !== "100%" && <div className="ahead" style={{ left: pct }} />}
        {along !== null && (
          <>
            <div className="orr" style={{ left: pct }}>
              <Orr pose={nothing ? "sit" : "hello"} size={36} label="Orr, at now" />
            </div>
            <span className={`tnow ${along > 0.86 ? "lead" : ""}`} style={{ left: pct }}>
              {minutesLabel(nowMin)}
            </span>
          </>
        )}
      </div>

      {nothing ? (
        <div className="plan-open" style={{ gridColumn: "1 / 9", gridRow: 4 }}>
          <b>An open week.</b>
          <p>
            {unplanned} step{unplanned === 1 ? "" : "s"} in your notes {unplanned === 1 ? "has" : "have"} no time yet.
          </p>
          {unplanned > 0 && (
            <Button size="sm" onClick={onPickSome}>
              Pick some for this week
            </Button>
          )}
        </div>
      ) : (
        shown.map((lane, k) => {
          const row = 4 + k;
          return [
            <button
              key={`lh:${lane.id}`}
              type="button"
              className="wk-lh lane"
              style={{ gridColumn: 1, gridRow: row }}
              onClick={() => setAlone(alone === lane.id ? null : lane.id)}
              aria-pressed={alone === lane.id}
              title={alone === lane.id ? "Show every lane" : `Show ${lane.label} alone`}
            >
              <b>
                {lane.color && <i style={{ background: lane.color }} />}
                {lane.label}
              </b>
              {lane.note && <small>{lane.note}</small>}
            </button>,
            ...days.map((date) => cell(date, lane.items, lane.color, "lane", row, true)),
          ];
        })
      )}

      {!alone &&
        quiet.map((lane, k) => (
          <button key={`q:${lane.id}`} type="button" className="knw lane" style={{ gridRow: rows - quiet.length + 1 + k }} onClick={() => onAdd(today >= days[0]! && today <= days[6]! ? today : days[0]!)} title="Add a step due this week">
            <b>
              {lane.color && <i style={{ background: lane.color }} />}
              {lane.label}
            </b>
            nothing dated this week
          </button>
        ))}
    </section>
  );
}

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The line under an item in the next three weeks: its time and where it's from, or the money. */
function futureSub(i: Item): string {
  if (i.kind === "mn") return money(i.amount ?? 0, i.currency);
  const time = i.startMin !== null && !i.allDay ? minutesLabel(i.startMin) : "";
  return [time, i.project].filter(Boolean).join(" · ") || (i.kind === "ev" ? "event" : "");
}

