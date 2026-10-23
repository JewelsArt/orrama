/**
 * A time item (structure.md §6 #16, the card form): one look per kind, the same in the lanes,
 * the hours and the month. Every item is a button that opens what it is (§1.7 #3); booked
 * time, your events and due steps can also be dragged to another day.
 */
import type { CSSProperties, DragEvent, MouseEvent, PointerEvent } from "react";
import { minutesLabel } from "../ui/dates.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { dueWords, money, type Item } from "./model.js";

export type ItemSize = "card" | "s" | "band";

/** Can this item be moved? Booked time, your own events, and a due step (its `due:` moves). */
export const movable = (i: Item) => i.kind === "bk" || (i.kind === "ev" && !!i.event?.mine && !i.event.readonly) || ((i.kind === "du" || i.kind === "key") && !!i.marker?.noteId && i.marker.line !== null);

/** The drag payload: which item, by its id in the current list. */
export const ITEM_MIME = "application/x-orrama-item";

const span = (i: Item) => (i.startMin === null ? "" : i.durationMin > 0 ? `${minutesLabel(i.startMin)}–${minutesLabel(Math.min(i.startMin + i.durationMin, 24 * 60))}` : minutesLabel(i.startMin));

/** The small line under an item's title, by kind (the board's wording). */
export function itemSub(i: Item, today: string, now: number | null): string {
  switch (i.kind) {
    case "bk":
      return now !== null ? `${span(i)} · now` : span(i);
    case "pp":
      return `${span(i)} · proposed`;
    case "ev":
    case "fd":
      return i.allDay ? "all day" : [i.startMin !== null ? minutesLabel(i.startMin) : "", i.kind === "fd" ? i.project : ""].filter(Boolean).join(" · ");
    case "du": {
      const w = dueWords(i.date, today);
      const left = i.task && i.task.remainingHours > 0 ? `${i.task.remainingHours}h left` : "";
      if (w?.late) return [w.text, i.project].filter(Boolean).join(" · ");
      return [i.date === today ? "due today" : "due", left].filter(Boolean).join(" · ");
    }
    case "key":
    case "ms":
      return i.project ?? (i.kind === "key" ? "key deadline" : "milestone");
    case "mn":
      return "";
  }
}

export function TimeItem({
  item,
  size = "card",
  today,
  nowMin,
  style,
  onOpen,
  onDragStart,
  className,
  color,
  onPointerDown,
  resizable,
}: {
  item: Item;
  size?: ItemSize;
  today: string;
  /** Minutes since midnight now, when today is the item's day: marks the current block. */
  nowMin?: number | null;
  style?: CSSProperties;
  onOpen: (item: Item, el: HTMLElement) => void;
  onDragStart?: (item: Item, e: DragEvent<HTMLElement>) => void;
  className?: string;
  /** The item's life area colour: booked time's edge, a due diamond's outline. */
  color?: string | null;
  /** The hour grid's own move and resize. */
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  /** Draw the handle at the foot that stretches it (the hour grid). */
  resizable?: boolean;
}) {
  const i = item;
  const cur = i.kind === "bk" && i.date === today && nowMin != null && i.startMin !== null && nowMin >= i.startMin && nowMin < i.startMin + i.durationMin;
  const kind = i.kind === "ms" ? "du" : i.kind;
  // A subscribed calendar drawn in the colour picked for it in Settings → Connections.
  const feedTint = i.kind === "fd" && i.event?.color ? `var(--${i.event.color})` : null;
  const cls = ["tm", kind, i.late && "late", cur && "cur", size === "s" && "s", feedTint && "tinted", className].filter(Boolean).join(" ");
  const tint = feedTint ?? color;
  const laneStyle = tint ? ({ "--lane": tint } as CSSProperties) : undefined;
  const click = (e: MouseEvent<HTMLElement>) => onOpen(i, e.currentTarget);
  const drag = movable(i) && onDragStart ? { draggable: true, onDragStart: (e: DragEvent<HTMLElement>) => onDragStart(i, e) } : {};
  const label = `${i.title}${i.kind === "key" ? ", key deadline" : i.kind === "pp" ? ", proposed by Orr" : i.late ? ", late" : ""}`;

  if (i.kind === "mn") {
    return (
      <button type="button" className={cls} style={style} onClick={click} title={i.project ?? undefined}>
        <span>{i.title}</span>
        <span>{money(i.amount ?? 0, i.currency)}</span>
      </button>
    );
  }
  // In a month cell or the dated band, a timed item leads with its time ("09:30 Kade standup").
  const lead = size !== "card" && i.startMin !== null && i.kind !== "du" && i.kind !== "key" ? `${minutesLabel(i.startMin)} ` : "";
  const sub = size === "card" ? itemSub(i, today, cur ? (nowMin ?? null) : null) : "";
  return (
    <button type="button" className={cls} style={{ ...laneStyle, ...style }} onClick={click} onPointerDown={onPointerDown} aria-label={label} title={i.kind === "pp" ? "Proposed by Orr: click to leave it out" : undefined} {...drag}>
      {i.kind === "pp" && <HeadMark size={14} />}
      <b>
        {lead}
        {i.title}
      </b>
      {sub && <small>{sub}</small>}
      {resizable && <span className="plan-resize" aria-hidden="true" />}
    </button>
  );
}
