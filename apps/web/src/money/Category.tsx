/**
 * One category (board: mockups/screens/money-drill.html, `/money/spending/<category>`): its year
 * month by month, and below the chart the month you picked — where it went, shop by shop, and
 * every purchase. `?month=` is that month; a column click moves it.
 */
import type { CategoryDetail, MonthDetail } from "@orrama/schema/responses";
import { useState } from "react";
import { Segmented, Tabs } from "../ui/controls.js";
import { Crumbs } from "../ui/layout.js";
import { navigate } from "../ui/router.js";
import { Skeleton } from "../ui/states.js";
import { Columns, type Column } from "./Chart.js";
import { eur, monthLong, monthShort, monthWord, plural, weekday } from "./format.js";
import { useGrain, useMonthKeys } from "./hooks.js";
import { link, to } from "./links.js";
import { shopsOf } from "./model.js";

/** The month a category opens on: the address's, else its last complete month with spending, else its last with any. */
export function pickMonth(d: CategoryDetail, asked?: string): string | null {
  if (asked && d.series.some((m) => m.month === asked && !m.future)) return asked;
  const drawn = d.series.filter((m) => !m.future && m.hasData);
  return [...drawn].reverse().find((m) => !m.partial)?.month ?? drawn[drawn.length - 1]?.month ?? null;
}

const SHOWN = 8;

