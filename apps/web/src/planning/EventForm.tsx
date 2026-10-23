/**
 * One event form, wherever an event is made or changed: New → Event, a double-click in the
 * hours, and Edit in an event's popover. What, the day, when it starts and ends (or all day),
 * where, notes, and how it repeats. Days are typed the way the app reads them everywhere
 * ("Fri 16 Oct", "19/10", "tomorrow", `entity/dateInput.ts`), times as "9:30" or "1430"
 * (`parseTimeInput`), and nothing is sent until every field reads.
 *
 * `WhenFields` is the day and times alone, for booked time, which has no name of its own.
 */
import { useState } from "react";
import type { CalEvent } from "@orrama/schema/responses";
import { parseTimeInput } from "../calendarMath.js";
import { parseDateInput } from "../entity/dateInput.js";
import { dateLabel, minutesLabel } from "../ui/dates.js";
import { Field, Input, Select, Switch, Textarea } from "../ui/fields.js";

export type Repeat = NonNullable<CalEvent["repeat"]>;
type RepeatChoice = "none" | "week" | "2weeks" | "month" | "year";

/** An event as the API takes it (`POST`/`PATCH /api/events`). */
export interface EventValue {
  title: string;
  date: string;
  startMin: number;
  durationMin: number;
  allDay: boolean;
  place: string;
  notes: string;
  repeat: Repeat | null;
}

const choiceOf = (r: Repeat | null | undefined): RepeatChoice => (!r ? "none" : r.every === "week" ? (r.interval === 2 ? "2weeks" : "week") : r.every);
const repeatOf = (c: RepeatChoice, until: string | null): Repeat | null =>
  c === "none" ? null : c === "2weeks" ? { every: "week", interval: 2, until } : { every: c, interval: 1, until };

/** "Every week until Thu 31 Dec", "Every 2 weeks", "Every month": how a series is said. */
export function repeatWords(r: Repeat): string {
  const every = r.interval === 1 ? `Every ${r.every}` : `Every ${r.interval} ${r.every}s`;
  return r.until ? `${every} until ${dateLabel(r.until)}` : every;
}

/** End of a typed end time: "0:00" or "24:00" after a start is midnight. */
const endOf = (text: string, start: number | null): number | null => {
  if (/^\s*24(:00)?\s*$/.test(text)) return 24 * 60;
  const v = parseTimeInput(text);
  if (v === 0 && start !== null && start > 0) return 24 * 60;
  return v;
};

/** A day and a start and end, typed; what they read as, and what is wrong with them. */
export function useWhen(init: { date: string; startMin: number; durationMin: number }) {
  const [day, setDay] = useState(dateLabel(init.date));
  const [start, setStart] = useState(minutesLabel(init.startMin));
  const [end, setEnd] = useState(minutesLabel(Math.min(init.startMin + init.durationMin, 24 * 60)));
  const date = parseDateInput(day);
  const startMin = parseTimeInput(start);
  const endMin = endOf(end, startMin);
  const said = date ? dateLabel(date) : null;
  return {
    day,
    setDay,
    start,
    setStart,
    end,
    setEnd,
    date: date || null,
    startMin,
    endMin,
    /** Said back only when it reads differently from what was typed ("fri" → "Fri 16 Oct"). */
    dayHelp: said && said !== day.trim() ? said : undefined,
    dayError: date === "" ? "Give it a day" : date === null ? "Not a date yet: try 19 Oct" : null,
    startError: startMin === null ? "A time, like 9:30" : null,
    endError: endMin === null ? "A time, like 11:00" : startMin !== null && endMin <= startMin ? "After it starts" : null,
    changedFrom: (was: { date: string; startMin: number; durationMin: number }) =>
      (!!date && date !== was.date) || (startMin !== null && startMin !== was.startMin) || (startMin !== null && endMin !== null && endMin - startMin !== was.durationMin),
  };
}
export type When = ReturnType<typeof useWhen>;

