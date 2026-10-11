/**
 * The timetable (structure.md §2.1, §6 #13): Now and Next on one line, the hour track whose
 * window follows the day, the orange now line with its dot, Orr standing at its foot on the
 * present minute, the line dotted behind him and solid ahead, past items at half strength.
 * Every item opens what it is (§1.7 #3): a booked block its task card, an event its day in
 * Planning.
 */
import type { MouseEvent } from "react";
import { Orr, type OrrPose } from "../ui/orr/Orr.js";
import { LinkButton } from "../ui/controls.js";
import { minutesLabel } from "../ui/dates.js";
import { nowAndNext, placeOn, windowFor, type DayItem } from "./day.js";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;
const KIND_CLASS = { block: "bk", event: "ev", feed: "fd" } as const;
const KIND_WORD = { block: "Booked", event: "Event", feed: "Calendar" } as const;

export interface Link {
  href: string;
  onOpen: () => void;
}

export function Timetable({
  items,
  now,
  pose,
  open,
  project,
  colour,
  firstSteps,
}: {
  items: DayItem[];
  /** Minutes past midnight. */
  now: number;
  pose: OrrPose;
  /** Where an item leads. */
  open: (it: DayItem) => Link;
  /** A block's project, as a link (the name opens its thing). */
  project: (it: DayItem) => (Link & { name: string }) | null;
  /** A block's life-area colour, for its dot. */
  colour: (it: DayItem) => string | null;
  /** The empty day's two first steps. */
  firstSteps: { date: Link; calendar: Link };
}) {
  const win = windowFor(items, now);
  const at = placeOn(win, now);
  const { current, next } = nowAndNext(items, now);
  const hours: number[] = [];
  for (let h = win.from / 60; h <= win.to / 60; h++) hours.push(h);
  const follow = (l: Link) => (e: MouseEvent) => {
    if (!plainClick(e)) return;
    e.preventDefault();
    l.onOpen();
  };
  const proj = current ? project(current) : null;

  return (
    <section className={`tt${items.length === 0 ? " tt-open" : ""}`} aria-label="Today, hour by hour">
      <div className="tt-top">
        {items.length === 0 ? (
          <>
            <div className="tt-now">
              <b>An open day.</b>
              <span>Nothing is booked today.</span>
            </div>
            <div className="tt-steps">
              <LinkButton size="sm" href={firstSteps.date.href} onClick={follow(firstSteps.date)}>
                Add a date to a task
              </LinkButton>
              <LinkButton size="sm" kind="quiet" href={firstSteps.calendar.href} onClick={follow(firstSteps.calendar)}>
                Connect a calendar
              </LinkButton>
            </div>
          </>
        ) : (
          <>
            <div className="tt-now">
              <span className="k">Now</span>
              {current ? (
                <>
                  <a className="tt-title" href={open(current).href} onClick={follow(open(current))}>
                    <b className="nm">{current.title}</b>
                  </a>
                  <span>
                    until {minutesLabel(current.end)}
                    {proj && (
                      <>
                        {" · "}
                        <a className="ui-nm" href={proj.href} onClick={follow(proj)}>
                          {proj.name}
                        </a>
                      </>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <b>Free</b>
                  <span>{next ? `until ${minutesLabel(next.start)}` : "for the rest of the day"}</span>
                </>
              )}
            </div>
            {next && (
              <div className="tt-next">
                Next{" "}
                <a className="tt-title" href={open(next).href} onClick={follow(open(next))}>
                  <b>{next.title}</b>
                </a>{" "}
                {minutesLabel(next.start)}
              </div>
            )}
          </>
        )}
      </div>
      <div className="tt-track">
        {items.map((it) => {
          const l = open(it);
          const past = it.end <= now;
          const cur = it.start <= now && now < it.end;
          const dot = it.kind === "block" ? colour(it) : null;
          const when = `${minutesLabel(it.start)}–${minutesLabel(it.end)}`;
          return (
            <a
              key={it.id}
              className={`it ${KIND_CLASS[it.kind]}${past ? " past" : ""}${cur ? " cur" : ""}`}
              style={{ left: pct(placeOn(win, it.start)), width: pct(Math.max(placeOn(win, it.end) - placeOn(win, it.start), 0.008)) }}
              href={l.href}
              title={`${it.title} · ${when}`}
              aria-label={`${KIND_WORD[it.kind]}: ${it.title}, ${when}${past ? ", past" : cur ? ", now" : ""}`}
              onClick={follow(l)}
            >
              {dot && <i style={{ background: dot }} />}
              <span>{it.title}</span>
            </a>
          );
        })}
        <div className="nowline" style={{ left: pct(at) }} />
        <div className="lp" style={{ width: pct(at) }} />
        <div className="la" style={{ left: pct(at) }} />
        <div className="tt-orr" style={{ left: pct(at) }} data-pose={pose}>
          <Orr pose={pose} size={46} label={`Orr, ${pose}`} />
        </div>
        <span className={`tnow${at > 0.9 ? " before" : ""}`} style={{ left: pct(at) }}>
          {minutesLabel(now)}
        </span>
        <div className="hrs" aria-hidden="true">
          {hours.map((h) => (
            <span key={h} data-h={h}>
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
