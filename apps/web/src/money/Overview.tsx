/**
 * The overview (board: mockups/screens/money.html): how this month is going, and what is coming.
 * Left, what was spent and where, and what you could save; right, the month's commitments and
 * what comes in. Every heading, count, row and column opens the page behind it.
 *
 * A month other than the current one (`/money?month=2026-09`) shows that month: what it cost, by
 * category, and its charges. Pace is only for the month the statements are inside.
 */
import { isoLocal } from "@orrama/core/dates";
import type { FinanceData, MonthDetail, MoneyItem, Recurring } from "@orrama/schema/responses";
import { useMemo, type ReactNode } from "react";
import { Button } from "../ui/controls.js";
import { NameLink } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { EmptyState } from "../ui/states.js";
import { navigate } from "../ui/router.js";
import { chargeDays, daysIn, dayLabel, eur, monthName, monthPace, monthWord, notCounted, perCurrency, plural, projectedSpend, weekday } from "./format.js";
import { link, to } from "./links.js";
import { monthByCategory, recurringRow } from "./model.js";
import { UNCATEGORISED } from "./palette.js";
import { CountUp } from "../ui/CountUp.js";
import type { EditReq } from "./writes.js";

type Cats = FinanceData["spending"]["categories"];

/** The month the overview shows: the address's, when the statements reach it, else the latest. */
export function shownMonth(d: FinanceData, asked?: string): string | null {
  const months = d.spending.months.map((m) => m.month);
  if (asked && months.includes(asked)) return asked;
  return months[months.length - 1] ?? null;
}

export function Overview({
  d,
  month,
  detail,
  dismissed,
  onDismiss,
  onAdd,
  adding,
  onUpload,
  onEdit,
}: {
  d: FinanceData;
  month: string;
  /** The month in full (its purchase count), when it has arrived. */
  detail: MonthDetail | null;
  dismissed: Set<string>;
  onDismiss: (r: Recurring) => void;
  onAdd: (r: Recurring) => void;
  /** The merchant being written into the ledger. */
  adding: string | null;
  onUpload: () => void;
  onEdit: (r: EditReq) => void;
}) {
  const cats = d.spending.categories;
  const latest = d.spending.months[d.spending.months.length - 1]?.month ?? null;
  const current = month === latest;
  const soFar = d.spending.months.find((m) => m.month === month)?.spend ?? 0;
  const typical = cats.typical ?? 0;
  const pace = current ? monthPace(d.spending.dataThrough) : null;
  const projected = projectedSpend(soFar, pace);
  // The month's split is looked up inside the memo: `?? {}` outside made a new object every
  // render, so the memo never held (found by react-hooks/exhaustive-deps, REG-016).
  const rows = useMemo(() => monthByCategory(cats.months.find((m) => m.month === month)?.byCategory ?? {}, cats), [cats, month]);
  const noStatements = d.spending.txnCount === 0;

  return (
    <div className="mgrid">
      <div className="mcol">
        {noStatements ? (
          <section className="mod">
            <EmptyState
              pose="carry"
              title="Drop a bank export (CSV) here to start."
              text="Or add one with the button. Statements are kept with your notes, on this computer, and nothing leaves it."
              actions={
                <Button kind="solid" icon="upload" onClick={onUpload}>
                  Add a bank export
                </Button>
              }
            />
          </section>
        ) : (
          <>
            <Spent month={month} soFar={soFar} typical={typical} pace={pace} projected={projected} detail={detail} current={current} />
            {rows.length > 0 && <ByCategory month={month} current={current} rows={rows} detail={detail && detail.month === month ? detail : null} />}
          </>
        )}
        <Saving d={d} />
      </div>
      <div className="mcol">
        <Commitments d={d} month={month} dismissed={dismissed} onDismiss={onDismiss} onAdd={onAdd} adding={adding} onEdit={onEdit} />
        <Income d={d} month={month} onEdit={onEdit} />
      </div>
    </div>
  );
}

