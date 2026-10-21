/**
 * What is going on with someone (structure.md §2.6, "With Ines"): their unread and recent mail,
 * the coming four weeks' events that name them, and the open steps that name them. A company's
 * is the mail from its domains and the events that name it. Read from the same endpoints Today
 * reads; nothing is matched on a guess (a whole name, an exact address or domain).
 */
import type { CalEvent, DashboardTask, MailAccount } from "@orrama/schema/responses";
import { api } from "../api.js";
import { useTaskCard } from "../ProjectViews.js";
import { tickStep } from "../steps.js";
import { Checkbox } from "../ui/controls.js";
import { dateLabel, dateTimeLabel, minutesLabel } from "../ui/dates.js";
import { Icon } from "../ui/Icon.js";
import { Module, Row, RowList } from "../ui/layout.js";
import { navigate, routeHref } from "../ui/router.js";
import { anchor, linkTo } from "./links.js";
import { useLoad, type Load } from "./known.js";
import { activityOf, type InboxItem, type Who } from "./model.js";

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The lists activity is read from, asked once per page (mail only when an account is connected). */
export function useActivitySources(tick: number) {
  const today = new Date();
  const from = iso(today);
  const to = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 28));
  const tasks = useLoad((signal) => api<DashboardTask[]>("GET", "/api/tasks", undefined, { signal }), [tick]);
  const events = useLoad((signal) => api<CalEvent[]>("GET", `/api/events?from=${from}&to=${to}`, undefined, { signal }), [tick, from]);
  const account = useLoad((signal) => api<MailAccount>("GET", "/api/mail/account", undefined, { signal }), []);
  const connected = account.state === "ok" && account.data.connected;
  const inbox = useLoad(connected ? (signal) => api<{ messages: InboxItem[] }>("GET", "/api/mail/inbox", undefined, { signal }) : null, [connected]);
  return { tasks, events, inbox };
}

export type Sources = ReturnType<typeof useActivitySources>;

export type { Who };

const ok = <T,>(l: Load<T>): T | null => (l.state === "ok" ? l.data : null);
const boxOf = (s: DashboardTask["status"]) => (s === "done" ? "done" : s === "in-progress" ? "progress" : s === "blocked" ? "blocked" : "open");

export function ActivityModule({ title, sources, who, onChanged }: { title: string; sources: Sources; who: Who; onChanged: () => void }) {
  // The card's "from the note" opens the note, as everywhere else it is opened from.
  const card = useTaskCard(async () => onChanged(), (id) => navigate({ kind: "notes", id }));
  const a = activityOf({ tasks: ok(sources.tasks), events: ok(sources.events), mail: ok(sources.inbox)?.messages ?? null }, who);
  const loading = sources.tasks.state === "loading" || sources.events.state === "loading";
  const empty = a.mail.length + a.events.length + a.tasks.length === 0;
  if (loading || empty) return null;
  const tick = (t: DashboardTask) => tickStep(t, { notTicked: "The step wasn't ticked.", moved: "That step changed in its note since this page was drawn.", changed: onChanged });
  return (
    <Module title={title} className="ent-act">
      <RowList label={title}>
        {a.mail.map((m) => (
          <Row
            key={`m${m.uid}`}
            lead={<Icon name="mail" size={18} />}
            title={m.subject || "(no subject)"}
            meta={`${m.seen ? "" : "Unread · "}${m.date ? dateTimeLabel(new Date(m.date)) : ""}`}
            {...linkTo({ kind: "mail", id: String(m.uid) })}
          />
        ))}
        {a.events.map((e) => (
          <Row
            key={`e${e.id}${e.date}`}
            lead={<Icon name="calendar" size={18} />}
            title={e.title}
            meta={`${dateLabel(e.date)}${e.allDay ? "" : ` · ${minutesLabel(e.startMin)}`}${e.feedLabel ? ` · ${e.feedLabel}` : ""}`}
            {...linkTo({ kind: "planning", scale: "day", at: e.date })}
          />
        ))}
        {a.tasks.map((t) => (
          <div key={`t${t.noteId}:${t.line}`} className="row ent-task">
            <span className="lead">
              <Checkbox state={boxOf(t.status)} onToggle={() => void tick(t)} label={`Done: ${t.text}`} />
            </span>
            <a className="x" data-row="" title={t.text} {...anchor({ href: routeHref({ kind: "notes", id: t.noteId }), onOpen: () => void card.open(t) })}>
              <span className="t">{t.text}</span>
              <span className="m">
                {t.project ?? t.noteTitle}
                {t.due ? ` · due ${dateLabel(t.due)}` : ""}
              </span>
            </a>
          </div>
        ))}
      </RowList>
      {card.node}
    </Module>
  );
}