export function CategoryPage({
  name,
  d,
  month,
  detail,
  colour,
  onYear,
}: {
  name: string;
  d: CategoryDetail | null;
  /** The month open below the chart. */
  month: string | null;
  /** That month, filtered to this category. */
  detail: MonthDetail | null;
  colour: string;
  onYear: (year: string) => void;
}) {
  const [grain, setGrain] = useGrain();
  const [scope, setScope] = useState<"month" | "year">("month");
  const [all, setAll] = useState(false);
  const months = d ? d.series.filter((m) => !m.future && m.hasData).map((m) => m.month) : [];
  const i = month ? months.indexOf(month) : -1;
  const select = (m: string) => {
    setAll(false);
    navigate(to.category(name, m), { replace: true });
  };
  useMonthKeys(i > 0 ? months[i - 1]! : null, i >= 0 && i < months.length - 1 ? months[i + 1]! : null, select);

  const crumbs = (
    <Crumbs
      items={[
        { label: "Money", href: link(to.overview()).href, onOpen: () => navigate(to.overview()) },
        { label: "Spending", href: link(to.spending()).href, onOpen: () => navigate(to.spending()) },
        { label: name },
      ]}
    />
  );
  if (!d)
    return (
      <div className="mpage">
        {crumbs}
        <Skeleton rows={6} label={`Reading ${name}`} />
      </div>
    );

  const yearTabs = d.years.length > 0 && <Tabs bare label="Year" items={d.years.map((y) => ({ id: y, label: y }))} value={d.year ?? ""} onChange={onYear} />;
  if (d.years.length === 0)
    return (
      <div className="mpage" style={{ ["--cc" as string]: colour }}>
        {crumbs}
        <div className="phead">
          <i className="mswatch" />
          <h1>{name}</h1>
        </div>
        <section className="mod">
          <p className="q3">Nothing has cost anything in {name} yet.</p>
        </section>
      </div>
    );

  const sel = d.series.find((m) => m.month === month) ?? null;
  const twoMonths = d.stats.activeMonths >= 2;
  const columns: Column[] =
    grain === "year"
      ? d.yearly.map((y) => ({ key: y.year, label: y.year, value: y.total, state: y.partial ? "partial" : y.year === d.year ? "selected" : "done", action: `Show ${y.year} month by month · ${eur(y.total)}` }))
      : d.series.map((m) => ({
          key: m.month,
          label: monthShort(m.month),
          value: m.total,
          state: m.future ? "future" : m.month === month ? "selected" : m.partial ? "partial" : "done",
          action: `Open ${monthLong(m.month)} · ${eur(m.total)}`,
        }));
  const shown = detail && detail.month === month ? detail : null;
  const { shops, adds } = shown ? shopsOf(shown) : { shops: [], adds: false };
  const byMonth = scope === "month" && shown !== null && adds;
  const list = byMonth ? shops : d.merchants;
  const top = list[0]?.total || 1;
  const purchases = shown?.transactions.filter((t) => !t.moved) ?? [];

  return (
    <div className="mpage" style={{ ["--cc" as string]: colour }}>
      {crumbs}
      <div className="phead">
        <i className="mswatch" />
        <h1>{name}</h1>
        <span className="meta">
          {eur(d.stats.total)} in {d.year} · {eur(d.stats.average)} a month on average · {plural(d.stats.count, "purchase")}
        </span>
        <span className="sp" />
        {yearTabs}
      </div>
      {sel && (
        <div className="mphone">
          <b>{eur(sel.total)}</b>
          {monthWord(sel.month)} · average {eur(d.stats.average)}
        </div>
      )}

      <section className="mod" aria-label={grain === "year" ? "Per year" : `Per month, ${d.year}`}>
        <div className="mh">
          <h2>{grain === "year" ? "Per year" : `Per month, ${d.year}`}</h2>
          <span className="c mhide">{grain === "year" ? "click a year to see its months" : "click a month to see where it went"}</span>
          {grain === "month" && d.stats.average > 0 && (
            <span className="ck mhide">
              <i className="dash" />
              average {eur(d.stats.average)}
            </span>
          )}
          {grain === "month" && twoMonths && (
            <span className="ck mhide">
              <i className="band" />
              your range {eur(d.stats.low)}–{eur(d.stats.high)}
            </span>
          )}
          <span className="msp" />
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
        <Columns
          columns={columns}
          colour="var(--cc)"
          typical={grain === "month" ? d.stats.average : undefined}
          band={grain === "month" && twoMonths ? [d.stats.low, d.stats.high] : undefined}
          onPick={(k) => {
            if (grain === "year") {
              onYear(k);
              setGrain("month");
            } else select(k);
          }}
          label={`${name} per ${grain} ${grain === "month" ? `in ${d.year}` : ""}`}
          tip={
            grain === "month" && sel ? (
              <>
                <b>
                  {monthWord(sel.month)} · {eur(sel.total)}
                </b>
                <span className="q3">
                  {plural(sel.count, "purchase")}
                  {sel.partial ? " · so far" : twoMonths && sel.total === d.stats.high ? " · your highest month" : twoMonths && sel.total === d.stats.low ? " · your lowest month" : ""}
                </span>
              </>
            ) : undefined
          }
        />
        {shown && (
          <p className="q3 msel">
            {monthLong(shown.month)}: <b>{eur(shown.total)}</b>
            {shown.typical > 0 && (
              <>
                , {eur(Math.abs(shown.total - shown.typical))} {shown.total > shown.typical ? "over" : "under"} a typical {eur(shown.typical)} of {name.toLowerCase()}, against the complete months around it
              </>
            )}
            {!shown.complete && " (the statement stops inside it)"}.{shown.refunded > 0 && ` ${eur(shown.refunded)} refunded, already off the total.`}
          </p>
        )}
      </section>

      <div className="mlower">
        <section className="mod" aria-label="Where it went">
          <div className="mh">
            <h2>{byMonth ? `Where it went in ${monthWord(month!)}` : `Where it went in ${d.year}`}</h2>
            <span className="c">{plural(list.length, "shop")}</span>
            <span className="msp" />
            {shown && adds && (
              <Segmented
                label="Which months"
                items={[
                  { id: "month", label: monthWord(shown.month) },
                  { id: "year", label: `All ${d.year}` },
                ]}
                value={scope}
                onChange={setScope}
              />
            )}
          </div>
          {list.length === 0 ? (
            <p className="q3">Nothing in {byMonth ? monthLong(month!) : d.year}.</p>
          ) : (
            list.map((m) => (
              <a key={m.name} className="row mshop" {...link(to.merchant(m.name, name))}>
                <span className="x">
                  <span className="t">{m.name}</span>
                  <span className="m">{plural(m.count, "purchase")}</span>
                </span>
                <span className="ui-bar">
                  <i style={{ width: `${Math.max(0, m.total / top) * 100}%` }} />
                </span>
                <span className="r">{eur(m.total)}</span>
              </a>
            ))
          )}
        </section>

        {shown && (
          <section className="mod" aria-label={`${monthWord(shown.month)}'s purchases`}>
            <div className="mh">
              <h2>{monthWord(shown.month)}'s purchases</h2>
              <a className="c" {...link(to.spending(shown.month))}>
                {shown.count}
              </a>
              {purchases.length > SHOWN && (
                <a
                  className="go"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    setAll(!all);
                  }}
                >
                  {all ? "Fewer" : "Show all →"}
                </a>
              )}
            </div>
            {purchases.length === 0 ? (
              <p className="q3">Nothing in {monthLong(shown.month)}.</p>
            ) : (
              (all ? purchases : purchases.slice(0, SHOWN)).map((t, n) => (
                <a key={`${t.date}-${n}`} className={`row mtx ${t.refund ? "refund" : ""}`} {...link(to.merchant(t.description, name))}>
                  <span className="dd">{`${weekday(t.date)} ${Number(t.date.slice(8, 10))}`}</span>
                  <span className="x">
                    <span className="t">{t.description}</span>
                    {t.refund && <span className="m">refund, already off what it refunds</span>}
                  </span>
                  <span className="r">{t.refund ? `+${eur(t.amount)}` : eur(t.amount)}</span>
                </a>
              ))
            )}
          </section>
        )}
      </div>
    </div>
  );
}