/** A module's heading row: the title (a link), its count (a link), and where it leads. */
function Head({ title, titleTo, count, countTo, go }: { title: string; titleTo?: Parameters<typeof link>[0]; count?: ReactNode; countTo?: Parameters<typeof link>[0]; go?: { label: string; to: Parameters<typeof link>[0] } }) {
  return (
    <div className="mh">
      <h2>{titleTo ? <a {...link(titleTo)}>{title}</a> : title}</h2>
      {count !== undefined &&
        (countTo ? (
          <a className="c" {...link(countTo)}>
            {count}
          </a>
        ) : (
          <span className="c">{count}</span>
        ))}
      {go && (
        <a className="go" {...link(go.to)}>
          {go.label}
        </a>
      )}
    </div>
  );
}

/** One number dominates: what this month has cost so far, against what a month usually costs. */
function Spent({
  month,
  soFar,
  typical,
  pace,
  projected,
  detail,
  current,
}: {
  month: string;
  soFar: number;
  typical: number;
  pace: { elapsed: number; length: number } | null;
  projected: number | null;
  detail: MonthDetail | null;
  current: boolean;
}) {
  const share = typical > 0 ? Math.min(soFar / typical, 1) : 0;
  const at = pace ? pace.elapsed / pace.length : null;
  return (
    <section className="mod hero" aria-label={`Spent in ${monthWord(month)}`}>
      <Head
        title={`Spent in ${monthWord(month)}`}
        titleTo={to.spending(month)}
        count={detail && detail.month === month ? plural(detail.count, "purchase") : undefined}
        countTo={to.spending(month)}
        go={{ label: "All spending →", to: to.spending() }}
      />
      <div className="mbig">
        <b>
          <CountUp text={eur(soFar)} />
        </b>
        <span>{typical > 0 ? `of a typical ${eur(typical)} a month` : "a typical month needs three complete months"}</span>
      </div>
      {typical > 0 && (
        <div className="mpace" role="img" aria-label={`${eur(soFar)} of a typical ${eur(typical)}${pace ? `, on day ${pace.elapsed} of ${pace.length}` : ""}`}>
          <div className="ui-bar">
            <i style={{ width: `${share * 100}%` }} />
            {at !== null && <u style={{ left: `${at * 100}%` }} />}
          </div>
          {at !== null && pace && (
            <span className="lab" style={{ ["--at" as string]: at }}>
              day <b>{pace.elapsed}</b> of {pace.length}
            </span>
          )}
        </div>
      )}
      <p className="msum">
        {current && projected !== null ? (
          <>
            On pace for <b>{eur(projected)}</b> by the end of {monthWord(month)}, if the rest of the month goes like its first {pace!.elapsed} days. A typical month is {eur(typical)}.
          </>
        ) : current && pace ? (
          <>Too early in {monthWord(month)} to say where it is heading: a projection waits for the seventh day.</>
        ) : detail && detail.month === month && detail.typical > 0 ? (
          <>
            {detail.total === detail.typical ? (
              <>Exactly a typical month</>
            ) : (
              <>
                <b>{eur(Math.abs(detail.total - detail.typical))}</b> {detail.total > detail.typical ? "over" : "under"} a typical {eur(detail.typical)}
              </>
            )}
            , against the complete months around {monthWord(month)}
            {detail.complete ? "" : " (the statements stop inside it)"}. <a {...link(to.spending(month))}>See every purchase</a>.
          </>
        ) : (
          <>
            {monthName(month)}. <a {...link(to.spending(month))}>See every purchase</a>.
          </>
        )}
      </p>
    </section>
  );
}

/**
 * This month by category: one row per category, each a door to it. A month is held against the
 * complete months around it, itself excluded — the month page's typical, `typicalAround` — and a
 * finished month says by how much it differed (the old top cards' figure, FIN-014). A month still
 * running only says what typical is: a few days against a whole month is no comparison.
 */
