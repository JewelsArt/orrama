/**
 * Commitments and income (`/money/subscriptions`, `/money/income`): the same page twice, because
 * they are the same shape of thing — a name, an amount, a rhythm — and the only difference is
 * which way the money goes. The month's calendar (`?month=`), then every line, longest-running
 * first. Commitments adds what looks recurring; income adds the payslips.
 *
 * "Commitments" rather than "Subscriptions" inside the page: the note holds rent and tuition too,
 * and it is the word the savings plan uses for what only a cancellation changes. The tab keeps the
 * board's word.
 */
import { monthKey, shiftMonth } from "@orrama/core/dates";
import type { FinanceData, Ledger, MoneyItem, PayslipRow, Recurring } from "@orrama/schema/responses";
import { Button, NameLink } from "../ui/controls.js";
import { Switch } from "../ui/fields.js";
import { navigate } from "../ui/router.js";
import { Notice } from "../ui/states.js";
import { chargeDays, dayLabel, eur, monthLong, monthName, perCurrency, plural } from "./format.js";
import { useMonthKeys } from "./hooks.js";
import { link, to } from "./links.js";
import { recurringKey, recurringRow } from "./model.js";
import type { EditReq } from "./writes.js";
import { Found } from "./Overview.js";
import { readKey, writeKey } from "../storage.js";
import { useState } from "react";

export const LEDGER_LABEL = { subscriptions: "Commitments", income: "Income" } as const;

/** Remembered so the switch does not reset every time the page is opened. */
const OVERLAY_KEY = "orrama-fin-overlay";

