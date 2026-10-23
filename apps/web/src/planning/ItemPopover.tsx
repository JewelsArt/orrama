/**
 * What a time item opens in place, as R0's Popover: booked time with its budget, its day and
 * times typed, and Remove; your event as it reads (when, how it repeats, place and notes, the
 * way a subscribed one shows its own), with Edit and Delete; a subscribed calendar's
 * occurrence, read-only, with its call, place and description; and a new event where you
 * double-clicked. One event form (`EventForm.tsx`) makes and changes events everywhere.
 *
 * A day of a repeating event saves and deletes as "This one" or "All" (Jules, 23 Oct 2026:
 * no "this and following"); a changed repeat can only be saved for all.
 */
import { useMemo, useState, type RefObject } from "react";
import { Button, LinkButton } from "../ui/controls.js";
import { dateLabel, minutesLabel } from "../ui/dates.js";
import { Popover } from "../ui/overlays.js";
import { cardDetails, type CardDetails } from "./details.js";
import { EventFields, repeatWords, useEventForm, useWhen, WhenFields, type EventValue } from "./EventForm.js";
import { type Item } from "./model.js";

export type Pop = { kind: "item"; item: Item; anchor: HTMLElement } | { kind: "new-event"; date: string; startMin: number; anchor: HTMLElement };

/** "this one" or "all", on a day of a repeating event; nothing on any other. */
export type Scope = "one" | "all";

