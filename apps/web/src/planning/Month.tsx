/**
 * The month (structure.md §2.2): six weeks of days, each with its first items and "+N more".
 * A day's number opens that day, and so does "+N more"; an empty day adds a step due then;
 * anything movable drags to another day. On the phone it is a compact grid of dots, with the
 * chosen day's items below (the month board's phone frame).
 */
import { useState } from "react";
import { dayOf, longMonth, longWeekday } from "../calendarMath.js";
import { minutesLabel } from "../ui/dates.js";
import { DATED_LANE, itemsOn, type Item } from "./model.js";
import { dropTarget, startDrag } from "./Lanes.js";
import { TimeItem } from "./TimeItem.js";

const SHOWN = 3;
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface MonthProps {
  first: Date;
  cells: string[];
  items: Item[];
  today: string;
  onOpen: (item: Item, el: HTMLElement) => void;
  onMove: (item: Item, date: string) => void;
  onAdd: (date: string) => void;
  onOpenDay: (date: string) => void;
  colorOf: (lane: string) => string | null;
}

const LONG_WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function Month({ first, cells, items, today, onOpen, onMove, onAdd, onOpenDay, colorOf }: MonthProps) {
  return (
    <section className="mo plan-mo" aria-label={`${longMonth(first)} ${first.getFullYear()}`}>
      {WD.map((d) => (
        <div key={d} className="wd">
          {d}
        </div>
      ))}
      {cells.map((date) => {
        const d = dayOf(date)!;
        const list = itemsOn(items, date);
        const shown = list.slice(0, SHOWN);
        const out = d.getMonth() !== first.getMonth();
        return (
          <div key={date} className={`mc ${out ? "out" : ""} ${date < today ? "past" : ""} ${date === today ? "today" : ""}`} {...dropTarget(date, items, onMove)}>
            <button type="button" className="n" onClick={() => onOpenDay(date)} aria-label={`Open ${LONG_WD[d.getDay()]} ${d.getDate()} ${longMonth(d)}`}>
              {d.getDate() === 1 ? `1 ${MO[d.getMonth()]}` : d.getDate()}
            </button>
            {shown.map((i) => (
              <TimeItem key={i.id} item={i} size="s" today={today} onOpen={onOpen} onDragStart={startDrag} color={i.lane === DATED_LANE ? null : colorOf(i.lane)} />
            ))}
            {list.length > shown.length && (
              <button type="button" className="plus" onClick={() => onOpenDay(date)}>
                +{list.length - shown.length} more
              </button>
            )}
            {list.length === 0 && (
              <button type="button" className="add" onClick={() => onAdd(date)}>
                + Add
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** The phone's month: a grid of days with a dot per item, and the chosen day underneath. */
export function PhoneMonth({ first, cells, items, today, now, onOpen, colorOf }: MonthProps & { now: Date }) {
  const inMonth = (s: string) => dayOf(s)!.getMonth() === first.getMonth();
  const [chosen, setChosen] = useState(() => (inMonth(today) ? today : cells.find(inMonth)!));
  const day = dayOf(chosen)!;
  const list = itemsOn(items, chosen);
  return (
    <>
      <div className="pmo" role="grid" aria-label={`${longMonth(first)} ${first.getFullYear()}`}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, k) => (
          <div key={k} className="wd" aria-hidden="true">
            {d}
          </div>
        ))}
        {cells.map((date) => {
          const d = dayOf(date)!;
          const dots = itemsOn(items, date).slice(0, 3);
          return (
            <button
              key={date}
              type="button"
              className={`pc ${inMonth(date) ? "" : "out"} ${date < today ? "past" : ""} ${date === today ? "today" : ""} ${date === chosen ? "on" : ""}`}
              onClick={() => setChosen(date)}
              aria-label={`${LONG_WD[d.getDay()]} ${d.getDate()} ${longMonth(d)}`}
              aria-pressed={date === chosen}
            >
              <span>{d.getDate()}</span>
              <em>
                {dots.map((i) => (
                  <i key={i.id} className={i.kind === "key" ? "k" : i.kind === "ev" || i.kind === "fd" ? "e" : undefined} style={i.kind !== "key" && i.kind !== "ev" && i.kind !== "fd" && i.lane !== DATED_LANE ? { background: colorOf(i.lane) ?? undefined } : undefined} />
                ))}
              </em>
            </button>
          );
        })}
      </div>
      <div className="pday">
        <h2>
          {longWeekday(day)} {day.getDate()} {longMonth(day)}
          {chosen === today && <span>now {minutesLabel(now.getHours() * 60 + now.getMinutes())}</span>}
        </h2>
        {list.map((i) => (
          <TimeItem key={i.id} item={i} size="band" today={today} onOpen={onOpen} color={i.lane === DATED_LANE ? null : colorOf(i.lane)} />
        ))}
        {list.length === 0 && <p className="plan-pday-none">Nothing dated.</p>}
      </div>
    </>
  );
}