export function LedgerPage({
  kind,
  d,
  month: asked,
  onOpenNote,
  onRead,
  dismissed,
  onDismiss,
  onUndismiss,
  onAdd,
  adding,
  onEdit,
}: {
  kind: "subscriptions" | "income";
  d: FinanceData;
  month?: string;
  onOpenNote: (id: string) => void;
  onRead: (file: string) => void;
  dismissed: Set<string>;
  onDismiss: (r: Recurring) => void;
  onUndismiss: (r: Recurring) => void;
  onAdd: (r: Recurring) => void;
  adding: string | null;
  onEdit: (r: EditReq) => void;
}) {
  const [both, setBoth] = useState(() => readKey(OVERLAY_KEY) === "1");
  const month = asked && /^\d{4}-\d{2}$/.test(asked) ? asked : monthKey(new Date());
  const go = (m: string) => navigate(to.page(kind, m === monthKey(new Date()) ? undefined : m), { replace: true });
  useMonthKeys(shiftMonth(month, -1), shiftMonth(month, 1), go);

  const income = kind === "income";
  const other = income ? "subscriptions" : "income";
  const ledger = d[kind];
  const otherLedger = d[other];
  const noteId = income ? d.notes.income : d.notes.subscriptions;
  const dueIn = (items: MoneyItem[]) => items.reduce((a, m) => a + chargeDays(month, m.anchor, m.cadence).length * m.amount, 0);
  const dueThis = dueIn(ledger.items);
  const dueOther = dueIn(otherLedger.items);
  /**
   * Where a ledger line leads: the shop the bank calls it. Null when the statement has never
   * seen the line (paid to a friend, say), and the line is then not a link: a dead link is worse
   * than a row that plainly is not one.
   */
  const merchantFor = (m: MoneyItem): string | null => ledger.activity[m.service]?.merchants[0] ?? otherLedger.activity[m.service]?.merchants[0] ?? null;
  const series: CalSeries[] = [{ items: ledger.items, direction: income ? "in" : "out" }, ...(both ? [{ items: otherLedger.items, direction: (income ? "out" : "in") as "in" | "out" }] : [])];
  // Longest-running first: two years of paying for something is a different decision from last month's.
  const lines = [...ledger.items].sort((a, b) => (ledger.activity[b.service]?.months ?? 0) - (ledger.activity[a.service]?.months ?? 0) || b.monthly - a.monthly);

  return (
    <>
      <UnreadableRows ledger={ledger} noteId={noteId} onOpenNote={onOpenNote} onFix={(line) => onEdit({ kind: "line", ledger: kind, line })} />

      <section className="mod" aria-label={`${LEDGER_LABEL[kind]}, ${monthLong(month)}`}>
        <div className="mh mcalh">
          <h2>{monthLong(month)}</h2>
          <span className="c">
            <b>
              {income ? "+" : "−"}
              {eur(dueThis)}
            </b>
            {both && (
              <>
                {" "}
                <b>
                  {income ? "−" : "+"}
                  {eur(dueOther)}
                </b>{" "}
                · net {eur(income ? dueThis - dueOther : dueOther - dueThis)}
              </>
            )}
          </span>
          <span className="msp" />
          {/* Beside the month, not the page title: what it changes is this calendar. */}
          <label className="mswitch">
            <Switch
              checked={both}
              onChange={(on) => {
                setBoth(on);
                writeKey(OVERLAY_KEY, on ? "1" : "0");
              }}
              label={`Show ${LEDGER_LABEL[other].toLowerCase()}`}
            />
            <span>Show {LEDGER_LABEL[other].toLowerCase()}</span>
          </label>
          <div className="mnav">
            <Button size="sm" icon="chev-l" aria-label="Previous month" tip="Previous month  ←" data-tip-at="top" onClick={() => go(shiftMonth(month, -1))} />
            <Button size="sm" onClick={() => go(monthKey(new Date()))}>
              Today
            </Button>
            <Button size="sm" icon="chev-r" aria-label="Next month" tip="Next month  →" data-tip-at="top" onClick={() => go(shiftMonth(month, 1))} />
          </div>
        </div>
        {ledger.count > 0 ? (
          <ChargeCalendar month={month} series={series} merchantFor={merchantFor} />
        ) : (
          <p className="q3">Nothing recorded yet.</p>
        )}
      </section>

      {!income && d.recurring.length > 0 && (
        <section className="mod" aria-label="Looks recurring">
          <div className="mh">
            <h2>Looks recurring</h2>
            <span className="c">{d.recurring.length} not in your commitments</span>
          </div>
          <p className="q3">The same amount, on a rhythm, from a shop none of your commitments claims.</p>
          {d.recurring.map((r) => {
            const off = dismissed.has(recurringKey(r));
            if (r.active && !off)
              return <Found key={recurringKey(r)} r={r} canAdd={recurringRow(r, null) !== null} busy={adding === r.merchant} onAdd={() => onAdd(r)} onDismiss={() => onDismiss(r)} />;
            // A row, not a link: Undo sits in it, and a button inside a link is no button. The
            // shop's name is the way to the shop.
            return (
              <div key={recurringKey(r)} className="row mline static">
                <span className="x">
                  <span className="t">
                    <NameLink href={link(to.merchant(r.merchant)).href} onOpen={() => navigate(to.merchant(r.merchant))}>
                      {r.merchant}
                    </NameLink>
                  </span>
                  <span className="m">
                    {r.cadence ?? `every ${r.everyMonths} months`} · {monthName(r.first)} to {monthName(r.last)}
                    {!r.active && <em>stopped</em>}
                    {off && <em>you said it isn't recurring</em>}
                  </span>
                </span>
                <span className="end">
                  {off && (
                    <Button size="sm" kind="quiet" onClick={() => onUndismiss(r)}>
                      Undo
                    </Button>
                  )}
                  <span className="r">
                    <b>{eur(r.amount)}</b>
                    <span>{eur(r.total)} so far</span>
                  </span>
                </span>
              </div>
            );
          })}
        </section>
      )}

      <section className="mod" aria-label={`Every ${income ? "source" : "commitment"}`}>
        <div className="mh">
          <h2>{income ? "Every source" : "Every commitment"}</h2>
          <span className="c">
            {plural(ledger.count, income ? "source" : "line")} · {perCurrency(ledger.totals)} a month
          </span>
          <span className="msp" />
          <Button size="sm" icon="plus" onClick={() => onEdit({ kind: "line", ledger: kind })}>
            {income ? "Add income" : "Add a commitment"}
          </Button>
        </div>
        {lines.length === 0 && <p className="q3">Nothing recorded yet. Rent, a gym, a phone plan: anything that comes back.</p>}
        {lines.map((m) => (
          <Line key={`${m.line}-${m.service}`} m={m} ledger={ledger} onOpen={() => onEdit({ kind: "line", ledger: kind, line: m.line, shop: merchantFor(m) })} />
        ))}
        {noteId && <OpenNote id={noteId} onOpenNote={onOpenNote} />}
      </section>

      {income && <Payslips d={d} onEdit={onEdit} onOpenNote={onOpenNote} onRead={onRead} />}
    </>
  );
}

/** "Open the note": the quiet way into the table itself, never the only one. */
function OpenNote({ id, onOpenNote }: { id: string; onOpenNote: (id: string) => void }) {
  return (
    <a
      className="mquiet"
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onOpenNote(id);
      }}
    >
      Open the note
    </a>
  );
}