/** Day, Starts, Ends, side by side. `times` false hides the two times (all day). */
export function WhenFields({ when, times = true, onEnter }: { when: When; times?: boolean; onEnter?: () => void }) {
  const enter = onEnter
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }
    : undefined;
  return (
    <div className={`ev-when${times ? "" : " one"}`}>
      <Field label="Day" help={when.dayHelp} error={when.dayError}>
        <Input value={when.day} onChange={(e) => when.setDay(e.target.value)} onKeyDown={enter} placeholder="Fri 16 Oct" />
      </Field>
      {times && (
        <>
          <Field label="Starts" error={when.startError}>
            <Input value={when.start} onChange={(e) => when.setStart(e.target.value)} onKeyDown={enter} inputMode="numeric" />
          </Field>
          <Field label="Ends" error={when.endError}>
            <Input value={when.end} onChange={(e) => when.setEnd(e.target.value)} onKeyDown={enter} inputMode="numeric" />
          </Field>
        </>
      )}
    </div>
  );
}

/** The whole event form's state, from an event (or a slot) to start from. */
export function useEventForm(init: Partial<EventValue> & { date: string; startMin: number; durationMin: number }) {
  const when = useWhen(init.allDay ? { date: init.date, startMin: 9 * 60, durationMin: 60 } : init);
  const [title, setTitle] = useState(init.title ?? "");
  const [allDay, setAllDay] = useState(!!init.allDay);
  const [place, setPlace] = useState(init.place ?? "");
  const [notes, setNotes] = useState(init.notes ?? "");
  const [choice, setChoice] = useState<RepeatChoice>(choiceOf(init.repeat));
  const [untilText, setUntilText] = useState(init.repeat?.until ? dateLabel(init.repeat.until) : "");
  const until = parseDateInput(untilText);
  const untilError = until === null ? "Not a date yet: try 31 Dec" : until && when.date && until < when.date ? "After the first day" : null;
  const repeat = repeatOf(choice, until || null);
  const ok = !!title.trim() && !!when.date && !when.dayError && (allDay || (!when.startError && !when.endError)) && (choice === "none" || !untilError);
  const value: EventValue | null = ok
    ? {
        title: title.trim(),
        date: when.date!,
        startMin: allDay ? 0 : when.startMin!,
        durationMin: allDay ? 24 * 60 : when.endMin! - when.startMin!,
        allDay,
        place: place.trim(),
        notes: notes.trim(),
        repeat,
      }
    : null;
  /** Whether the repeat itself was changed: then only "all" can be saved. */
  const repeatChanged = JSON.stringify(repeat) !== JSON.stringify(init.repeat ?? null);
  return { when, title, setTitle, allDay, setAllDay, place, setPlace, notes, setNotes, choice, setChoice, untilText, setUntilText, untilError, value, repeatChanged };
}
export type EventForm = ReturnType<typeof useEventForm>;

/** The fields. `onEnter` submits from a one-line field. */
export function EventFields({ form, onEnter, autoFocus = true }: { form: EventForm; onEnter?: () => void; autoFocus?: boolean }) {
  const f = form;
  const enter = onEnter
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }
    : undefined;
  return (
    <div className="ev-form">
      <Field label="What">
        <Input autoFocus={autoFocus} data-autofocus value={f.title} onChange={(e) => f.setTitle(e.target.value)} onKeyDown={enter} placeholder="Meeting with…" maxLength={140} />
      </Field>
      <WhenFields when={f.when} times={!f.allDay} onEnter={onEnter} />
      <label className="ev-switch">
        <Switch checked={f.allDay} onChange={f.setAllDay} label="All day" />
        <span>All day</span>
      </label>
      <Field label="Place">
        <Input value={f.place} onChange={(e) => f.setPlace(e.target.value)} onKeyDown={enter} placeholder="An address, a room" maxLength={300} />
      </Field>
      <Field label="Notes">
        <Textarea value={f.notes} onChange={(e) => f.setNotes(e.target.value)} rows={3} maxLength={4000} />
      </Field>
      <div className={`ev-repeat${f.choice === "none" ? " one" : ""}`}>
        <Field label="Repeats">
          <Select value={f.choice} onChange={(e) => f.setChoice(e.target.value as RepeatChoice)}>
            <option value="none">Doesn't repeat</option>
            <option value="week">Every week</option>
            <option value="2weeks">Every 2 weeks</option>
            <option value="month">Every month</option>
            <option value="year">Every year</option>
          </Select>
        </Field>
        {f.choice !== "none" && (
          <Field label="Until" help={f.untilText.trim() ? undefined : "Empty: for ever"} error={f.untilError}>
            <Input value={f.untilText} onChange={(e) => f.setUntilText(e.target.value)} onKeyDown={enter} placeholder="31 Dec" />
          </Field>
        )}
      </div>
    </div>
  );
}