function ByCategory({ month, current, rows, detail }: { month: string; current: boolean; rows: ReturnType<typeof monthByCategory>; detail: MonthDetail | null }) {
  const other = rows.find((r) => r.category === UNCATEGORISED && r.members);
  const around = new Map((detail?.categories ?? []).map((c) => [c.category, c.typical]));
  const vs = (r: (typeof rows)[number]): ReactNode => {
    if (r.members) return "";
    const t = around.get(r.category);
    if (t === undefined) return detail ? "nothing yet" : "";
    if (t <= 0) return "no typical month";
    if (current) return `typical ${eur(t)}`;
    const delta = Math.round((r.amount - t) * 100) / 100;
    if (delta === 0) return "as usual";
    return (
      <>
        <b>
          {delta > 0 ? "+" : "−"}
          {eur(Math.abs(delta))}
        </b>{" "}
        vs {eur(t)}
      </>
    );
  };
  return (
    <section className="mod" aria-label={current ? "This month by category" : `${monthWord(month)} by category`}>
      <Head title={current ? "This month by category" : `${monthWord(month)} by category`} titleTo={to.spending(month)} count={current ? "so far" : undefined} go={{ label: "Spending →", to: to.spending() }} />
      <div className="mcats">
        {rows.map((r) => (
          <a key={r.category} className={aheadOfTypical(r.amount, r.members ? undefined : around.get(r.category)) ? "mcat ahead" : "mcat"} style={{ ["--cc" as string]: r.colour }} {...link(r.members ? to.spending(month) : to.category(r.category, month))}>
            <span className="nm">
              <i className="sw" />
              {r.category}
            </span>
            <span className="ui-bar">
              <i style={{ width: `${barShare(r.amount, around.get(r.category) ?? r.typical) * 100}%` }} />
            </span>
            <span className="amt">{eur(r.amount)}</span>
            <span className="vs">{vs(r)}</span>
          </a>
        ))}
      </div>
      <div className="mkey">
        <span>
          <i />
          {current ? "this month" : monthWord(month)}, against a typical whole month
        </span>
        {other && other.members!.length > 0 && <span>Other: {other.members!.map((m) => m.toLowerCase()).join(", ")}</span>}
      </div>
    </section>
  );
}

/** A bar's fill: this month against a typical whole one, full at typical and beyond. */
/**
 * A category already past its typical whole month (Clay draws its bar orange, as the board's
 * "over"). The board compared against a typical month by this day; no figure by day exists per
 * category, so this is the honest version: more than a whole typical month already.
 */
export const aheadOfTypical = (amount: number, typical: number | undefined) => typical !== undefined && typical > 0 && amount > typical;
const barShare = (amount: number, typical: number) => (typical > 0 ? Math.min(amount / typical, 1) : amount > 0 ? 1 : 0);

/** Saving, on your own numbers: the arithmetic laid out, not asserted. */
function Saving({ d }: { d: FinanceData }) {
  const s = d.savings;
  const sum = d.summary;
  if (s.basedOn < 3)
    return (
      <section className="mod tiles" aria-label="Saving">
        <Head title="Saving" titleTo={to.page("savings")} go={{ label: "The working →", to: to.page("savings") }} />
        <p className="q3">
          Needs three complete months; there {s.basedOn === 1 ? "is" : "are"} {s.basedOn}.
        </p>
      </section>
    );
  const top = s.headroom.filter((h) => h.save > 0).slice(0, 2);
  return (
    <section className="mod tiles" aria-label="Saving">
      <Head title="Saving" titleTo={to.page("savings")} count={s.targetRate !== null ? `${s.targetRate}% of income` : "on your own numbers"} go={{ label: "The working →", to: to.page("savings") }} />
      <div className="marith">
        <span>Average month in</span>
        <b>{eur(s.incomeMonthly)}</b>
        <span>Average month out</span>
        <b>−{eur(s.outflowMonthly)}</b>
        <span className="sub">Already left over</span>
        <b className="sub">{eur(Math.max(0, s.surplus))}</b>
        <span>Headroom you have already lived inside</span>
        <b>+{eur(s.trimmable)}</b>
        <span className="tot">A realistic saving each month</span>
        <b className="tot">{eur(s.target)}</b>
      </div>
      <p className="q3">
        {s.observed !== null && (
          <>
            You are actually {s.observed >= 0 ? "saving" : "losing"} {eur(Math.abs(s.observed))} a month.{" "}
          </>
        )}
        {top.length > 0 && (
          <>
            The headroom is mostly in{" "}
            {top.map((h, i) => (
              <span key={h.category}>
                {i > 0 && " and "}
                <NameLink href={link(to.category(h.category)).href} onOpen={() => navigate(to.category(h.category))}>
                  {h.category.toLowerCase()}
                </NameLink>
              </span>
            ))}
            .{" "}
          </>
        )}
        {sum.balance !== null && (
          <>
            The account holds {eur(sum.balance)}
            {sum.balanceDate ? ` on ${dayLabel(sum.balanceDate)}` : ""}
            {sum.drift !== null ? `, ${sum.drift >= 0 ? "+" : ""}${eur(sum.drift)} a month` : ""}
            {sum.runwayMonths !== null ? `; at this pace it lasts ${sum.runwayMonths} months` : ""}.
          </>
        )}
      </p>
    </section>
  );
}