/** One ledger line: what it costs, how long it has run, and what the statement saw of it. It opens its sheet. */
function Line({ m, ledger, onOpen }: { m: MoneyItem; ledger: Ledger; onOpen: () => void }) {
  const act = ledger.activity[m.service];
  // What arrived, against what was expected to. A catch-up payment is real money and not a
  // raise, so it is named as extra rather than averaged into the figure above (FIN-004).
  const extra = act ? Math.round((act.total - act.expected) * 100) / 100 : 0;
  const body = (
    <>
      <span className="x">
        <span className="t">{m.service}</span>
        <span className="m">
          {m.cadence}
          {m.cadence !== "monthly" && <> · {eur(m.monthly)} a month</>}
          {act && act.months > 0 ? (
            <>
              {" · "}
              {plural(act.months, "month")} · {eur(act.total)} so far · since {monthName(act.first!.slice(0, 7))}
            </>
          ) : (
            " · not seen on the statement yet"
          )}
          {m.next && <> · next {dayLabel(m.next)}</>}
        </span>
        {act && act.months > 0 && (
          <span className="mrun" aria-hidden>
            {act.seen.slice(-18).map((mo) => (
              <i key={mo} title={monthName(mo)} />
            ))}
          </span>
        )}
        {act && Math.abs(extra) >= 1 && <span className="m">{extra > 0 ? `${eur(extra)} more than the ${eur(act.expected)} expected` : `${eur(-extra)} short of the ${eur(act.expected)} expected`}</span>}
        {m.note && <span className="m">{m.note}</span>}
      </span>
      <span className="r">{eur(m.amount, m.currency)}</span>
    </>
  );
  return (
    <button type="button" className="row mline" onClick={onOpen} aria-label={`${m.service}, ${eur(m.amount, m.currency)} ${m.cadence}: change or remove`}>
      {body}
    </button>
  );
}

/** One side of the money on the calendar: a set of ledger lines, and its sign. */
interface CalSeries {
  items: MoneyItem[];
  direction: "in" | "out";
}

/**
 * One month of a ledger as a calendar. A list of "next charge" dates says nothing about the
 * shape of a month; a grid says at once that four things land on the 1st and nothing else until
 * the 14th. Two ledgers share the grid without being merged: in and out keep their own sign and
 * subtotal on a day — netting them would hide that the 25th is heavy both ways.
 */
