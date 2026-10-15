/**
 * Spending in full (`/money/spending`): every month, split by category, and every category against
 * its typical month. And one month in full (`/money/spending?month=2026-09`): what it cost, by
 * category, and every purchase in it. The overview answers "how is this month going"; these
 * answer "what does a year of it look like" and "where did that month go".
 */
import { rollUpYears } from "@orrama/core/spending";
import type { FinanceData, MonthDetail } from "@orrama/schema/responses";
import { useState } from "react";
import { Button, Segmented, Tabs } from "../ui/controls.js";
import { Crumbs } from "../ui/layout.js";
import { navigate } from "../ui/router.js";
import { Skeleton } from "../ui/states.js";
import { StackedColumns, type Stack } from "./Chart.js";
import { dayLabel, eur, monthLong, monthName, monthShort, plural, weekday } from "./format.js";
import { link, to } from "./links.js";
import { colouredCategories, OTHER_COLOUR, paletteFor, UNCATEGORISED } from "./palette.js";
import { useGrain, useMonthKeys } from "./hooks.js";

/** The neutral band every category without a colour of its own shares. */
const REST = "Other";

export function SpendingPage({ d, onOpenNote }: { d: FinanceData; onOpenNote: (id: string) => void }) {
  const [hot, setHot] = useState<string | null>(null);
  const [grain, setGrain] = useGrain();
  const [year, setYear] = useState<string | null>(null);
  const cats = d.spending.categories;
  const colourOf = paletteFor(cats.rules);
  const coloured = colouredCategories(cats.rules);
  const band = (c: string) => (coloured.includes(c) ? c : REST);
  // A typical month is the server's, not a sum of per-category medians: those two differed by
  // 14% on the real statement, which is how this page and the month page came to disagree.
  const typicalTotal = cats.typical ?? 0;
  // Each row's share of what the categories typically add up to: a different quantity, its own denominator.
  const categoryTypicalTotal = cats.forecast.reduce((a, f) => a + f.typical, 0);
  const catMax = Math.max(1, ...cats.forecast.map((f) => f.high));
  const lastFull = cats.lastComplete ? cats.months.find((m) => m.month === cats.lastComplete) : undefined;
  // Years of statements are too many columns for one chart: by month it shows one year at a
  // time (latest first), by year one column per calendar year.
  const years = [...new Set(cats.months.map((m) => m.month.slice(0, 4)))].sort().reverse();
  const shownYear = year && years.includes(year) ? year : (years[0] ?? null);

  const split = (byCategory: Record<string, number>) => {
    const parts = coloured.map((c) => ({ name: c, value: byCategory[c] ?? 0, colour: colourOf(c) }));
    const rest = Object.entries(byCategory).reduce((a, [k, v]) => (coloured.includes(k) ? a : a + v), 0);
    return [...parts, { name: REST, value: rest, colour: OTHER_COLOUR }];
  };
  const columns: Stack[] =
    grain === "month"
      ? cats.months
          .filter((m) => shownYear !== null && m.month.startsWith(shownYear))
          .map((m) => ({
            key: m.month,
            label: monthShort(m.month),
            parts: split(m.byCategory),
            total: m.total,
            partial: cats.lastComplete !== null && m.month > cats.lastComplete,
            partialNote: "part month",
            action: `Open ${monthLong(m.month)} · ${eur(m.total)}`,
          }))
      : rollUpYears(cats.months, cats.months[0]?.month ?? null, cats.lastComplete).map((y) => ({
          key: y.year,
          label: y.year,
          parts: split(y.byCategory),
          total: y.total,
          partial: y.partial,
          partialNote: `€${Math.round(y.total)} · part year`,
          action: `Show ${y.year} month by month · ${eur(y.total)}`,
        }));

  return (
    <>
      <section className="mod" aria-label="Spending by month">
        <div className="mh">
          <h2>{grain === "year" ? "Every year" : `Per month, ${shownYear ?? ""}`}</h2>
          <span className="c">{plural(d.spending.txnCount, "transaction")} · {plural(cats.completeMonths, "complete month")}</span>
          <span className="msp" />
          {grain === "month" && years.length > 1 && <Tabs bare label="Year" items={years.map((y) => ({ id: y, label: y }))} value={shownYear ?? ""} onChange={setYear} />}
          <Segmented
            label="Show by"
            items={[
              { id: "month", label: "Month" },
              { id: "year", label: "Year" },
            ]}
            value={grain}
            onChange={setGrain}
          />
        </div>
        {typicalTotal > 0 && (
          <div className="mbig sm">
            <b>{eur(typicalTotal)}</b>
            <span>
              a typical month
              {lastFull && (
                <>
                  {" · "}
                  <a {...link(to.spending(lastFull.month))}>
                    {monthName(lastFull.month)} was {eur(lastFull.total)}
                  </a>
                </>
              )}
            </span>
          </div>
        )}
        {columns.length > 0 ? (
          <StackedColumns
            columns={columns}
            typical={grain === "year" ? typicalTotal * 12 : typicalTotal}
            active={hot ? band(hot) : null}
            onHover={setHot}
            onPick={(k) => {
              if (grain === "year") {
                setYear(k);
                setGrain("month");
              } else navigate(to.spending(k));
            }}
            label={grain === "year" ? "Yearly spending by category" : "Monthly spending by category"}
          />
        ) : (
          <p className="q3">No statement yet.</p>
        )}
      </section>

      <section className="mod" aria-label="Every category">
        <div className="mh">
          <h2>Every category</h2>
          <span className="c">{plural(cats.forecast.length, "category", "categories")}</span>
          {cats.noteId && (
            <a
              className="go"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                onOpenNote(cats.noteId!);
              }}
            >
              Edit the rules →
            </a>
          )}
        </div>
        <div className="mcatlist">
          {cats.forecast.map((f) => {
            const delta = f.last !== null ? f.last - f.typical : null;
            const share = categoryTypicalTotal > 0 ? Math.round((f.typical / categoryTypicalTotal) * 100) : 0;
            return (
              <a
                key={f.category}
                className={`row mcrow ${hot && band(hot) !== band(f.category) ? "cool" : ""}`}
                style={{ ["--cc" as string]: colourOf(f.category) }}
                onMouseEnter={() => setHot(f.category)}
                onMouseLeave={() => setHot(null)}
                {...link(to.category(f.category))}
              >
                <span className="x">
                  <span className="t">
                    <i className="sw" />
                    {f.category}
                  </span>
                  <span className="m">{share}% of spending</span>
                </span>
                <span className="mrange" title={`${eur(f.low)} to ${eur(f.high)} a month`}>
                  <i className="span" style={{ left: `${(f.low / catMax) * 100}%`, width: `${Math.max((f.high - f.low) / catMax, 0.004) * 100}%` }} />
                  <i className="mark" style={{ left: `${(f.typical / catMax) * 100}%` }} />
                  {f.last !== null && <i className="last" style={{ left: `${(f.last / catMax) * 100}%` }} />}
                </span>
                <span className="amt">{eur(f.typical)}</span>
                <span className="vs">
                  {delta === null || delta === 0 ? (
                    "as usual"
                  ) : (
                    <>
                      <b>
                        {delta > 0 ? "+" : "−"}
                        {eur(Math.abs(delta))}
                      </b>{" "}
                      {delta > 0 ? "over usual" : "under usual"}
                    </>
                  )}
                </span>
              </a>
            );
          })}
        </div>
        <p className="mlegend">
          <span>
            <i className="span" /> your lowest to highest month
          </span>
          <span>
            <i className="mark" /> typical
          </span>
          <span>
            <i className="last" /> {lastFull ? monthName(lastFull.month) : "the last complete month"}
          </span>
        </p>
        <p className="q3">
          Typical is the median of the last {cats.completeMonths} complete months, so one large purchase does not become next month&apos;s expectation.
          {grain === "year" && " By year, the dashed line is twelve typical months, and a faded column is a year the statements only partly cover."}
        </p>
      </section>
    </>
  );
}