export interface PopActions {
  /** Change a block's day and times, or an event. */
  // Each says whether it landed: the popover closes only then, and keeps what was typed (WEB-010).
  patch: (item: Item, change: Partial<EventValue>, scope?: Scope) => Promise<boolean>;
  remove: (item: Item, scope?: Scope) => Promise<boolean>;
  create: (event: EventValue) => Promise<boolean>;
  openStep: (item: Item, anchor: HTMLElement) => void;
  openNote: (noteId: string) => void;
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

/** Runs one write at a time; the popover closes when it lands. */
function useBusy(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await work()) onClose();
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

function NewEvent({ pop, onClose, actions }: { pop: Extract<Pop, { kind: "new-event" }>; onClose: () => void; actions: PopActions }) {
  const form = useEventForm({ date: pop.date, startMin: pop.startMin, durationMin: 60 });
  const { busy, run } = useBusy(onClose);
  const add = () => form.value && void run(() => actions.create(form.value!));
  return (
    <>
      <div className="plan-pop-k">New event</div>
      <EventFields form={form} onEnter={add} />
      <div className="plan-pop-acts">
        <Button kind="solid" size="sm" disabled={!form.value || busy} onClick={add}>
          Add event
        </Button>
      </div>
    </>
  );
}

function ItemBody({ item, anchor, onClose, actions }: { item: Item; anchor: HTMLElement; onClose: () => void; actions: PopActions }) {
  const ev = item.event;
  const when = `${dateLabel(item.date)}${item.startMin !== null && !item.allDay ? ` · ${minutesLabel(item.startMin)}–${minutesLabel(Math.min(item.startMin + item.durationMin, 24 * 60))}` : " · all day"}`;
  if (item.kind === "bk" && item.task) return <Booked item={item} anchor={anchor} onClose={onClose} actions={actions} when={when} />;
  if (ev && ev.mine && !ev.readonly && item.kind === "ev") return <OwnEvent item={item} onClose={onClose} actions={actions} when={when} />;
  return (
    <>
      <div className="plan-pop-k">Subscribed calendar</div>
      <h3>{item.title}</h3>
      <p className="plan-pop-meta">
        {when} · {ev?.feedLabel ?? "a feed"}, read-only
      </p>
      <Details details={cardDetails(ev)} />
    </>
  );
}

function Booked({ item, anchor, onClose, actions, when: whenText }: { item: Item; anchor: HTMLElement; onClose: () => void; actions: PopActions; when: string }) {
  const t = item.task!;
  const late = t.due !== null && item.date > t.due;
  const was = { date: item.date, startMin: item.startMin ?? 9 * 60, durationMin: item.durationMin };
  const when = useWhen(was);
  const { busy, run } = useBusy(onClose);
  const ok = !!when.date && !when.dayError && !when.startError && !when.endError;
  const save = () => ok && when.changedFrom(was) && void run(() => actions.patch(item, { date: when.date!, startMin: when.startMin!, durationMin: when.endMin! - when.startMin! }));
  return (
    <>
      <div className="plan-pop-k">Booked time</div>
      <h3>{t.text}</h3>
      <p className="plan-pop-meta">
        {whenText}
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
      <WhenFields when={when} onEnter={save} />
      <div className="plan-pop-acts">
        <Button size="sm" kind="solid" disabled={busy || !ok || !when.changedFrom(was)} onClick={save}>
          Save
        </Button>
        <Button size="sm" onClick={() => actions.openStep(item, anchor)}>
          Open the step
        </Button>
        <Button size="sm" kind="quiet" onClick={() => actions.openNote(t.noteId)}>
          {t.noteTitle}
        </Button>
        <Button size="sm" kind="quiet" danger disabled={busy} onClick={() => void run(() => actions.remove(item))}>
          Remove from calendar
        </Button>
      </div>
    </>
  );
}

function OwnEvent({ item, onClose, actions, when }: { item: Item; onClose: () => void; actions: PopActions; when: string }) {
  const ev = item.event!;
  const series = !!ev.seriesId;
  const [editing, setEditing] = useState(false);
  const { busy, run } = useBusy(onClose);
  const form = useEventForm({
    title: ev.title,
    date: item.date,
    startMin: ev.startMin,
    durationMin: ev.durationMin,
    allDay: !!ev.allDay,
    place: ev.details?.location ?? "",
    notes: ev.details?.description ?? "",
    repeat: ev.repeat ?? null,
  });
  const save = (scope?: Scope) => form.value && void run(() => actions.patch(item, form.value!, scope));

  if (editing) {
    return (
      <>
        <div className="plan-pop-k">{series ? "Edit · repeats" : "Edit event"}</div>
        <EventFields form={form} onEnter={series ? undefined : () => save()} />
        <div className="plan-pop-acts">
          {series ? (
            <>
              {!form.repeatChanged && (
                <Button size="sm" kind="solid" disabled={!form.value || busy} onClick={() => save("one")}>
                  Save this one
                </Button>
              )}
              <Button size="sm" kind={form.repeatChanged ? "solid" : undefined} disabled={!form.value || busy} onClick={() => save("all")}>
                Save all
              </Button>
            </>
          ) : (
            <Button size="sm" kind="solid" disabled={!form.value || busy} onClick={() => save()}>
              Save
            </Button>
          )}
          <Button size="sm" kind="quiet" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="plan-pop-k">Event</div>
      <h3>{ev.title}</h3>
      <p className="plan-pop-meta">{when} · your calendar</p>
      {ev.repeat && <p className="plan-pop-meta">{repeatWords(ev.repeat)}</p>}
      <Details details={cardDetails(ev)} />
      <div className="plan-pop-acts">
        <Button size="sm" kind="solid" icon="pen" onClick={() => setEditing(true)}>
          Edit
        </Button>
        {series ? (
          <>
            <Button size="sm" kind="quiet" danger disabled={busy} onClick={() => void run(() => actions.remove(item, "one"))}>
              Delete this one
            </Button>
            <Button size="sm" kind="quiet" danger disabled={busy} onClick={() => void run(() => actions.remove(item, "all"))}>
              Delete all
            </Button>
          </>
        ) : (
          <Button size="sm" kind="quiet" danger disabled={busy} onClick={() => void run(() => actions.remove(item))}>
            Delete event
          </Button>
        )}
      </div>
    </>
  );
}

/** Opens outside the app, never with this page as its opener. */
const OUT = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * An event's call, place and description, as text and http(s) links only: a subscribed
 * occurrence's from its feed, your own event's place and notes, one look for both.
 */
function Details({ details }: { details: CardDetails | null }) {
  if (!details) return null;
  const { join, place, lines, page } = details;
  return (
    <>
      {(join || page) && (
        <div className="plan-pop-acts">
          {join && (
            <LinkButton kind="solid" size="sm" href={join.href} {...OUT}>
              {join.label}
            </LinkButton>
          )}
          {page && (
            <LinkButton kind="quiet" size="sm" icon="ext" href={page.href} {...OUT}>
              {page.label}
            </LinkButton>
          )}
        </div>
      )}
      {place && (
        <p className="plan-pop-place">
          {place.kind === "map" ? (
            <a href={place.href} {...OUT} title="Open in Google Maps">
              {place.text}
            </a>
          ) : (
            place.parts.map((p, i) =>
              typeof p === "string" ? (
                p
              ) : (
                <a key={i} href={p.href} {...OUT} title={p.href}>
                  {p.label}
                </a>
              ),
            )
          )}
        </p>
      )}
      {lines.length > 0 && (
        <div className="plan-pop-desc">
          {lines.map((parts, i) => (
            <p key={i} className={parts.length === 0 ? "gap" : undefined}>
              {parts.map((p, j) =>
                typeof p === "string" ? (
                  p
                ) : (
                  <a key={j} href={p.href} {...OUT} title={p.href}>
                    {p.label}
                  </a>
                ),
              )}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