function ChargeCalendar({ month, series, merchantFor }: { month: string; series: CalSeries[]; merchantFor: (m: MoneyItem) => string | null }) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first, as a European statement reads
  const byDay = new Map<number, MoneyItem[][]>();
  series.forEach((s, si) => {
    for (const it of s.items)
      for (const day of chargeDays(month, it.anchor, it.cadence)) {
        const at = byDay.get(day) ?? series.map(() => []);
        at[si] = [...at[si]!, it];
        byDay.set(day, at);
      }
  });
  const sum = (list: MoneyItem[]) => list.reduce((a, m) => a + m.amount, 0);
  const today = new Date();
  const todayN = monthKey(today) === month ? today.getDate() : 0;

  return (
    <div className="mcal" role="grid" aria-label={monthLong(month)}>
      <div className="mcal-head" role="row">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d} role="columnheader">
            {d}
          </span>
        ))}
      </div>
      <div className="mcal-grid">
        {Array.from({ length: lead }, (_, i) => (
          <div key={`pad${i}`} className="mcal-day pad" />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const day = i + 1;
          const buckets = byDay.get(day) ?? [];
          const any = buckets.some((b) => b.length > 0);
          return (
            <div key={day} role="gridcell" className={`mcal-day ${any ? "on" : ""} ${day === todayN ? "today" : ""}`}>
              <span className="n">{day}</span>
              {any && (
                <>
                  <span className="sums">
                    {buckets.map((bucket, si) =>
                      bucket.length === 0 ? null : (
                        <em key={series[si]!.direction} className={series[si]!.direction}>
                          {series[si]!.direction === "in" ? "+" : "−"}
                          {eur(sum(bucket))}
                        </em>
                      ),
                    )}
                  </span>
                  <ul>
                    {buckets.flatMap((bucket, si) =>
                      bucket.slice(0, 3).map((m) => {
                        const shop = merchantFor(m);
                        const label = `${m.service} · ${series[si]!.direction === "in" ? "+" : "−"}${eur(m.amount, m.currency)}`;
                        return (
                          <li key={`${series[si]!.direction}-${m.service}`} className={series[si]!.direction}>
                            {shop ? (
                              <a title={label} {...link(to.merchant(shop))}>
                                {m.service}
                              </a>
                            ) : (
                              <span title={label}>{m.service}</span>
                            )}
                          </li>
                        );
                      }),
                    )}
                    {buckets.some((b) => b.length > 3) && <li className="more">+{buckets.reduce((a, b) => a + Math.max(0, b.length - 3), 0)} more</li>}
                  </ul>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The rows a ledger left out of its totals, by name, line and cell: a row the parser cannot read must not simply vanish from the sum (FIN-005/006). */
function UnreadableRows({ ledger, noteId, onOpenNote, onFix }: { ledger: Ledger; noteId: string | null; onOpenNote: (id: string) => void; onFix: (line: number) => void }) {
  const rows = ledger.unreadable;
  if (rows.length === 0) return null;
  return (
    <Notice
      title={`${rows.length} ${rows.length === 1 ? "row is" : "rows are"} not counted`}
      text={rows.map((r) => (
        <span key={r.line} className="mnline">
          Line {r.line}, {r.service || "a row with no name"}:{" "}
          {r.field === "cadence"
            ? `“${r.text}” is not a cadence this ledger knows (weekly, every 2 weeks, 4-weekly, monthly, quarterly, half-yearly, yearly).`
            : r.text
              ? `“${r.text}” is not one amount.`
              : "no amount."}{" "}
          <Button size="sm" onClick={() => onFix(r.line)}>
            Fix it
          </Button>
        </span>
      ))}
      actions={noteId ? <Button size="sm" kind="quiet" onClick={() => onOpenNote(noteId)}>Open the note</Button> : undefined}
    />
  );
}

/**
 * Payslips: what landed, month by month. The headline is the last month's take-home — never a
 * month in progress, which would read as a pay cut — then every payslip as a bar, each opening its
 * figures to change or remove, and the year totalled underneath. A PDF kept but not read (its
 * layout was unfamiliar) is listed with a way to type its figures.
 */
function Payslips({ d, onEdit, onOpenNote, onRead }: { d: FinanceData; onEdit: (r: EditReq) => void; onOpenNote: (id: string) => void; onRead: (file: string) => void }) {
  const slips = d.payslips;
  const noteId = d.notes.payslips;
  const withNet = slips.filter((r) => r.net !== null);
  const latest = withNet[withNet.length - 1];
  const before = withNet[withNet.length - 2];
  const year = latest?.month.slice(0, 4) ?? "";
  const thisYear = withNet.filter((r) => r.month.startsWith(year));
  const ytdNet = thisYear.reduce((a, r) => a + (r.net ?? 0), 0);
  const ytdGross = thisYear.reduce((a, r) => a + (r.gross ?? 0), 0);
  const average = thisYear.length ? ytdNet / thisYear.length : 0;
  const kept = ytdGross > 0 ? Math.round((ytdNet / ytdGross) * 1000) / 10 : null;
  const change = latest && before ? latest.net! - before.net! : null;
  const shown = slips.slice(-12);
  const maxNet = Math.max(1, ...shown.map((r) => r.net ?? 0));
  const filed = new Set(slips.map((r) => r.file).filter(Boolean));
  const unfiled = d.files.filter((f) => f.ext === ".pdf" && !filed.has(f.name));

  return (
    <section className="mod" aria-label="Payslips">
      <div className="mh">
        <h2>Payslips</h2>
        <span className="c">{plural(slips.length, "payslip")}</span>
        <span className="msp" />
        <Button size="sm" icon="plus" onClick={() => onEdit({ kind: "payslip" })}>
          Add a payslip
        </Button>
      </div>
      {unfiled.map((f) => (
        <div key={f.name} className="row mline static">
          <span className="x">
            <span className="t">{f.name}</span>
            <span className="m">kept, its figures not read</span>
          </span>
          <span className="end">
            <Button size="sm" kind="quiet" onClick={() => onRead(f.name)}>
              Open
            </Button>
            <Button size="sm" onClick={() => onEdit({ kind: "payslip", file: f.name })}>
              Type the figures
            </Button>
          </span>
        </div>
      ))}
      {!latest && slips.length === 0 ? (
        <p className="q3">No payslips yet. Add a PDF payslip with “Add a bank export” and it is read and filed, or type its figures with Add a payslip.</p>
      ) : (
        <>
          {latest && (
            <div className="mbig sm">
              <b>{eur(latest.net!)}</b>
              <span>
                earned in {monthName(latest.month)}
                {change !== null && change !== 0 && (
                  <>
                    {" · "}
                    {change > 0 ? "+" : "−"}
                    {eur(Math.abs(change))} on {monthName(before!.month)}
                  </>
                )}
              </span>
            </div>
          )}
          {[...shown].reverse().map((r) => (
            <button key={`${r.line}-${r.month}`} type="button" className="row mpay" onClick={() => onEdit({ kind: "payslip", line: r.line })} aria-label={`${monthName(r.month)}, ${r.net !== null ? eur(r.net) : "no net"}: change or remove`}>
              <span className="x">
                <span className="t">{monthName(r.month)}</span>
              </span>
              <span className="ui-bar">
                <i style={{ width: `${((r.net ?? 0) / maxNet) * 100}%` }} />
              </span>
              <span className="r">{r.net !== null ? eur(r.net) : "—"}</span>
            </button>
          ))}
          {latest && (
            <div className="marith mytd">
              <span>Take-home {year}</span>
              <b>
                {eur(ytdNet)} <em>{plural(thisYear.length, "payslip")}</em>
              </b>
              <span>Average month</span>
              <b>
                {eur(Math.round(average * 100) / 100)} <em>across {year}</em>
              </b>
              <span>Kept after tax</span>
              <b>
                {kept !== null ? `${kept}%` : "—"} <em>{ytdGross > 0 ? `${eur(ytdGross - ytdNet)} withheld` : "no gross recorded"}</em>
              </b>
            </div>
          )}
        </>
      )}
      {noteId && <OpenNote id={noteId} onOpenNote={onOpenNote} />}
    </section>
  );
}
