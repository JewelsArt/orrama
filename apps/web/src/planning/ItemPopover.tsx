/**
 * What a time item opens in place, as R0's Popover (it was its own `cal-popup` with a
 * backdrop): booked time with its budget, length and Remove; your event with its name, length
 * and Delete; a subscribed calendar's occurrence, read-only; and a new event where you
 * double-clicked. Lengths step by half an hour or take a typed "1.5h".
 */
import { useMemo, useState, type RefObject } from "react";
import { parseDurationInput } from "../calendarMath.js";
import { Button } from "../ui/controls.js";
import { dateLabel, minutesLabel } from "../ui/dates.js";
import { Input } from "../ui/fields.js";
import { Popover } from "../ui/overlays.js";
import { hoursLabel, type Item } from "./model.js";
import { SNAP } from "./Hours.js";

export type Pop = { kind: "item"; item: Item; anchor: HTMLElement } | { kind: "new-event"; date: string; startMin: number; anchor: HTMLElement };

export interface PopActions {
  /** Change a block's or an event's length or name. */
  // Each says whether it landed: the popover closes only then, and keeps what was typed (WEB-010).
  patch: (item: Item, change: { durationMin?: number; title?: string }) => Promise<boolean>;
  remove: (item: Item) => Promise<boolean>;
  create: (date: string, startMin: number, durationMin: number, title: string) => Promise<boolean>;
  openStep: (item: Item, anchor: HTMLElement) => void;
  openNote: (noteId: string) => void;
}

function Length({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text === null) return;
    const v = parseDurationInput(text);
    setText(null);
    if (v !== null && v !== value) onChange(Math.max(SNAP, Math.round(v / 15) * 15));
  };
  return (
    <div className="plan-len" role="group" aria-label={label}>
      <Button size="sm" kind="quiet" onClick={() => onChange(Math.max(SNAP, value - SNAP))} aria-label="Half an hour shorter">
        −30m
      </Button>
      <Input
        aria-label="Length"
        value={text ?? hoursLabel(value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
      <Button size="sm" kind="quiet" onClick={() => onChange(value + SNAP)} aria-label="Half an hour longer">
        +30m
      </Button>
    </div>
  );
}

export function ItemPopover({ pop, onClose, actions }: { pop: Pop; onClose: () => void; actions: PopActions }) {
  const anchor = useMemo<RefObject<HTMLElement | null>>(() => ({ current: pop.anchor }), [pop.anchor]);
  const label = pop.kind === "new-event" ? "New event" : pop.item.title;
  return (
    <Popover anchor={anchor} onClose={onClose} label={label} className="popover plan-pop">
      {pop.kind === "new-event" ? <NewEvent pop={pop} onClose={onClose} actions={actions} /> : <ItemBody item={pop.item} anchor={pop.anchor} onClose={onClose} actions={actions} />}
    </Popover>
  );
}

function NewEvent({ pop, onClose, actions }: { pop: Extract<Pop, { kind: "new-event" }>; onClose: () => void; actions: PopActions }) {
  const [title, setTitle] = useState("");
  const [len, setLen] = useState(60);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      if (await actions.create(pop.date, pop.startMin, len, title.trim())) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="plan-pop-k">New event</div>
      <p className="plan-pop-meta">
        {dateLabel(pop.date)} · {minutesLabel(pop.startMin)}–{minutesLabel(Math.min(pop.startMin + len, 24 * 60))}
      </p>
      <Input
        autoFocus
        aria-label="Event title"
        placeholder="Meeting with…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          }
        }}
      />
      <Length value={len} onChange={setLen} label="Length" />
      <div className="plan-pop-acts">
        <Button kind="solid" size="sm" disabled={!title.trim() || busy} onClick={() => void add()}>
          Add event
        </Button>
      </div>
    </>
  );
}

function ItemBody({ item, anchor, onClose, actions }: { item: Item; anchor: HTMLElement; onClose: () => void; actions: PopActions }) {
  const [title, setTitle] = useState(item.title);
  const [len, setLen] = useState(item.durationMin);
  const ev = item.event;
  const editable = item.kind === "bk" || (!!ev && ev.mine && !ev.readonly);
  const when = `${dateLabel(item.date)}${item.startMin !== null && !item.allDay ? ` · ${minutesLabel(item.startMin)}–${minutesLabel(Math.min(item.startMin + len, 24 * 60))}` : " · all day"}`;
  const setLength = async (v: number) => {
    const was = len;
    setLen(v);
    if (!(await actions.patch(item, { durationMin: v }))) setLen(was);
  };

  if (item.kind === "bk" && item.task) {
    const t = item.task;
    const late = t.due !== null && item.date > t.due;
    return (
      <>
        <div className="plan-pop-k">Booked time</div>
        <h3>{t.text}</h3>
        <p className="plan-pop-meta">
          {when}
          {t.project && <> · {t.project}</>}
        </p>
        <div className="plan-pop-stats">
          <span>
            Estimate <b>{t.estimateHours}h</b>
          </span>
          <span>
            Booked <b>{t.scheduledHours}h</b>
          </span>
          <span>
            Left <b>{t.remainingHours}h</b>
          </span>
        </div>
        {t.due && (
          <p className={`plan-pop-meta ${late ? "late" : ""}`}>
            Due {dateLabel(t.due)}
            {late && ": this time lands after it"}
          </p>
        )}
        <Length value={len} onChange={(v) => void setLength(v)} label="Length" />
        <div className="plan-pop-acts">
          <Button size="sm" onClick={() => actions.openStep(item, anchor)}>
            Open the step
          </Button>
          <Button size="sm" kind="quiet" onClick={() => actions.openNote(t.noteId)}>
            {t.noteTitle}
          </Button>
          <Button
            size="sm"
            kind="quiet"
            danger
            onClick={() => void actions.remove(item).then((ok) => ok && onClose())}
          >
            Remove from calendar
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="plan-pop-k">{item.kind === "fd" || ev?.readonly ? "Subscribed calendar" : "Event"}</div>
      {editable ? (
        <Input
          aria-label="Event title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => {
            if (title.trim() && title !== item.title) void actions.patch(item, { title: title.trim() });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      ) : (
        <h3>{item.title}</h3>
      )}
      <p className="plan-pop-meta">
        {when} · {ev?.source === "ics" ? `${ev.feedLabel ?? "a feed"}, read-only` : "your calendar"}
      </p>
      {editable && (
        <>
          <Length value={len} onChange={(v) => void setLength(v)} label="Length" />
          <div className="plan-pop-acts">
            <Button
              size="sm"
              kind="quiet"
              danger
              onClick={() => void actions.remove(item).then((ok) => ok && onClose())}
            >
              Delete event
            </Button>
          </div>
        </>
      )}
    </>
  );
}