/** The days of a month a ledger's lines charge on, each with the lines that land on it. */
function chargesIn(items: MoneyItem[], month: string): { day: number; item: MoneyItem }[] {
  return items.flatMap((item) => chargeDays(month, item.anchor, item.cadence).map((day) => ({ day, item }))).sort((a, b) => a.day - b.day || b.item.amount - a.item.amount);
}

/** A ledger line's way in: the shop the statement calls it, or the ledger's own page. */
function lineTo(d: FinanceData, kind: "subscriptions" | "income", item: MoneyItem, month: string) {
  const shop = d[kind].activity[item.service]?.merchants[0];
  return shop ? to.merchant(shop) : to.page(kind, month);
}

const iso = (month: string, day: number) => `${month}-${String(day).padStart(2, "0")}`;

/** The month's fixed charges: a strip of its days, the ones still to come, and charges that look recurring. */
function Commitments({
  d,
  month,
  dismissed,
  onDismiss,
  onAdd,
  adding,
  onEdit,
}: {
  d: FinanceData;
  month: string;
  dismissed: Set<string>;
  onDismiss: (r: Recurring) => void;
  onAdd: (r: Recurring) => void;
  adding: string | null;
  onEdit: (r: EditReq) => void;
}) {
  const today = isoLocal();
  const thisMonth = today.slice(0, 7);
  const todayN = Number(today.slice(8, 10));
  const charges = chargesIn(d.subscriptions.items, month);
  const chargeOn = new Map<number, MoneyItem[]>();
  for (const c of charges) chargeOn.set(c.day, [...(chargeOn.get(c.day) ?? []), c.item]);
  const len = daysIn(month);
  const past = (day: number) => month < thisMonth || (month === thisMonth && day < todayN);
  // This month: what is still to come. Another month: all of it.
  const shown = month === thisMonth ? charges.filter((c) => c.day >= todayN) : charges;
  const found = d.recurring.filter((r) => r.active && !dismissed.has(`${r.merchant}|${r.amount.toFixed(2)}`));

  return (
    <section className="mod tiles" aria-label="Commitments">
      <Head
        title="Commitments"
        titleTo={to.page("subscriptions", month)}
        count={`${perCurrency(d.subscriptions.totals)} a month${notCounted(d.subscriptions)}`}
        countTo={to.page("subscriptions", month)}
        go={{ label: "Calendar →", to: to.page("subscriptions", month) }}
      />
      {d.subscriptions.count === 0 ? (
        <div className="mnone">
          <p className="q3">Nothing recorded yet. Rent, a gym, a phone plan: add what comes back, or a charge below when one looks recurring.</p>
          <Button size="sm" icon="plus" onClick={() => onEdit({ kind: "line", ledger: "subscriptions" })}>
            Add a commitment
          </Button>
        </div>
      ) : (
        <>
          <div className="mstrip" style={{ gridTemplateColumns: `repeat(${len}, minmax(0, 1fr))` }} aria-label={`Charges in ${monthName(month)}`} role="img">
            {Array.from({ length: len }, (_, i) => {
              const day = i + 1;
              const on = chargeOn.get(day);
              const cls = [past(day) && "p", month === thisMonth && day === todayN && "t", on && "c", on && !past(day) && "fut"].filter(Boolean).join(" ");
              return <i key={day} className={cls} title={on ? `${dayLabel(iso(month, day))} · ${on.map((m) => `${m.service} ${eur(m.amount, m.currency)}`).join(", ")}` : undefined} />;
            })}
          </div>
          <div className="mstriplab">
            <span style={{ left: 0 }}>{dayLabel(iso(month, 1))}</span>
            {month === thisMonth && (
              <span className="now" style={{ left: `${((todayN - 0.5) / len) * 100}%` }}>
                today
              </span>
            )}
            <span style={{ right: 0 }}>{dayLabel(iso(month, len))}</span>
          </div>
          {shown.length === 0 ? (
            <p className="q3">Nothing more to pay in {monthWord(month)}.</p>
          ) : (
            shown.slice(0, 4).map(({ day, item }) => (
              <a key={`${day}-${item.service}`} className="row mrow" {...link(lineTo(d, "subscriptions", item, month))}>
                <span className="dd">
                  <b>{day}</b>
                  {weekday(iso(month, day))}
                </span>
                <span className="x">
                  <span className="t">{item.service}</span>
                  <span className="m">{item.cadence}</span>
                </span>
                <span className="r">{eur(item.amount, item.currency)}</span>
              </a>
            ))
          )}
          {shown.length > 4 && (
            <a className="mmore" {...link(to.page("subscriptions", month))}>
              {plural(shown.length - 4, "more charge")} in {monthWord(month)} →
            </a>
          )}
        </>
      )}
      {found.slice(0, 2).map((r) => (
        <Found key={`${r.merchant}-${r.amount}`} r={r} canAdd={recurringRow(r, null) !== null} busy={adding === r.merchant} onAdd={() => onAdd(r)} onDismiss={() => onDismiss(r)} />
      ))}
    </section>
  );
}

