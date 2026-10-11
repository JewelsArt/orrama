/**
 * Dates as text (structure.md §2.5): "31 Aug – 19 Jan", and a click opens the two dates as
 * typed fields under it. A field writes when it is left or Enter is pressed, never while it is
 * typed in, and only a real date from 1900 on (or nothing, to clear it); what it would write is
 * said under it as you type (WEB-023). Closing the box (Escape, a click away) counts as leaving.
 */
import { useEffect, useId, useRef, useState } from "react";
import { dateLabel, dayMonthLabel } from "../ui/dates.js";
import { Popover } from "../ui/overlays.js";
import { parseDateInput } from "./dateInput.js";

export interface DateSlot {
  key: string;
  label: string;
  value: string;
}

/** "31 Aug – 19 Jan"; one end alone says which it is. */
export function rangeLabel(start: string, end: string): string {
  const s = start ? dayMonthLabel(start) : "";
  const e = end ? dayMonthLabel(end) : "";
  if (s && e) return `${s} – ${e}`;
  if (e) return `until ${e}`;
  if (s) return `from ${s}`;
  return "";
}

export function DatesButton({
  slots,
  canEdit,
  onCommit,
  empty = "Add dates",
}: {
  slots: [DateSlot, DateSlot];
  canEdit: boolean;
  onCommit: (key: string, value: string) => Promise<unknown>;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  const text = rangeLabel(slots[0].value, slots[1].value);
  if (!canEdit) return text ? <span>{text}</span> : null;
  return (
    <>
      <button ref={at} type="button" className="ent-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {text || empty}
      </button>
      {open && (
        <Popover anchor={at} label="Dates" onClose={() => setOpen(false)} className="popover ent-dates">
          {slots.map((s) => (
            <DateField key={s.key} slot={s} onCommit={(v) => onCommit(s.key, v)} />
          ))}
        </Popover>
      )}
    </>
  );
}

function DateField({ slot, onCommit }: { slot: DateSlot; onCommit: (v: string) => Promise<unknown> }) {
  const id = useId();
  const [text, setText] = useState(slot.value ? dateLabel(slot.value) : "");
  const parsed = parseDateInput(text);
  const sent = useRef(slot.value);
  const commit = () => {
    if (parsed === null || parsed === sent.current) return;
    sent.current = parsed;
    void onCommit(parsed).catch(() => {
      sent.current = slot.value;
    });
  };
  // Closing the box unmounts the field, sometimes before its blur arrives: leave it then.
  const last = useRef(commit);
  last.current = commit;
  useEffect(() => () => last.current(), []);
  return (
    <div className="field ent-date">
      <label htmlFor={id}>{slot.label}</label>
      <input
        id={id}
        className="inp"
        value={text}
        placeholder="e.g. 19 Jan 2027"
        aria-invalid={parsed === null ? "true" : undefined}
        aria-describedby={`${id}-say`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span id={`${id}-say`} className={parsed === null ? "err" : "help"}>
        {parsed === null ? "Not a date yet: try 19 Jan 2027" : parsed === "" ? "No date" : dateLabel(parsed)}
      </span>
    </div>
  );
}