/**
 * One month in full. Every column of the spending chart opens it; each category in it opens that
 * category with this month open below its chart, and each purchase opens its shop.
 */
export function MonthPage({ month, d, colourOf }: { month: string; d: MonthDetail | null; colourOf: (name: string) => string }) {
  useMonthKeys(d?.month === month ? d.prev : null, d?.month === month ? d.next : null, (m) => navigate(to.spending(m), { replace: true }));
  const crumbs = (
    <Crumbs
      items={[
        { label: "Money", href: link(to.overview()).href, onOpen: () => navigate(to.overview()) },
        { label: "Spending", href: link(to.spending()).href, onOpen: () => navigate(to.spending()) },
        { label: monthLong(month) },
      ]}
    />
  );
  if (!d || d.month !== month)
    return (
      <div className="mpage">
        {crumbs}
        <Skeleton rows={5} label={`Opening ${monthLong(month)}`} />
      </div>
    );

  const delta = d.typical > 0 ? d.total - d.typical : null;
  const days = new Map<string, MonthDetail["transactions"]>();
  for (const t of d.transactions) days.set(t.date, [...(days.get(t.date) ?? []), t]);
  const top = d.categories[0]?.total || 1;

  return (
    <div className="mpage">
      {crumbs}
      <div className="phead">
        <h1>{monthLong(month)}</h1>
        <span className="meta">
          {plural(d.count, "purchase")}
          {d.transferCount > 0 && ` · ${plural(d.transferCount, "transfer")}`}
          {!d.complete && " · the statement stops inside this month"}
        </span>
        <span className="sp" />
        <div className="mnav">
          <Button size="sm" icon="chev-l" aria-label="Previous month" tip="Previous month  ←" data-tip-at="top" disabled={!d.prev} onClick={() => d.prev && navigate(to.spending(d.prev))} />
          <Button size="sm" icon="chev-r" aria-label="Next month" tip="Next month  →" data-tip-at="top" disabled={!d.next} onClick={() => d.next && navigate(to.spending(d.next))} />
        </div>
      </div>

      <section className="mod" aria-label={`Spent in ${monthLong(month)}`}>
        <div className="mbig">
          <b>{eur(d.total)}</b>
          <span>
            spent
            {delta !== null && (
              <>
                {" · "}
                <b>{eur(Math.abs(delta))}</b> {delta > 0 ? "over" : "under"} a typical {eur(d.typical)}
              </>
            )}
          </span>
        </div>
        {/* A transfer is money moving, not spending, stated beside the headline rather than
            folded into it. A refund is money back on something already counted: it is off the
            total, and restated here for what it is. */}
        {(d.movedOut > 0 || d.refunded > 0) && (
          <p className="q3">
            {d.movedOut > 0 && <>{eur(d.movedOut)} moved out (rent, tuition, transfers: not counted as spending). </>}
            {d.refunded > 0 && <>{eur(d.refunded)} refunded, already off the total.</>}
          </p>
        )}
        {d.categories.length > 0 && (
          <div className="mcats">
            {d.categories.map((c) => (
              <a key={c.category} className="mcat" style={{ ["--cc" as string]: colourOf(c.category) }} {...link(to.category(c.category, month))}>
                <span className="nm">
                  <i className="sw" />
                  {c.category}
                </span>
                <span className="ui-bar">
                  <i style={{ width: `${(c.total / top) * 100}%` }} />
                </span>
                <span className="amt">{eur(c.total)}</span>
                <span className="vs">{c.typical > 0 ? `usually ${eur(c.typical)}` : plural(c.count, "purchase")}</span>
              </a>
            ))}
          </div>
        )}
      </section>

      <section className="mod" aria-label="Every purchase">
        <div className="mh">
          <h2>Every transaction</h2>
          <span className="c">{d.count}</span>
        </div>
        {d.transactions.length === 0 ? (
          <p className="q3">Nothing in {monthLong(month)}.</p>
        ) : (
          [...days].map(([date, rows]) => (
            <div key={date} className="mday">
              <div className="mdayh">{`${weekday(date)} ${dayLabel(date)}`}</div>
              {rows.map((t, n) => (
                <a
                  key={`${t.date}-${n}`}
                  className={`row mtx ${t.refund ? "refund" : ""} ${t.moved ? "moved" : ""}`}
                  {...link(to.merchant(t.description, t.moved || t.category === UNCATEGORISED ? undefined : t.category))}
                >
                  <span className="lead">
                    <i className="dot" style={{ background: t.moved ? "var(--line-2)" : colourOf(t.category) }} />
                  </span>
                  <span className="x">
                    <span className="t">{t.description}</span>
                    <span className="m">{t.refund ? `${t.category} · refund` : t.category}</span>
                  </span>
                  <span className="r">{t.refund ? `+${eur(t.amount)}` : eur(t.amount)}</span>
                </a>
              ))}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