/** A charge that looks recurring and no ledger line claims: Orr asks whether to write it down. */
export function Found({ r, canAdd, busy, onAdd, onDismiss }: { r: Recurring; canAdd: boolean; busy: boolean; onAdd: () => void; onDismiss: () => void }) {
  const cadence = r.cadence ?? `every ${r.everyMonths} months`;
  return (
    <div className="oprop mfound">
      <Icon name="repeat" size={18} />
      <div>
        <p>
          <NameLink href={link(to.merchant(r.merchant)).href} onOpen={() => navigate(to.merchant(r.merchant))}>
            {r.merchant}
          </NameLink>{" "}
          charged {eur(r.amount)} {cadence}, {monthName(r.first)} to {monthName(r.last)} ({eur(r.total)} so far). Add it to your commitments?
        </p>
        <div className="acts">
          {canAdd && (
            <Button size="sm" onClick={onAdd} disabled={busy}>
              {busy ? "Adding…" : "Add it"}
            </Button>
          )}
          <Button size="sm" kind="quiet" onClick={onDismiss}>
            It's not recurring
          </Button>
        </div>
      </div>
    </div>
  );
}

/** What comes in this month, from the income ledger. */
function Income({ d, month, onEdit }: { d: FinanceData; month: string; onEdit: (r: EditReq) => void }) {
  const charges = chargesIn(d.income.items, month);
  return (
    <section className="mod tiles" aria-label="Income">
      <Head
        title="Income"
        titleTo={to.page("income", month)}
        count={`${perCurrency(d.income.totals)} a month${notCounted(d.income)}`}
        countTo={to.page("income", month)}
        go={{ label: "Income →", to: to.page("income", month) }}
      />
      {charges.length === 0 ? (
        d.income.count === 0 ? (
          <div className="mnone">
            <p className="q3">Nothing recorded yet.</p>
            <Button size="sm" icon="plus" onClick={() => onEdit({ kind: "line", ledger: "income" })}>
              Add income
            </Button>
          </div>
        ) : (
          <p className="q3">Nothing expected in {monthWord(month)}.</p>
        )
      ) : (
        charges.map(({ day, item }) => (
          <a key={`${day}-${item.service}`} className="row mrow" {...link(lineTo(d, "income", item, month))}>
            <span className="dd">
              <b>{day}</b>
              {weekday(iso(month, day))}
            </span>
            <span className="x">
              <span className="t">{item.service}</span>
              <span className="m">{item.cadence}</span>
            </span>
            <span className="r">{eur(item.amount, item.currency)}</span>
          </a>
        ))
      )}
      <p className="q3 mnet">
        Net recurring: <b>{perCurrency(d.summary.net)}</b> a month, what comes in less your commitments.
      </p>
    </section>
  );
}

export type { Cats };
