/**
 * One shop (`/money/spending/<category>/<shop>`, or `/money/spending?merchant=<shop>`): every
 * transaction with it, newest first, grouped by month. The end of the drill-down, where a number
 * stops being a summary and becomes something you remember doing.
 */
import type { MerchantDetail } from "@orrama/schema/responses";
import { Crumbs, type Crumb } from "../ui/layout.js";
import { navigate } from "../ui/router.js";
import { Skeleton } from "../ui/states.js";
import { Columns } from "./Chart.js";
import { dayLabel, eur, monthLong, monthName, monthShort, plural, weekday } from "./format.js";
import { link, to } from "./links.js";
import type { EditReq } from "./writes.js";
import { Button, NameLink, Tabs } from "../ui/controls.js";

export function MerchantPage({ name, category, d, onYear, onEdit }: { name: string; category?: string; d: MerchantDetail | null; onYear: (year: string) => void; onEdit: (r: EditReq) => void }) {
  const items: Crumb[] = [
    { label: "Money", href: link(to.overview()).href, onOpen: () => navigate(to.overview()) },
    { label: "Spending", href: link(to.spending()).href, onOpen: () => navigate(to.spending()) },
    ...(category ? [{ label: category, href: link(to.category(category)).href, onOpen: () => navigate(to.category(category)) }] : []),
    { label: d?.merchant ?? name },
  ];
  if (!d)
    return (
      <div className="mpage">
        <Crumbs items={items} />
        <Skeleton rows={6} label={`Reading ${name}`} />
      </div>
    );

  // Grouped here: the client has the flat list, and a month heading is presentation.
  const groups = new Map<string, MerchantDetail["transactions"]>();
  for (const t of d.transactions) {
    const k = t.date.slice(0, 7);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const incoming = d.direction === "in";
  const months = [...d.months].sort((a, b) => a.month.localeCompare(b.month));

  return (
    <div className="mpage">
      <Crumbs items={items} />
      <div className="phead">
        <h1>{d.merchant}</h1>
        <span className="meta">
          {d.stats.first && d.stats.last ? `${plural(d.stats.count, "transaction")} · ${dayLabel(d.stats.first)} to ${dayLabel(d.stats.last)}` : "No transactions in this year."}
        </span>
        <span className="sp" />
        {d.years.length > 0 && <Tabs bare label="Year" items={d.years.map((y) => ({ id: y, label: y }))} value={d.year ?? ""} onChange={onYear} />}
      </div>
      {/* Where its rows are filed, and the way to file them elsewhere; money that only moves, or
          comes in, has no category to change. */}
      {d.filing.own ? (
        <p className="q3 mwords">
          Your own account {d.filing.own}: money moved here is saved, not spent.{" "}
          <NameLink href={link(to.page("savings")).href} onOpen={() => navigate(to.page("savings"))}>
            Your own accounts
          </NameLink>
        </p>
      ) : d.filing.commitment ? (
        <p className="q3 mwords">
          Counted under <b>{d.filing.category}</b>, as your{" "}
          <NameLink href={link(to.page("subscriptions")).href} onOpen={() => navigate(to.page("subscriptions"))}>
            {d.filing.commitment}
          </NameLink>{" "}
          commitment.
        </p>
      ) : (
        !incoming && (
          <p className="q3 mwords">
            In{" "}
            <NameLink href={link(to.category(d.filing.category)).href} onOpen={() => navigate(to.category(d.filing.category))}>
              {d.filing.category}
            </NameLink>{" "}
            <Button size="sm" kind="quiet" icon="tag" onClick={() => onEdit({ kind: "shop", shop: d.merchant, current: d.filing.category })}>
              Put it in another category
            </Button>
          </p>
        )
      )}

      <section className="mod mstats" aria-label="In figures">
        <div>
          <span className="lbl">{incoming ? `Received ${d.year}` : `Total ${d.year}`}</span>
          <b>{eur(d.stats.total)}</b>
          <span className="sub">{d.stats.allTime !== d.stats.total ? `${eur(d.stats.allTime)} all time` : "all of it"}</span>
        </div>
        <div>
          <span className="lbl">{incoming ? "Usually" : "Average"}</span>
          <b>{eur(d.stats.average)}</b>
          <span className="sub">{incoming ? "most months" : "per transaction"}</span>
        </div>
        <div>
          <span className="lbl">Biggest</span>
          <b>{eur(d.stats.biggest)}</b>
          <span className="sub">single transaction</span>
        </div>
        <div>
          <span className="lbl">How often</span>
          <b>{d.months.length > 0 ? (d.stats.count / d.months.length).toFixed(1) : "0"}</b>
          <span className="sub">times a month, on the months {incoming ? "it paid" : "you went"}</span>
        </div>
      </section>

      {months.length > 1 && (
        <section className="mod" aria-label={`Per month, ${d.year}`}>
          <div className="mh">
            <h2>Per month, {d.year}</h2>
            <span className="c">click a month to open it</span>
          </div>
          <Columns
            columns={months.map((m) => ({ key: m.month, label: monthShort(m.month), value: m.total, state: "done", action: `Open ${monthLong(m.month)} · ${eur(m.total)}` }))}
            colour="var(--ink-2)"
            onPick={(m) => navigate(to.spending(m))}
            label={`${d.merchant} per month in ${d.year}`}
            height={200}
          />
        </section>
      )}

      <section className="mod" aria-label="Transactions">
        <div className="mh">
          <h2>Transactions</h2>
          <span className="c">{d.transactions.length}</span>
        </div>
        {d.transactions.length === 0 ? (
          <p className="q3">Nothing in {d.year}.</p>
        ) : (
          [...groups].map(([month, rows]) => {
            const total = d.months.find((m) => m.month === month)?.total ?? 0;
            return (
              <div key={month} className="mday">
                <a className="mmonth" {...link(to.spending(month))}>
                  <b>{monthName(month)}</b>
                  <span>{plural(rows.length, "transaction")}</span>
                  <b className="amt">{eur(total)}</b>
                </a>
                {rows.map((t, i) => (
                  <div key={`${t.date}:${i}`} className={`row mtx static ${t.refund ? "refund" : ""}`}>
                    <span className="dd">{`${weekday(t.date)} ${Number(t.date.slice(8, 10))}`}</span>
                    <span className="x">
                      {/* Only the exceptions are worth naming; "Card Payment" on every row says nothing. */}
                      <span className="t">{t.type === "Card Payment" ? "Card" : t.type}</span>
                      {t.balance !== null && <span className="m">balance {eur(t.balance)}</span>}
                    </span>
                    <span className="r">{t.refund ? `+${eur(t.amount)}` : eur(t.amount)}</span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
