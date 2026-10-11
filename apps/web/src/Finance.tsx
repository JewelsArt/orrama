import { rollUpYears } from "@basalt/core/spending";
import { useCallback, useEffect, useRef, useState } from "react";
import { isoLocal, monthKey, shiftMonth } from "@basalt/core/dates";
import { chargeDates, type Cadence } from "@basalt/core/subscriptions";
import type { FinancePage } from "./App.js";
import { api, unlessAborted } from "./api.js";
import { DocViewer } from "./DocViewer.js";
import { Notice } from "./ui/states.js";
import {
  IconBoulder,
  IconCash,
  IconEating,
  IconGoingOut,
  IconGroceries,
  IconHealth,
  IconOther,
  IconPlus,
  IconShopping,
  IconSoftware,
  IconTransport,
} from "./icons.js";
import type { Activity, CategoryDetail, FinanceData, Ledger, MerchantDetail, MoneyItem as Money, MonthDetail, PayslipRow, Recurring, Savings } from "@basalt/schema/responses";

/**
 * A chart column's hit area is an SVG <rect>, not a button: it took clicks but
 * not focus, so every drill-down behind a chart was mouse-only. These props
 * make one a button to the keyboard and to a screen reader.
 */
const svgButton = (label: string, act: () => void) => ({
  role: "button",
  tabIndex: 0,
  "aria-label": label,
  onClick: act,
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
    }
  },
});

/**
 * The Finance area: what comes in, what goes out, and — the part no bank app
 * can do — what an hour of your work actually paid, tracked over time.
 *
 * Every figure here is read out of Markdown tables in the vault. Uploading a
 * payslip stores the PDF and files its numbers as a row; nothing lives only in
 * the database, so the history survives a re-index.
 */

const eur = (n: number, currency = "EUR") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency, signDisplay: n < 0 ? "always" : "auto" }).format(n);
/**
 * Ledger totals, one per currency, each in its own: "€1,500.00 · $500.00".
 * Never summed — a $12 subscription is not €12, and there is no rate here to
 * make it one (FIN-017).
 */
const perCurrency = (totals: { currency: string; monthly: number }[]) =>
  totals.length === 0 ? eur(0) : totals.map((t) => eur(t.monthly, t.currency)).join(" · ");
const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
/** "3 Sept 2026" — a full date, for the ends of a range. */
const fullDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
/** "Wed" — inside a month group the date is already the heading. */
const weekday = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short" });
const kb = (n: number) => (n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * Categorical palette. Even in lightness and moderate in saturation so ten of
 * them can sit in one stacked column without any single band shouting, and so
 * the set still reads on the near-black theme. A category the rules note gives
 * no colour to falls back here by a stable hash, never by position — adding a
 * category must not recolour the others.
 */
/* Ordered so the first few — which is what the chart actually shows — land far
   apart on the hue wheel rather than next to each other. */
const FALLBACK_COLOURS = [
  "var(--cat-pink)", "var(--cat-cyan)", "var(--cat-magenta)", "var(--cat-azure)",
  "var(--cat-purple)", "var(--cat-lilac)",
];

/** Colour names the rules note may use, resolved to tokens so a category keeps
 *  its identity when the theme flips. A raw hex still works and is passed
 *  through untouched — the note is the user's, not ours. */
const NAMED = new Set(["pink", "cyan", "magenta", "azure", "purple", "lilac", "slate"]);
/** Names from earlier palettes, kept so an older rules note still resolves to
 *  the nearest member of the current one. */
const LEGACY: Record<string, string> = {
  green: "cyan", mint: "cyan", teal: "cyan", pine: "cyan", olive: "purple", sand: "magenta", amber: "magenta",
  ochre: "purple", orange: "pink", coral: "pink", brick: "pink", rose: "pink", wine: "magenta",
  blue: "azure", ocean: "azure", navy: "azure", violet: "purple", indigo: "purple", plum: "lilac",
};
const resolveColour = (raw: string | null): string | null => {
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  const token = NAMED.has(name) ? name : LEGACY[name];
  return token ? `var(--cat-${token})` : raw;
};

/** One colour function per rules note. "Other" is what the rules did NOT
 *  catch, so it wears the neutral rather than a hue drawn by hash — a grey
 *  band in the chart is the honest picture of money that has no category. */
export function paletteFor(rules: { category: string; colour: string | null }[]): (name: string) => string {
  const colours = new Map(rules.filter((r) => r.colour).map((r) => [r.category, resolveColour(r.colour)!]));
  return (name) =>
    colours.get(name) ?? (name === UNCATEGORISED ? "var(--cat-slate)" : FALLBACK_COLOURS[hashName(name) % FALLBACK_COLOURS.length]!);
}

/** Categories the chart draws in their own colour. Everything below this folds
 *  into one neutral band. Five is the size of a palette that still reads as a
 *  palette — every Coolors scheme worth saving has five swatches — and the
 *  categories past the fifth are together under a tenth of spending. */
const CHART_BANDS = 5;
const TAIL_LABEL = "Smaller categories";
const TAIL_COLOUR = "var(--cat-tail)";
/** What the rules did not catch. Mirrors UNCATEGORISED in packages/core/src/spending.ts (the web app does not depend on core). */
const UNCATEGORISED = "Other";
/** Opacity steps for the hero split, by rank. */
const SPLIT_ALPHA = [0.95, 0.68, 0.48, 0.34, 0.25, 0.18];
const hashName = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Pictogram per category, matched loosely so a renamed category still finds
 *  one. Shape carries the identity; colour only reinforces it. */
const CATEGORY_ICONS: [RegExp, () => React.ReactNode][] = [
  [/grocer|super|food shop/i, IconGroceries],
  [/eat|restaur|dining|takeaway|lunch/i, IconEating],
  [/transp|travel|commut/i, IconTransport],
  [/boulder|climb/i, IconBoulder],
  [/sport|health|fitness|medic/i, IconHealth],
  [/software|subscri|tech|tool/i, IconSoftware],
  [/shop|cloth|retail/i, IconShopping],
  [/going out|entertain|culture|leisure/i, IconGoingOut],
  [/cash|atm|withdraw/i, IconCash],
];
export const iconFor = (name: string) => (CATEGORY_ICONS.find(([re]) => re.test(name))?.[1] ?? IconOther)();

/**
 * Round axis values: 1, 2, 2.5 or 5 times a power of ten.
 *
 * A chart whose gridlines read €317 / €634 / €951 is arithmetically correct and
 * useless — the reader has to do division to place a bar. Snapping the step to
 * a number people count in is what makes an axis readable at a glance.
 */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw)! * mag;
  const out: number[] = [];
  for (let v = step; v <= max * 1.0001; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/**
 * One stacked column per month.
 *
 * Three things keep it legible rather than merely colourful: only the largest
 * few categories get their own band and the rest fold into one neutral block;
 * the whole column is clipped to a rounded top so a stack of rectangles reads
 * as a single bar; and a dashed line marks the typical month, which is what
 * makes any individual column mean something.
 *
 * The month the statement stops inside is drawn faded and labelled — it is a
 * few days of data and comparing it to a full month is the mistake the chart
 * should be helping you avoid.
 */
function StackedMonths({
  months,
  bands,
  colour,
  active,
  onHover,
  lastComplete,
  typical,
  onPick,
  period = "month",
  partialYears = [],
}: {
  months: { month: string; byCategory: Record<string, number>; total: number }[];
  bands: string[];
  colour: (name: string) => string;
  active: string | null;
  onHover: (name: string | null) => void;
  lastComplete: string | null;
  typical: number;
  /** Every column is a door to that month (or, by year, to that year's months). */
  onPick: (month: string) => void;
  /** "year": each column is a calendar year, keyed "2025". */
  period?: "month" | "year";
  /** Years the statements only partly cover (period "year"). */
  partialYears?: string[];
}) {
  if (months.length === 0) return null;
  const byYear = period === "year";
  const fullName = (k: string) => (byYear ? k : monthName(k));
  const shortName = (k: string) => (byYear ? k : monthName(k).split(" ")[0]);
  const isPartial = (k: string) => (byYear ? partialYears.includes(k) : lastComplete !== null && k > lastComplete);
  const W = 760;
  const H = 210;
  const pad = { t: 16, b: 30, r: 46 };
  const plot = H - pad.t - pad.b;
  const max = Math.max(1, ...months.map((m) => m.total));
  const slot = (W - pad.r) / months.length;
  const barW = Math.min(52, slot * 0.56);
  const y0 = H - pad.b;
  const typicalY = y0 - (typical / max) * plot;

  return (
    <svg className="fin-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={byYear ? "Yearly spending by category" : "Monthly spending by category"}>
      <defs>
        {months.map((m, i) => {
          const h = (m.total / max) * plot;
          return (
            <clipPath key={m.month} id={`col-${i}`}>
              {/* Rounds the column's top only; the radius is capped at half the
                  height so a short month is not turned into a lozenge. */}
              <rect
                x={i * slot + (slot - barW) / 2}
                y={y0 - h}
                width={barW}
                height={h}
                rx={Math.min(5, h / 2)}
              />
            </clipPath>
          );
        })}
      </defs>

      {/* Value gridlines behind everything, so a bar can be read without
          hovering it. The axis itself is drawn solid on top of them. */}
      {/* A tick that lands on top of the typical line is dropped: two labels in
          the same 12px are unreadable, and the datum is the more useful one. */}
      {niceTicks(max)
        .filter((v) => typical <= 0 || Math.abs((v / max) * plot - (typical / max) * plot) > 12)
        .map((v) => (
        <g key={v}>
          <line x1="0" x2={W - pad.r + 6} y1={y0 - (v / max) * plot} y2={y0 - (v / max) * plot} className="fin-grid-line" />
          <text x={W - pad.r + 12} y={y0 - (v / max) * plot + 3.5} className="fin-chart-axis">
            {`€${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}`}
          </text>
        </g>
      ))}
      <line x1="0" x2={W - pad.r + 6} y1={y0} y2={y0} className="fin-axis" />
      {typical > 0 && (
        <>
          <line x1="0" x2={W - pad.r + 6} y1={typicalY} y2={typicalY} className="fin-typical" />
          <text x={W - pad.r + 12} y={typicalY + 3.5} className="fin-chart-axis">
            {`€${Math.round(typical)}`}
          </text>
        </>
      )}

      {months.map((m, i) => {
        const x = i * slot + (slot - barW) / 2;
        const partial = isPartial(m.month);
        let y = y0;
        return (
          <g key={m.month} className="fin-col" opacity={partial ? 0.42 : 1}>
            <g clipPath={`url(#col-${i})`}>
              {bands.map((cat) => {
                const v = cat === TAIL_LABEL
                  ? Object.entries(m.byCategory).reduce((a, [k, n]) => (bands.includes(k) ? a : a + n), 0)
                  : (m.byCategory[cat] ?? 0);
                if (v <= 0) return null;
                const h = (v / max) * plot;
                y -= h;
                const dim = active !== null && active !== cat;
                return (
                  <rect
                    key={cat}
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                    fill={cat === TAIL_LABEL ? TAIL_COLOUR : colour(cat)}
                    className="fin-seg"
                    opacity={dim ? 0.16 : 1}
                    onMouseEnter={() => onHover(cat)}
                    onMouseLeave={() => onHover(null)}
                  >
                    <title>{`${cat} · ${fullName(m.month)} · €${v.toFixed(2)}`}</title>
                  </rect>
                );
              })}
            </g>
            <text x={x + barW / 2} y={H - 10} textAnchor="middle" className="fin-chart-lbl">
              {shortName(m.month)}
            </text>
            <text x={x + barW / 2} y={y - 7} textAnchor="middle" className="fin-chart-total">
              {partial ? (byYear ? `€${Math.round(m.total)} · part year` : "part month") : `€${Math.round(m.total)}`}
            </text>
            {/* The hit area spans the whole slot, not just the drawn bar: a
                thin month must not be harder to open than a fat one. */}
            <rect
              className="fin-hit"
              x={i * slot}
              y={pad.t}
              width={slot}
              height={plot}
              {...svgButton(byYear ? `Show ${m.month} month by month` : `Open ${monthName(m.month)}`, () => onPick(m.month))}
            >
              <title>{byYear ? `Show ${m.month} month by month` : `Open ${monthName(m.month)}`}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

type Grain = "month" | "year";
const GRAIN_KEY = "basalt-fin-grain";
/** Month or Year, remembered per viewer. Storage can be unavailable; the default still works. */
function useGrain(): [Grain, (g: Grain) => void] {
  const [grain, setGrain] = useState<Grain>(() => {
    try {
      return localStorage.getItem(GRAIN_KEY) === "year" ? "year" : "month";
    } catch {
      return "month";
    }
  });
  const set = (g: Grain) => {
    setGrain(g);
    try {
      localStorage.setItem(GRAIN_KEY, g);
    } catch {
      /* not remembered, still switched */
    }
  };
  return [grain, set];
}

/** The Month | Year switch shared by the spending charts. */
function GrainToggle({ grain, onChange }: { grain: Grain; onChange: (g: Grain) => void }) {
  return (
    <div className="fin-years fin-grain" role="tablist" aria-label="Show by">
      {(["month", "year"] as const).map((g) => (
        <button key={g} role="tab" aria-selected={grain === g} className={`fin-year ${grain === g ? "on" : ""}`} onClick={() => onChange(g)}>
          {g === "month" ? "Month" : "Year"}
        </button>
      ))}
    </div>
  );
}

export function Finance({
  onOpenNote,
  category,
  merchant,
  page,
  month,
  onOpenCategory,
  onOpenMerchant,
  onOpenPage,
  onOpenMonth,
  onBack,
}: {
  onOpenNote: (id: string) => void;
  category?: string;
  merchant?: string;
  page?: FinancePage;
  month?: string;
  onOpenCategory: (name: string) => void;
  onOpenMerchant: (name: string) => void;
  onOpenPage: (page: FinancePage) => void;
  onOpenMonth: (month: string, category?: string) => void;
  onBack: () => void;
}) {
  /**
   * One route, several pages, narrowing at each step: overview → all spending →
   * one category → one month of it → one merchant's actual transactions. The
   * order below is the specificity order — a month wins over the category it
   * was opened from, because `category` is still set and is what filters it.
   */
  if (month) return <MonthPage month={month} category={category} onBack={onBack} onOpenMonth={onOpenMonth} onOpenCategory={onOpenCategory} onOpenMerchant={onOpenMerchant} />;
  if (merchant) return <MerchantPage name={merchant} onBack={onBack} onOpenMonth={onOpenMonth} />;
  if (page === "documents") return <DocumentsPage onBack={onBack} />;
  if (page === "subscriptions" || page === "income")
    return <LedgerPage kind={page} onBack={onBack} onOpenNote={onOpenNote} onOpenMerchant={onOpenMerchant} />;
  if (page === "savings") return <SavingsPage onBack={onBack} onOpenCategory={onOpenCategory} />;
  if (page === "spending" || category === SPENDING_PAGE)
    return <SpendingPage onOpenNote={onOpenNote} onOpenCategory={onOpenCategory} onOpenMonth={onOpenMonth} onBack={onBack} />;
  if (category) return <CategoryPage name={category} onBack={onBack} onOpenMerchant={onOpenMerchant} onOpenMonth={onOpenMonth} />;
  return <FinanceOverview onOpenNote={onOpenNote} onOpenCategory={onOpenCategory} onOpenPage={onOpenPage} onOpenMonth={onOpenMonth} />;
}

/** Every transaction with one merchant, grouped by month, newest first. */
function MerchantPage({
  name,
  onBack,
  onOpenMonth,
}: {
  name: string;
  onBack: () => void;
  onOpenMonth: (month: string, category?: string) => void;
}) {
  const [d, setD] = useState<MerchantDetail | null>(null);
  const [year, setYear] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    const q = year ? `?year=${encodeURIComponent(year)}` : "";
    void api<MerchantDetail>("GET", `/api/finance/merchant/${encodeURIComponent(name)}${q}`, undefined, { signal: ac.signal }).then(setD, unlessAborted);
    return () => ac.abort();
  }, [name, year]);

  if (!d) return <div className="fin"><p className="fin-loading">Reading {name}…</p></div>;

  // Grouped here rather than server-side: the client already needs the flat
  // list, and a month header is presentation.
  const groups = new Map<string, MerchantDetail["transactions"]>();
  for (const t of d.transactions) {
    const k = t.date.slice(0, 7);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const maxMonth = Math.max(1, ...d.months.map((m) => m.total));

  return (
    <div className="fin">
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Back</button>
          <div>
            <h1 className="fin-h1">{d.merchant}</h1>
            <p className="fin-sub">
              {d.stats.first && d.stats.last
                ? `${d.stats.count} transactions · ${fullDate(d.stats.first)} to ${fullDate(d.stats.last)}`
                : "No transactions in this year."}
            </p>
          </div>
        </div>
        {d.years.length > 0 && (
          <div className="fin-years" role="tablist" aria-label="Year">
            {d.years.map((y) => (
              <button key={y} role="tab" aria-selected={y === d.year} className={`fin-year ${y === d.year ? "on" : ""}`} onClick={() => setYear(y)}>
                {y}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="fin-kpis">
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">{d.direction === "in" ? `Received ${d.year}` : `Total ${d.year}`}</span>
          <b>{eur(d.stats.total)}</b>
          <span className="fin-kpi-sub">{d.stats.allTime !== d.stats.total ? `${eur(d.stats.allTime)} all time` : "all of it"}</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">{d.direction === "in" ? "Usually" : "Average"}</span>
          <b>{eur(d.stats.average)}</b>
          <span className="fin-kpi-sub">{d.direction === "in" ? "most months" : "per transaction"}</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">Biggest</span>
          <b>{eur(d.stats.biggest)}</b>
          <span className="fin-kpi-sub">single transaction</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">Frequency</span>
          <b>{d.months.length > 0 ? (d.stats.count / d.months.length).toFixed(1) : "0"}</b>
          <span className="fin-kpi-sub">
            times a month, on the months {d.direction === "in" ? "it paid" : "you went"}
          </span>
        </div>
      </div>

      <div className="fin-grid">
        <section className="fin-card fin-span">
          <div className="fin-card-head">
            <h2>Transactions</h2>
            <span className="fin-count">{d.transactions.length}</span>
          </div>
          {d.transactions.length > 0 ? (
            <ul className="fin-txns">
              {[...groups].map(([month, rows]) => {
                const monthTotal = d.months.find((m) => m.month === month)?.total ?? 0;
                return (
                  <li key={month}>
                    {/* A banded header, not another row. The old version put a
                        full-width bar and a bold figure on the same rhythm as
                        the transactions beneath it, so the months stopped
                        reading as groups at all. */}
                    <button className="fin-txn-month as-button" onClick={() => onOpenMonth(month)}>
                      <span className="m">{monthName(month)}</span>
                      <span className="n">{rows.length} transaction{rows.length === 1 ? "" : "s"}</span>
                      <b>{eur(monthTotal)}</b>
                      <span className="fin-merch-chev" aria-hidden>›</span>
                      <i className="share" style={{ width: `${(monthTotal / maxMonth) * 100}%` }} />
                    </button>
                    <ul className="fin-txn-rows">
                      {rows.map((t, i) => (
                        <li key={`${t.date}:${i}`} className={t.refund ? "refund" : ""}>
                          <span className="fin-txn-day">
                            <b>{t.date.slice(8, 10)}</b>
                            <em>{weekday(t.date)}</em>
                          </span>
                          {/* Only the exceptions are worth naming; "Card Payment"
                              on all eleven rows says nothing. */}
                          <span className="fin-txn-type">{t.type === "Card Payment" ? "Card" : t.type}</span>
                          <span className="fin-txn-amt">{t.refund ? `+${eur(t.amount)}` : eur(t.amount)}</span>
                          <span className="fin-txn-bal">{t.balance !== null ? `balance ${eur(t.balance)}` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="fin-empty-line">Nothing in {d.year}.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** Reserved route name — no category can be called this. */
const SPENDING_PAGE = "__spending";

/** Days already elapsed in the month the data reaches, and the month's length. */
function monthPace(dataThrough: string | null): { elapsed: number; length: number } | null {
  if (!dataThrough) return null;
  const [y, m, d] = dataThrough.split("-").map(Number) as [number, number, number];
  return { elapsed: d, length: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

/**
 * One category, month by month.
 *
 * A line rather than bars: bars invite you to compare twelve independent
 * quantities, and the question here is the shape of one quantity over time.
 */
function CategoryPage({
  name,
  onBack,
  onOpenMerchant,
  onOpenMonth,
}: {
  name: string;
  onBack: () => void;
  onOpenMerchant: (merchant: string) => void;
  onOpenMonth: (month: string, category?: string) => void;
}) {
  const [d, setD] = useState<CategoryDetail | null>(null);
  const [year, setYear] = useState<string | null>(null);
  const [grain, setGrain] = useGrain();

  useEffect(() => {
    const ac = new AbortController();
    const q = year ? `?year=${encodeURIComponent(year)}` : "";
    void api<CategoryDetail>("GET", `/api/finance/category/${encodeURIComponent(name)}${q}`, undefined, { signal: ac.signal }).then(setD, unlessAborted);
    return () => ac.abort();
  }, [name, year]);

  if (!d) return <div className="fin"><p className="fin-loading">Reading {name}…</p></div>;

  const colour = paletteFor(d.colour ? [{ category: name, colour: d.colour }] : [])(name);
  // The server's, over the complete months it names — never the part-month.
  const avg = d.stats.average;

  return (
    <div className="fin">
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Finance</button>
          <span className="fin-detail-ic" style={{ color: colour }}>{iconFor(name)}</span>
          <div>
            <h1 className="fin-h1">{name}</h1>
            <p className="fin-sub">
              {d.stats.count} transactions across {d.stats.activeMonths} month{d.stats.activeMonths === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        {d.years.length > 0 && (
          <div className="fin-years" role="tablist" aria-label="Year">
            {d.years.map((y) => (
              <button
                key={y}
                role="tab"
                aria-selected={y === d.year}
                className={`fin-year ${y === d.year ? "on" : ""}`}
                onClick={() => setYear(y)}
              >
                {y}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="fin-kpis">
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">Total {d.year}</span>
          <b style={{ color: colour }}>{eur(d.stats.total)}</b>
          <span className="fin-kpi-sub">{d.stats.count} transactions</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">Monthly average</span>
          <b style={{ color: colour }}>{eur(avg)}</b>
          <span className="fin-kpi-sub">over {d.stats.activeMonths} months with spending</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">Highest month</span>
          <b style={{ color: colour }}>{eur(d.stats.high)}</b>
          <span className="fin-kpi-sub">lowest {eur(d.stats.low)}</span>
        </div>
        <div className="fin-kpi">
          <span className="fin-kpi-lbl">Merchants</span>
          <b style={{ color: colour }}>{d.merchants.length}</b>
          <span className="fin-kpi-sub">{d.merchants[0]?.name.slice(0, 22) ?? "—"}</span>
        </div>
      </div>

      <div className="fin-grid">
        <section className="fin-card fin-span fin-plot">
          <div className="fin-card-head">
            <h2>{grain === "year" ? "Per year" : `Per month, ${d.year}`}</h2>
            <GrainToggle grain={grain} onChange={setGrain} />
          </div>
          {grain === "year" ? (
            <LineMonths
              period="year"
              series={d.yearly.map((y) => ({ month: y.year, total: y.total, hasData: y.count > 0, future: false, partial: y.partial }))}
              colour={colour}
              average={(() => {
                const whole = d.yearly.filter((y) => !y.partial && y.count > 0);
                return whole.length ? whole.reduce((a, y) => a + y.total, 0) / whole.length : 0;
              })()}
              onPick={(y) => {
                setYear(y);
                setGrain("month");
              }}
            />
          ) : (
            <LineMonths series={d.series} colour={colour} average={avg} onPick={(m) => onOpenMonth(m, name)} />
          )}
        </section>

        <section className="fin-card fin-span">
          <div className="fin-card-head">
            <h2>Where it went</h2>
            <span className="fin-count">{d.merchants.length} merchants</span>
          </div>
          {d.merchants.length > 0 ? (
            <ul className="fin-merchants fin-merchants-flat" style={{ ["--c" as string]: colour }}>
              {d.merchants.map((m) => (
                <li key={m.name}>
                  <button className="fin-merch-row" onClick={() => onOpenMerchant(m.name)}>
                    <span className="fin-merch-bar" style={{ width: `${(m.total / (d.merchants[0]?.total || 1)) * 100}%` }} />
                    <span className="fin-merch-name">{m.name}</span>
                    <span className="fin-merch-n">{m.count}×</span>
                    <span className="fin-merch-amt">{eur(m.total)}</span>
                    <span className="fin-merch-chev" aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="fin-empty-line">Nothing in {d.year}.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/** A year of one category: smooth line, soft fill, the average as a datum. */
function LineMonths({
  series,
  colour,
  average,
  onPick,
  period = "month",
}: {
  /** "year": each point is a calendar year, keyed "2025". */
  period?: "month" | "year";
  series: { month: string; total: number; hasData: boolean; future: boolean; partial: boolean }[];
  colour: string;
  average: number;
  /** Clicking a month opens that month, filtered to this category. */
  onPick: (month: string) => void;
}) {
  const W = 760;
  const H = 240;
  const pad = { t: 18, r: 52, b: 30, l: 8 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = Math.max(1, ...series.map((m) => m.total));
  const x = (i: number) => pad.l + (i / Math.max(series.length - 1, 1)) * iw;
  const y = (v: number) => pad.t + ih - (v / max) * ih;

  // The line stops where the data does. Carrying it on to December would draw a
  // collapse to zero for months the year has not reached — the opposite of what
  // happened. Their labels stay on the axis so the year is still a year.
  const drawn = series.filter((m) => !m.future);
  const avgY = y(average);

  // Catmull-Rom-ish smoothing through the points; the shape is the message and
  // a polyline of twelve segments reads as noise.
  const path = drawn
    .map((m, i) => {
      const px = x(i);
      const py = y(m.total);
      if (i === 0) return `M ${px},${py}`;
      const prevX = x(i - 1);
      const prevY = y(drawn[i - 1]!.total);
      const midX = (prevX + px) / 2;
      return ` C ${midX},${prevY} ${midX},${py} ${px},${py}`;
    })
    .join("");

  return (
    <svg className="fin-line" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={period === "year" ? "Spending per year" : "Spending per month"}>
      <defs>
        <linearGradient id="finFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.22" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      {niceTicks(max)
        .filter((v) => average <= 0 || Math.abs(y(v) - avgY) > 12)
        .map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="fin-grid-line" />
          <text x={W - pad.r + 8} y={y(v) + 3.5} className="fin-chart-axis">
            {`€${v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}`}
          </text>
        </g>
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={pad.t + ih} y2={pad.t + ih} className="fin-axis" />
      {average > 0 && (
        <>
          <line x1={pad.l} x2={W - pad.r} y1={avgY} y2={avgY} className="fin-typical" />
          <text x={W - pad.r + 8} y={avgY + 3.5} className="fin-chart-axis">{`€${Math.round(average)}`}</text>
        </>
      )}
      <path d={`${path} L ${x(drawn.length - 1)},${pad.t + ih} L ${x(0)},${pad.t + ih} Z`} fill="url(#finFill)" />
      <path d={path} fill="none" stroke={colour} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {series.map((m, i) => (
        <g key={m.month} className="fin-pt">
          {!m.future && (
            <>
              {/* Hollow marks a month still running; a filled dot is settled. */}
              <circle
                cx={x(i)}
                cy={y(m.total)}
                r="3.5"
                fill={m.partial ? "var(--surface)" : colour}
                stroke={colour}
                strokeWidth="2"
              />
              <text x={x(i)} y={y(m.total) - 10} textAnchor="middle" className="fin-chart-total">
                {m.partial ? (period === "year" ? `€${Math.round(m.total)} · part year` : "so far") : `€${Math.round(m.total)}`}
              </text>
            </>
          )}
          <text x={x(i)} y={H - 10} textAnchor="middle" className={`fin-chart-lbl ${m.future ? "ahead" : ""}`}>
            {period === "year" ? m.month : monthName(m.month).split(" ")[0]}
          </text>
          <rect
            className={m.future ? "" : "fin-hit"}
            x={x(i) - 18}
            y={pad.t}
            width="36"
            height={ih}
            fill="transparent"
            {...(m.future ? {} : svgButton(period === "year" ? `Show ${m.month} month by month` : `Open ${monthName(m.month)}`, () => onPick(m.month)))}
          >
            {!m.future && <title>{period === "year" ? `Show ${m.month} month by month` : `Open ${monthName(m.month)}`}</title>}
          </rect>
        </g>
      ))}
    </svg>
  );
}

/**
 * Spending in full: the stacked year and every category.
 *
 * This is where the detail moved to when the overview became a dashboard. The
 * overview answers "how is this month going"; this answers "what does a year of
 * my spending look like", and they are different questions that were fighting
 * for the same screen.
 */
function SpendingPage({
  onOpenNote,
  onOpenCategory,
  onOpenMonth,
  onBack,
}: {
  onOpenNote: (id: string) => void;
  onOpenCategory: (name: string) => void;
  onOpenMonth: (month: string, category?: string) => void;
  onBack: () => void;
}) {
  const [d, setD] = useState<FinanceData | null>(null);
  const [hot, setHot] = useState<string | null>(null);
  const [grain, setGrain] = useGrain();
  const [year, setYear] = useState<string | null>(null);
  useEffect(() => {
    void api<FinanceData>("GET", "/api/finance").then(setD);
  }, []);
  if (!d) return <div className="fin"><p className="fin-loading">Reading the statements…</p></div>;

  const cats = d.spending.categories;
  const colourOf = paletteFor(cats.rules);
  const catOrder = cats.forecast.map((f) => f.category);
  const chartBands = catOrder.length > CHART_BANDS ? [...catOrder.slice(0, CHART_BANDS), TAIL_LABEL] : catOrder;
  const catMax = Math.max(1, ...cats.forecast.map((f) => f.high));
  // A typical month is the server's, not a sum of per-category medians. Those
  // two answers differed by 14% on the real statement, which is how this page
  // and the month page it opens came to disagree (audit).
  const typicalTotal = cats.typical ?? 0;
  // The category shares are a different quantity and keep their own
  // denominator: each row's share of what the categories typically add up to.
  const categoryTypicalTotal = cats.forecast.reduce((a, f) => a + f.typical, 0);
  const lastFull = cats.lastComplete ? cats.months.find((m) => m.month === cats.lastComplete) : undefined;
  // Years of statements are too many columns for one chart: by month it shows
  // one year at a time (latest first), by year one column per calendar year.
  const years = [...new Set(cats.months.map((m) => m.month.slice(0, 4)))].sort().reverse();
  const shownYear = year && years.includes(year) ? year : (years[0] ?? null);
  const yearRows = rollUpYears(cats.months, cats.months[0]?.month ?? null, cats.lastComplete);

  return (
    <div className="fin">
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Finance</button>
          <div>
            <h1 className="fin-h1">Spending</h1>
            <p className="fin-sub">
              {d.spending.txnCount} transactions · {cats.completeMonths} complete months
            </p>
          </div>
        </div>
        {cats.noteId && (
          <button className="fin-link" onClick={() => onOpenNote(cats.noteId!)}>Edit rules</button>
        )}
      </header>

      <div className="fin-grid">
        <section className="fin-card fin-span fin-plot">
          <div className="fin-head-num">
            <b>{eur(typicalTotal)}</b>
            <span>
              a typical month
              {lastFull && (
                <em className={lastFull.total > typicalTotal ? "over" : "under"}>
                  {monthName(lastFull.month)} was {eur(lastFull.total)}
                </em>
              )}
            </span>
          </div>
          <div className="fin-chart-controls">
            <GrainToggle grain={grain} onChange={setGrain} />
            {grain === "month" && years.length > 1 && (
              <div className="fin-years" role="tablist" aria-label="Year">
                {years.map((y) => (
                  <button key={y} role="tab" aria-selected={y === shownYear} className={`fin-year ${y === shownYear ? "on" : ""}`} onClick={() => setYear(y)}>
                    {y}
                  </button>
                ))}
              </div>
            )}
          </div>
          {grain === "month" ? (
            <StackedMonths
              months={cats.months.filter((m) => shownYear !== null && m.month.startsWith(shownYear))}
              bands={chartBands}
              colour={colourOf}
              active={hot}
              onHover={setHot}
              lastComplete={cats.lastComplete}
              typical={typicalTotal}
              onPick={(m) => onOpenMonth(m)}
            />
          ) : (
            <StackedMonths
              period="year"
              months={yearRows.map((y) => ({ month: y.year, byCategory: y.byCategory, total: y.total }))}
              partialYears={yearRows.filter((y) => y.partial).map((y) => y.year)}
              bands={chartBands}
              colour={colourOf}
              active={hot}
              onHover={setHot}
              lastComplete={cats.lastComplete}
              typical={typicalTotal * 12}
              onPick={(y) => {
                setYear(y);
                setGrain("month");
              }}
            />
          )}
          <ul className="fin-cats">
            {cats.forecast.map((f) => {
              const delta = f.last !== null ? f.last - f.typical : null;
              const share = categoryTypicalTotal > 0 ? Math.round((f.typical / categoryTypicalTotal) * 100) : 0;
              const c = colourOf(f.category);
              return (
                <li
                  key={f.category}
                  className={`fin-cat ${hot === f.category ? "hot" : ""} ${hot && hot !== f.category ? "cool" : ""}`}
                  style={{ ["--c" as string]: c }}
                  onMouseEnter={() => setHot(f.category)}
                  onMouseLeave={() => setHot(null)}
                >
                  <button className="fin-cat-row" onClick={() => onOpenCategory(f.category)} aria-label={`Open ${f.category}`}>
                    <span className="fin-cat-ic">{iconFor(f.category)}</span>
                    <span className="fin-cat-name">
                      {f.category}
                      <em>{share}% of spending</em>
                    </span>
                    <span className="fin-cat-range" title={`${eur(f.low)} to ${eur(f.high)} a month`}>
                      <i className="span" style={{ left: `${(f.low / catMax) * 100}%`, width: `${Math.max((f.high - f.low) / catMax, 0.004) * 100}%` }} />
                      <i className="mark" style={{ left: `${(f.typical / catMax) * 100}%` }} />
                      {f.last !== null && <i className="lastmark" style={{ left: `${(f.last / catMax) * 100}%` }} />}
                    </span>
                    <span className="fin-cat-typ">{eur(f.typical)}</span>
                    <span className={`fin-cat-last ${delta !== null && delta > 0 ? "over" : delta !== null && delta < 0 ? "under" : ""}`}>
                      <span className="fin-pill">
                        {delta === null || delta === 0 ? "—" : `${delta > 0 ? "▲" : "▼"} ${eur(Math.abs(delta))}`}
                      </span>
                      <em>{delta === null || delta === 0 ? "as usual" : delta > 0 ? "over usual" : "under usual"}</em>
                    </span>
                    <span className="fin-cat-chev" aria-hidden>›</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="fin-legend">
            Typical is the median of the last {cats.completeMonths} complete months, so one large purchase does not become next
            month&apos;s expectation. The bar spans the lowest and highest month.
            {grain === "year" && " By year, the dashed line is twelve typical months, and a faded column is a year the statements only partly cover."}
          </p>
        </section>
      </div>
    </div>
  );
}

function FinanceOverview({
  onOpenNote,
  onOpenCategory,
  onOpenPage,
  onOpenMonth,
}: {
  onOpenNote: (id: string) => void;
  onOpenCategory: (name: string) => void;
  onOpenPage: (page: FinancePage) => void;
  onOpenMonth: (month: string, category?: string) => void;
}) {
  const [d, setD] = useState<FinanceData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => setD(await api<FinanceData>("GET", "/api/finance")), []);
  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setBusy(file.name);
      try {
        // Base64 over JSON, like project documents — no multipart parser to keep.
        const buf = await file.arrayBuffer();
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const res = await api<{ name: string; stored: boolean; filed: boolean; reason?: string; parsed: { month: string | null } | null; statement?: StatementRead | null }>(
          "POST",
          "/api/finance/payslip",
          { name: file.name, dataBase64: btoa(bin) },
        );
        setFlash(
          res.statement !== undefined
            ? statementFlash(res.name, res.statement)
            : res.filed
              ? `Filed ${res.parsed?.month ?? file.name}.`
              : res.stored
                ? `Stored ${res.name}, but the figures were not filed — ${res.reason ?? "unknown reason"}.`
                : `Not stored — ${res.reason ?? "unknown reason"}.`,
        );
      } catch (e) {
        setFlash(e instanceof Error ? e.message : `Could not upload ${file.name}`);
      }
    }
    setBusy(null);
    await load();
  };

  if (!d) return <div className="fin"><p className="fin-loading">Reading the ledgers…</p></div>;

  const cats = d.spending.categories;
  const colourOf = paletteFor(cats.rules);
  const typicalTotal = cats.typical ?? 0;

  // This month, which is the question the page should answer first.
  const current = d.spending.months[d.spending.months.length - 1];
  const pace = monthPace(d.spending.dataThrough);
  const soFar = current?.spend ?? 0;
  // Projected only once there is enough of the month to extrapolate from —
  // three days times ten is arithmetic, not a forecast.
  const projected = pace && pace.elapsed >= 7 ? Math.round((soFar / pace.elapsed) * pace.length) : null;
  // The track runs to 1.6× a typical month, so overspending has somewhere to
  // go. The typical marker's position is derived from that same number rather
  // than hardcoded in CSS, where it would silently drift if the cap changed.
  const PACE_CEILING = 1.6;
  const paceRatio = typicalTotal > 0 ? Math.min((projected ?? soFar) / typicalTotal, PACE_CEILING) : 0;
  const monthSplit = cats.months.find((m) => m.month === current?.month)?.byCategory ?? {};

  const lastComplete = cats.lastComplete;
  const top = cats.forecast.slice(0, 3);
  const rest = cats.forecast.slice(3).filter((f) => f.typical > 0 || (f.last ?? 0) > 0);

  const slips = d.payslips;
  const latest = slips[slips.length - 1];

  return (
    <div className="fin">
      <header className="fin-top">
        <div>
          <h1 className="fin-h1">Finance</h1>
          <p className="fin-sub">What comes in, what goes out, and what an hour actually pays.</p>
        </div>
        <div className="fin-top-tools">
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.csv,.xlsx"
            multiple
            hidden
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <button className="fin-upload" onClick={() => fileInput.current?.click()} disabled={!!busy}>
            <IconPlus />
            {busy ? `Reading ${busy}…` : "Upload"}
          </button>
        </div>
      </header>

      {d.spending.excluded.length > 0 && (
        <div className="fin-unreadables">
          <Notice
            title={`${d.spending.excluded.length} statement ${d.spending.excluded.length === 1 ? "file is" : "files are"} left out of the figures`}
            text={d.spending.excluded.map((f) => (
              <span key={f.name} className="fin-unreadable">
                {f.name}: {f.reason}.
              </span>
            ))}
          />
        </div>
      )}

      {flash && (
        <div className="fin-flash" role="status">
          {flash}
          <button onClick={() => setFlash(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      <div className="fin-hero-grid">
        {/* One number dominates: what this month has cost so far, against what a
            month usually costs. Everything else on the page is subordinate. */}
        <button className="fin-card fin-hero" onClick={() => onOpenCategory(SPENDING_PAGE)}>
          <span className="fin-hero-lbl">
            Spent in {current ? monthName(current.month) : "—"}
            {pace && <em>day {pace.elapsed} of {pace.length}</em>}
          </span>
          <b className="fin-hero-num">{eur(soFar)}</b>
          <span className="fin-hero-pace">
            <i className="track">
              <i className="fill" style={{ width: `${(paceRatio / PACE_CEILING) * 100}%` }} />
              <i className="typical" style={{ left: `${(1 / PACE_CEILING) * 100}%` }} />
            </i>
            <em>
              {projected !== null
                ? `on pace for ${eur(projected)} · typically ${eur(typicalTotal)}`
                : `typically ${eur(typicalTotal)} a month`}
            </em>
          </span>
          {/* The month so far, split by category. On the violet card the split is
              white at stepped opacity, biggest share brightest — not the category
              colours. Green and blue strips on a violet ground were three hues
              fighting; a one-colour card with tonal steps reads as one object,
              and the category names are a hover away. */}
          <span className="fin-hero-split">
            {top.concat(rest)
              .map((f) => [f.category, monthSplit[f.category] ?? 0] as const)
              .filter(([, v]) => v > 0)
              .sort((a, b) => b[1] - a[1])
              .map(([category, v], i) => (
                <i
                  key={category}
                  style={{ width: `${(v / Math.max(soFar, 1)) * 100}%`, ["--a" as string]: SPLIT_ALPHA[i] ?? 0.14 }}
                  title={`${category} €${v.toFixed(2)}`}
                />
              ))}
          </span>
          <span className="fin-hero-go">See all spending →</span>
        </button>

        <div className="fin-side">
          <div className="fin-card fin-mini">
            <span className="fin-kpi-lbl">{d.summary.runwayMonths !== null ? "Runway" : "Balance"}</span>
            <b>{d.summary.runwayMonths !== null ? `${d.summary.runwayMonths} mo` : d.summary.balance !== null ? eur(d.summary.balance) : "—"}</b>
            <span className="fin-kpi-sub">
              {d.summary.drift !== null
                ? `${d.summary.drift >= 0 ? "+" : ""}${eur(d.summary.drift)}/mo`
                : "upload a statement"}
            </span>
          </div>
          <div className="fin-card fin-mini">
            <span className="fin-kpi-lbl">Net recurring</span>
            <b className={(d.summary.net[0]?.monthly ?? 0) < 0 ? "down" : ""}>{perCurrency(d.summary.net)}</b>
            <span className="fin-kpi-sub">{perCurrency(d.income.totals)} in · {perCurrency(d.subscriptions.totals)} out</span>
          </div>
        </div>
      </div>

      {/* The three that matter, at card weight.
          They report the LAST COMPLETE month, not the one in progress: on the
          3rd of September every one of them read "€0.00 this month", which is
          not a fact about spending, it is a fact about the calendar. The hero
          above is the place for the month in progress — it says which day it is
          on and projects a pace, so it can carry a part-month honestly. */}
      <div className="fin-tops">
        {top.map((f) => {
          const was = f.last ?? 0;
          // Against the months around it, itself excluded — the typical the
          // month page this card opens shows (FIN-014).
          const delta = was - f.lastTypical;
          return (
            <button
              key={f.category}
              className="fin-card fin-top-cat"
              style={{ ["--c" as string]: colourOf(f.category) }}
              onClick={() => (lastComplete ? onOpenMonth(lastComplete, f.category) : onOpenCategory(f.category))}
            >
              <span className="fin-top-head">
                <i>{iconFor(f.category)}</i>
                {f.category}
              </span>
              <b>{eur(was)}</b>
              <span className="fin-top-sub">
                {lastComplete ? monthName(lastComplete) : "last month"} · typically {eur(f.lastTypical)}
              </span>
              <span className={`fin-top-delta ${delta > 0 ? "over" : "under"}`}>
                {delta === 0 ? "as usual" : `${delta > 0 ? "▲" : "▼"} ${eur(Math.abs(delta))}`}
              </span>
            </button>
          );
        })}
      </div>

      {/* Everything else, as footnotes rather than ten more rows. */}
      {rest.length > 0 && (
        <div className="fin-rest">
          {rest.map((f) => (
            <button
              key={f.category}
              className="fin-chip"
              style={{ ["--c" as string]: colourOf(f.category) }}
              onClick={() => onOpenCategory(f.category)}
            >
              <i>{iconFor(f.category)}</i>
              {f.category}
              <b>{eur(f.last ?? 0)}</b>
            </button>
          ))}
        </div>
      )}

      <div className="fin-grid">
        <PayslipsCard slips={d.payslips} noteId={d.notes.payslips} onOpenNote={onOpenNote} onRead={setReading} />

        <SavingsCard savings={d.savings} onOpen={() => onOpenPage("savings")} />

        <button className="fin-card fin-jump" onClick={() => onOpenPage("subscriptions")}>
          <span className="fin-card-head">
            <h2>Commitments</h2>
            <span className="fin-count">{d.subscriptions.count}</span>
          </span>
          <b style={{ color: "var(--cat-azure)" }}>{perCurrency(d.subscriptions.totals)}</b>
          <span className="fin-jump-sub">a month — subscriptions, rent and tuition{notCounted(d.subscriptions)}</span>
          <NextUp items={d.subscriptions.items} />
          <span className="fin-hero-go">Open the calendar →</span>
        </button>

        <button className="fin-card fin-jump" onClick={() => onOpenPage("income")}>
          <span className="fin-card-head">
            <h2>Income</h2>
            <span className="fin-count">{d.income.count}</span>
          </span>
          <b style={{ color: "var(--fin-pos)" }}>{perCurrency(d.income.totals)}</b>
          <span className="fin-jump-sub">a month, across {d.income.count} sources{notCounted(d.income)}</span>
          <NextUp items={d.income.items} />
          <span className="fin-hero-go">Open the calendar →</span>
        </button>

        <button className="fin-card fin-jump fin-span" onClick={() => onOpenPage("documents")}>
          <span className="fin-card-head">
            <h2>Documents</h2>
            <span className="fin-count">{d.files.length}</span>
          </span>
          {d.files.length > 0 ? (
            <span className="fin-doc-strip">
              {d.files.slice(0, 6).map((f) => (
                <i key={f.name} title={f.name}>
                  <em>{f.ext.replace(".", "") || "file"}</em>
                  {f.name.replace(/\.[^.]+$/, "").slice(0, 22)}
                </i>
              ))}
            </span>
          ) : (
            <span className="fin-jump-sub">Nothing uploaded yet.</span>
          )}
          <span className="fin-hero-go">Read them in the app →</span>
        </button>
      </div>

      {reading && <DocViewer base="/api/finance/files" name={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

/**
 * The next few charges on a ledger, so a card says WHEN and not only how much.
 * Sorted by date; anything without one is left out rather than guessed at.
 */
function NextUp({ items }: { items: Money[] }) {
  const soon = items
    .filter((m) => m.next)
    .sort((a, b) => a.next!.localeCompare(b.next!))
    .slice(0, 3);
  if (soon.length === 0) return null;
  return (
    <span className="fin-nextup">
      {soon.map((m) => (
        <i key={m.service}>
          <em>{new Date(`${m.next}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</em>
          {m.service}
          <b>{eur(m.amount, m.currency)}</b>
        </i>
      ))}
    </span>
  );
}

/**
 * The savings target, at card weight.
 *
 * One number, and immediately the two parts it is made of — what is already
 * left over, and what the statement says could be trimmed. A target with no
 * visible derivation is just a wish.
 */
function SavingsCard({ savings: s, onOpen }: { savings: Savings; onOpen: () => void }) {
  if (s.basedOn < 3)
    return (
      <section className="fin-card">
        <div className="fin-card-head">
          <h2>Saving</h2>
        </div>
        <p className="fin-empty-line">
          Needs three complete months; there {s.basedOn === 1 ? "is" : "are"} {s.basedOn}.
        </p>
      </section>
    );
  const share = s.target > 0 && s.surplus > 0 ? s.surplus / s.target : 0;
  return (
    <button className="fin-card fin-jump" onClick={onOpen}>
      <span className="fin-card-head">
        <h2>Saving</h2>
        {s.targetRate !== null && <span className="fin-count">{s.targetRate}% of income</span>}
      </span>
      <b style={{ color: "var(--fin-pos)" }}>{eur(s.target)}</b>
      <span className="fin-jump-sub">a month is realistic on your own numbers</span>
      {/* Surplus and headroom as one bar: the split IS the argument. */}
      <span className="fin-save-bar">
        <i className="surplus" style={{ width: `${share * 100}%` }} />
        <i className="trim" style={{ width: `${(1 - share) * 100}%` }} />
      </span>
      <span className="fin-save-key">
        <i>
          <em className="surplus" />
          {eur(Math.max(0, s.surplus))} already left over
        </i>
        <i>
          <em className="trim" />
          {eur(s.trimmable)} trimmable
        </i>
      </span>
      {s.observed !== null && (
        <span className="fin-jump-sub">
          actually {s.observed >= 0 ? "saving" : "losing"} {eur(Math.abs(s.observed))} a month
        </span>
      )}
      <span className="fin-hero-go">See the working →</span>
    </button>
  );
}

/**
 * Payslips: what landed, month by month.
 *
 * The first version of this card led with an effective hourly rate, which is a
 * derived figure nobody makes a decision on. What you want from a payslip card
 * is what you were paid and whether it is going up. So the headline is the LAST
 * COMPLETE month's take-home — never the month in progress, which is either
 * unpaid or half-paid and would read as a pay cut — with the months before it
 * as bars, and the year totalled underneath.
 */
function PayslipsCard({
  slips,
  noteId,
  onOpenNote,
  onRead,
}: {
  slips: PayslipRow[];
  noteId: string | null;
  onOpenNote: (id: string) => void;
  /** Open that month's payslip PDF. Every row filed one; this is the way back
   *  to it, so the figure and the document it came from are one click apart. */
  onRead: (file: string) => void;
}) {
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
  const shown = withNet.slice(-8);
  const maxNet = Math.max(1, ...shown.map((r) => r.net!));

  return (
    <section className="fin-card">
      <div className="fin-card-head">
        <h2>Payslips</h2>
        {noteId && (
          <button className="fin-link" onClick={() => onOpenNote(noteId)}>
            Open note
          </button>
        )}
      </div>
      {!latest ? (
        <p className="fin-empty-line">No payslips yet — upload one.</p>
      ) : (
        <>
          <div className="fin-head-num">
            <b>{eur(latest.net!)}</b>
            <span>
              earned in {monthName(latest.month)}
              {change !== null && change !== 0 && (
                <em className={change < 0 ? "over" : "under"}>
                  {change > 0 ? "▲" : "▼"} {eur(Math.abs(change))} on {monthName(before!.month)}
                </em>
              )}
            </span>
          </div>

          {/* Take-home per month. The most recent bar is the one the headline
              names, so the number and the shape are the same fact. */}
          {/* Newest first: the month you want is the one you just got paid for,
              and reading a column of months downwards is how a bank statement
              reads. Each row opens its own payslip. */}
          {shown.length > 1 && (
            <ul className="fin-rate-rows fin-pay-rows">
              {[...shown].reverse().map((r) => (
                <li key={r.month} className={r.month === latest.month ? "on" : ""}>
                  <button
                    className="fin-pay-row"
                    onClick={() => r.file && onRead(r.file)}
                    disabled={!r.file}
                    title={r.file ? `Open ${r.file}` : "No document filed for this month"}
                  >
                    <span className="m">{monthName(r.month)}</span>
                    <span className="track">
                      <i style={{ width: `${(r.net! / maxNet) * 100}%` }} />
                    </span>
                    <b>{eur(r.net!)}</b>
                    <span className="fin-merch-chev" aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <ul className="fin-goals fin-ytd">
            <li>
              <span>Take-home {year}</span>
              <b>{eur(ytdNet)}</b>
              <em>
                {thisYear.length} {thisYear.length === 1 ? "payslip" : "payslips"}
              </em>
            </li>
            <li>
              <span>Average month</span>
              <b>{eur(Math.round(average * 100) / 100)}</b>
              <em>across {year}</em>
            </li>
            <li>
              <span>Kept after tax</span>
              <b>{kept !== null ? `${kept}%` : "—"}</b>
              <em>{ytdGross > 0 ? `${eur(ytdGross - ytdNet)} withheld` : "no gross recorded"}</em>
            </li>
          </ul>
        </>
      )}
    </section>
  );
}
/* ==========================================================================
   Pages added for the "everything is a door" pass: a month, the documents,
   the two ledgers as a calendar, and the savings plan.
   ========================================================================== */

/**
 * Which days of `month` this line charges on.
 *
 * The note records ONE date plus a cadence, so the calendar has to project
 * the rest — and it does so with core's `chargeDates`, the same function the
 * Planning band uses, counting every charge from the note's own date. This
 * page used to keep its own copy of the date arithmetic, chained one step at a
 * time: rent due on the 31st was drawn on the 30th, even in the month the note
 * names, and on the 28th after February (audit FIN-003).
 */
function chargeDays(month: string, anchor: string | null, cadence: string): number[] {
  if (!anchor) return [];
  return chargeDates(anchor, cadence as Cadence, `${month}-01`, `${month}-31`).map((d) => Number(d.slice(8, 10)));
}

const monthLong = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

/** One side of the money: a set of ledger lines, its colour, and its sign. */
interface CalSeries {
  items: Money[];
  tint: string;
  direction: "in" | "out";
}

/**
 * One month of a ledger as a calendar.
 *
 * A list of "next charge" dates tells you nothing about the shape of a month;
 * a grid tells you immediately that four things land on the 1st and nothing
 * else until the 14th. Days with no charge are still drawn, because the empty
 * stretches are half the information.
 *
 * It takes SERIES rather than one list so the two ledgers can share a grid
 * without being merged: money in and money out keep their own colour, their
 * own sign and their own subtotal on a day, which is what makes "the 25th is
 * heavy both ways" legible at a glance. Netting them into one figure would
 * hide exactly that.
 */
function ChargeCalendar({
  month,
  series,
  onPick,
}: {
  month: string;
  series: CalSeries[];
  /** Given a ledger line, open whatever the bank calls it. Null when the
   *  statement has never seen it, and the chip is then not a button. */
  onPick: (service: Money) => void;
}) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  // Monday-first, which is how a European bank statement reads.
  const lead = (first.getUTCDay() + 6) % 7;

  // day -> one bucket per series, in the order the series were given.
  const byDay = new Map<number, Money[][]>();
  series.forEach((s, si) => {
    for (const it of s.items)
      for (const day of chargeDays(month, it.anchor, it.cadence)) {
        const at = byDay.get(day) ?? series.map(() => []);
        at[si] = [...at[si]!, it];
        byDay.set(day, at);
      }
  });
  const sum = (list: Money[]) => list.reduce((a, m) => a + m.amount, 0);
  // The wash is sized by everything moving that day, either direction, so a
  // heavy day reads as heavy whether the money is arriving or leaving.
  const moved = (day: number) => (byDay.get(day) ?? []).reduce((a, b) => a + sum(b), 0);
  const busiest = Math.max(1, ...[...byDay.keys()].map(moved));

  return (
    <div className="fin-cal">
      <div className="fin-cal-head">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="fin-cal-grid">
        {Array.from({ length: lead }, (_, i) => (
          <div key={`pad${i}`} className="fin-cal-day empty" />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const day = i + 1;
          const buckets = byDay.get(day) ?? [];
          const any = buckets.some((b) => b.length > 0);
          return (
            <div
              key={day}
              className={`fin-cal-day ${any ? "on" : ""}`}
              style={{ ["--c" as string]: series[buckets.findIndex((b) => b.length > 0)]?.tint ?? series[0]!.tint }}
            >
              <span className="fin-cal-n">{day}</span>
              {any && (
                <>
                  <span className="fin-cal-wash" style={{ opacity: 0.08 + (moved(day) / busiest) * 0.28 }} />
                  <span className="fin-cal-sums">
                    {buckets.map((bucket, si) =>
                      bucket.length === 0 ? null : (
                        <em key={series[si]!.direction} style={{ color: series[si]!.tint }}>
                          {series[si]!.direction === "in" ? "+" : "−"}
                          {eur(sum(bucket))}
                        </em>
                      ),
                    )}
                  </span>
                  <ul className="fin-cal-items">
                    {buckets.flatMap((bucket, si) =>
                      bucket.slice(0, 3).map((m) => (
                        <li key={`${series[si]!.direction}-${m.service}`}>
                          <button
                            style={{ ["--c" as string]: series[si]!.tint }}
                            onClick={() => onPick(m)}
                            title={`${m.service} · ${series[si]!.direction === "in" ? "+" : "−"}${eur(m.amount, m.currency)}`}
                          >
                            {m.service}
                          </button>
                        </li>
                      )),
                    )}
                    {buckets.some((b) => b.length > 3) && (
                      <li className="more">+{buckets.reduce((a, b) => a + Math.max(0, b.length - 3), 0)} more</li>
                    )}
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

/** What the server says one uploaded statement added (FIN-007). */
interface StatementRead {
  rows: number;
  skipped: number;
  first: string | null;
  last: string | null;
  reason: string | null;
}

/** The upload's answer for a statement: what it added, or why it adds nothing. */
function statementFlash(name: string, st: StatementRead | null): string {
  if (!st) return `Stored ${name}.`;
  if (st.reason) return `Stored ${name}, but it is left out of the figures: ${st.reason}.`;
  const span = st.first && st.last ? `, ${fullDate(st.first)} to ${fullDate(st.last)}` : "";
  const skipped = st.skipped ? ` (${st.skipped} ${st.skipped === 1 ? "row" : "rows"} skipped: not settled, unreadable or in another currency)` : "";
  return `Read ${st.rows} ${st.rows === 1 ? "transaction" : "transactions"} from ${name}${span}${skipped}.`;
}

/** " · 2 rows not counted", or nothing: the overview's half of FIN-006. */
const notCounted = (l: Ledger) =>
  l.unreadable.length ? ` · ${l.unreadable.length} ${l.unreadable.length === 1 ? "row" : "rows"} not counted` : "";

/**
 * The rows a ledger left out of its totals, by name, line and cell — a row
 * the parser cannot read must not simply vanish from the sum (FIN-005/006).
 */
function UnreadableRows({ ledger, noteId, onOpenNote }: { ledger: Ledger; noteId: string | null; onOpenNote: (id: string) => void }) {
  const rows = ledger.unreadable;
  if (rows.length === 0) return null;
  return (
    <div className="fin-unreadables">
      <Notice
        title={`${rows.length} ${rows.length === 1 ? "row is" : "rows are"} not counted`}
        text={
          <>
            {rows.map((r) => (
              <span key={r.line} className="fin-unreadable">
                Line {r.line}, {r.service || "a row with no name"}:{" "}
                {r.field === "cadence"
                  ? `“${r.text}” is not a cadence this ledger knows (weekly, every 2 weeks, 4-weekly, monthly, quarterly, half-yearly, yearly).`
                  : r.text
                    ? `“${r.text}” is not one amount.`
                    : "no amount."}
              </span>
            ))}
          </>
        }
        actions={noteId ? <button className="fin-link" onClick={() => onOpenNote(noteId)}>Open note</button> : undefined}
      />
    </div>
  );
}

/** What the two ledgers are called on screen. "Commitments" rather than
 *  "Subscriptions" because the note holds rent and tuition too, and neither is
 *  a subscription — it is the same word the savings plan already uses for the
 *  part of a month only a cancellation changes. */
const LEDGER_LABEL = { subscriptions: "Commitments", income: "Income" } as const;
const LEDGER_TINT = { subscriptions: "var(--cat-azure)", income: "var(--fin-pos)" } as const;

/** Remembered so the switch does not reset every time the page is opened. */
const OVERLAY_KEY = "basalt-fin-overlay";
const readOverlay = (): boolean => {
  try {
    return localStorage.getItem(OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * Commitments or income: the same page twice, because they are the same shape
 * of thing — a name, an amount, a rhythm — and the only real difference is
 * which direction the money goes. Colour carries that: green in, blue out.
 *
 * The switch overlays the OTHER ledger onto the same grid without merging the
 * two: each keeps its colour, its sign and its own subtotal on a day. The cards
 * underneath stay this page's own, so the pages remain separate things that can
 * be read together rather than one combined page pretending to be two.
 */
function LedgerPage({
  kind,
  onBack,
  onOpenNote,
  onOpenMerchant,
}: {
  kind: "subscriptions" | "income";
  onBack: () => void;
  onOpenNote: (id: string) => void;
  onOpenMerchant: (name: string) => void;
}) {
  const [d, setD] = useState<FinanceData | null>(null);
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [both, setBoth] = useState(readOverlay);
  useEffect(() => {
    void api<FinanceData>("GET", "/api/finance").then(setD);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(OVERLAY_KEY, both ? "1" : "0");
    } catch {
      /* a private window is not a reason to lose the page */
    }
  }, [both]);
  if (!d) return <div className="fin"><p className="fin-loading">Reading the ledger…</p></div>;

  const income = kind === "income";
  const other = income ? "subscriptions" : "income";
  const ledger = income ? d.income : d.subscriptions;
  const tint = LEDGER_TINT[kind];
  const noteId = income ? d.notes.income : d.notes.subscriptions;
  const dueIn = (items: Money[]) =>
    items.reduce((a, m) => a + chargeDays(month, m.anchor, m.cadence).length * m.amount, 0);
  const dueThis = dueIn(ledger.items);
  const otherLedger = income ? d.subscriptions : d.income;
  const dueOther = dueIn(otherLedger.items);
  // This page's series first, so its colour wins the day-cell border.
  /**
   * Where a ledger line leads. The note names it; the bank names it something
   * else; the merchant page only knows the bank's name. Null when the statement
   * has never seen the line at all — Youtube Family is paid to a friend, so
   * there is genuinely nowhere for it to go, and a dead button is worse than a
   * card that plainly is not one.
   */
  const merchantFor = (m: Money): string | null =>
    (income ? d.income : d.subscriptions).activity[m.service]?.merchants[0] ??
    (income ? d.subscriptions : d.income).activity[m.service]?.merchants[0] ??
    null;
  const open = (m: Money) => {
    const name = merchantFor(m);
    if (name) onOpenMerchant(name);
  };
  const series: CalSeries[] = [
    { items: ledger.items, tint, direction: income ? "in" : "out" },
    ...(both
      ? [{ items: otherLedger.items, tint: LEDGER_TINT[other], direction: (income ? "out" : "in") as "in" | "out" }]
      : []),
  ];
  // Longest-running first: what you have been paying for two years is a
  // different decision from what you started last month.
  const cards = [...ledger.items].sort(
    (a, b) => (ledger.activity[b.service]?.months ?? 0) - (ledger.activity[a.service]?.months ?? 0) || b.monthly - a.monthly,
  );

  return (
    <div className="fin" style={{ ["--c" as string]: tint }}>
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Finance</button>
          <div>
            <h1 className="fin-h1">{LEDGER_LABEL[kind]}</h1>
            <p className="fin-sub">
              {ledger.count} {income ? "sources" : "subscriptions, rent and tuition"} · {perCurrency(ledger.totals)} a month
            </p>
          </div>
        </div>
        {noteId && <button className="fin-link" onClick={() => onOpenNote(noteId)}>Open note</button>}
      </header>

      <UnreadableRows ledger={ledger} noteId={noteId} onOpenNote={onOpenNote} />

      <section className="fin-card fin-span">
        <div className="fin-card-head">
          <h2>{monthLong(month)}</h2>
          {/* Beside the month, not beside the page title: what it changes is
              this grid, so it belongs on the grid's own header.
              --c sits on the label, not on the text inside it — a custom
              property inherits down, and the track is the text's SIBLING. */}
          <label className="fin-switch" style={{ ["--c" as string]: LEDGER_TINT[other] }}>
            <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} />
            <span className="track" aria-hidden><i /></span>
            <span className="lbl">Show {LEDGER_LABEL[other].toLowerCase()}</span>
          </label>
          <div className="fin-monthnav">
            <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
            <button onClick={() => setMonth(monthKey(new Date()))}>Today</button>
            <button onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
          </div>
          <span className="fin-count">
            <b style={{ color: tint }}>{income ? "+" : "−"}{eur(dueThis)}</b>
            {both && (
              <>
                {" "}
                <b style={{ color: LEDGER_TINT[other] }}>
                  {income ? "−" : "+"}
                  {eur(dueOther)}
                </b>{" "}
                <em>· net {eur(income ? dueThis - dueOther : dueOther - dueThis)}</em>
              </>
            )}
          </span>
        </div>
        {ledger.count > 0 ? (
          <ChargeCalendar month={month} series={series} onPick={open} />
        ) : (
          <p className="fin-empty-line">
            Nothing recorded. Add rows to the {income ? "#income" : "#subscriptions"} note.
          </p>
        )}
      </section>

      {/* Found, not remembered. A fixed amount landing on a rhythm is a
          standing order whatever the merchant is called, and this is the list
          of the ones the note has not caught up with. */}
      {d.recurring.length > 0 && !income && (
        <section className="fin-card fin-span fin-found">
          <div className="fin-card-head">
            <h2>Looks recurring</h2>
            <span className="fin-count">{d.recurring.length} not in the note</span>
          </div>
          <p className="fin-hint">
            The same amount, on a rhythm, from a merchant no row matches. Add a{" "}
            <code>Match</code> to the note to adopt one.
          </p>
          <ul className="fin-found-rows">
            {d.recurring.map((r) => (
              <li key={`${r.merchant}-${r.amount}`}>
                <button className="fin-found-row" onClick={() => onOpenMerchant(r.merchant)}>
                  <span className="nm">{r.merchant}</span>
                  <span className="cad">
                    {r.everyMonths === 1 ? "monthly" : r.everyMonths === 3 ? "quarterly" : `every ${r.everyMonths} months`}
                    {" · "}
                    {monthName(r.first)} → {monthName(r.last)}
                  </span>
                  {!r.active && <span className="stopped">stopped</span>}
                  <b>{eur(r.amount)}</b>
                  <em>{eur(r.total)} so far</em>
                  <span className="fin-merch-chev" aria-hidden>›</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="fin-subs">
        {cards.map((m) => {
          const act = ledger.activity[m.service];
          const to = merchantFor(m);
          // A card with nothing behind it is rendered as a card, not a button:
          // it cannot be opened, and it should not pretend it can.
          const Tag = to ? "button" : "div";
          return (
            <Tag
              key={m.service}
              className={`fin-card fin-sub-card ${to ? "" : "inert"}`}
              style={{ ["--c" as string]: tint }}
              {...(to ? { onClick: () => onOpenMerchant(to), title: `Open ${to}` } : {})}
            >
              <span className="fin-sub-top">
                <b>{m.service}</b>
                <em>{eur(m.amount, m.currency)}</em>
              </span>
              <span className="fin-sub-cad">
                {m.cadence}
                {m.cadence !== "monthly" && <> · {eur(m.monthly)}/mo</>}
              </span>
              {/* The run: one tick per month it was actually charged, read off
                  the statement rather than off the note. */}
              {act && act.months > 0 ? (
                <>
                  <span className="fin-sub-run" aria-hidden>
                    {act.seen.slice(-18).map((mo) => (
                      <i key={mo} title={mo} />
                    ))}
                  </span>
                  <span className="fin-sub-meta">
                    <b>{act.months}</b> {act.months === 1 ? "month" : "months"} · {eur(act.total)} so far
                  </span>
                  <span className="fin-sub-since">since {monthName(act.first!)}</span>
                  {/* What arrived, against what was expected to. A catch-up
                      payment is real money and not a raise, so it is named as
                      extra rather than being averaged into the figure above. */}
                  {(() => {
                    const expected = act.expected;
                    const extra = Math.round((act.total - expected) * 100) / 100;
                    if (Math.abs(extra) < 1) return null;
                    return (
                      <span className={`fin-sub-extra ${extra > 0 ? "over" : "under"}`}>
                        {extra > 0 ? `${eur(extra)} more than the ${eur(expected)} expected` : `${eur(-extra)} short of the ${eur(expected)} expected`}
                      </span>
                    );
                  })()}
                </>
              ) : (
                <span className="fin-sub-meta muted">not seen on the statement yet</span>
              )}
              {m.next && <span className="fin-sub-next">next {fullDate(m.next)}</span>}
              {m.note && <span className="fin-sub-note">{m.note}</span>}
            </Tag>
          );
        })}
      </div>
    </div>
  );
}

/** Every uploaded file, newest first, grouped by the month it arrived, and
 *  readable in place rather than only downloadable. */
function DocumentsPage({ onBack }: { onBack: () => void }) {
  const [d, setD] = useState<FinanceData | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => {
    void api<FinanceData>("GET", "/api/finance").then(setD);
  }, []);
  if (!d) return <div className="fin"><p className="fin-loading">Looking in the folder…</p></div>;

  const groups = new Map<string, typeof d.files>();
  for (const f of d.files) {
    // The month the file arrived in, read off the local clock: in UTC an
    // upload at 00:30 on the 1st was filed under the previous month (audit).
    const key = monthKey(new Date(f.mtimeMs));
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const total = d.files.reduce((a, f) => a + f.size, 0);

  return (
    <div className="fin">
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Finance</button>
          <div>
            <h1 className="fin-h1">Documents</h1>
            <p className="fin-sub">
              {d.files.length} files · {kb(total)} · in {FINANCE_FILES_DIR}
            </p>
          </div>
        </div>
      </header>

      {d.files.length === 0 ? (
        <section className="fin-card fin-span">
          <p className="fin-empty-line">Nothing uploaded yet. Use Upload on the Finance page.</p>
        </section>
      ) : (
        <ul className="fin-docs">
          {[...groups].map(([month, files]) => (
            <li key={month}>
              <div className="fin-txn-month">
                <span className="m">{monthLong(month)}</span>
                <span className="n">{files.length} {files.length === 1 ? "file" : "files"}</span>
                <b>{kb(files.reduce((a, f) => a + f.size, 0))}</b>
              </div>
              <ul className="fin-doc-rows">
                {files.map((f) => (
                  <li key={f.name}>
                    <button className="fin-doc-row" onClick={() => setReading(f.name)}>
                      <span className="fin-file-ext">{f.ext.replace(".", "") || "file"}</span>
                      <span className="fin-doc-name">{f.name}</span>
                      <span className="fin-doc-date">{fullDate(isoLocal(new Date(f.mtimeMs)))}</span>
                      <span className="fin-file-size">{kb(f.size)}</span>
                      <span className="fin-merch-chev" aria-hidden>›</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {reading && <DocViewer base="/api/finance/files" name={reading} onClose={() => setReading(null)} />}
    </div>
  );
}

/** Where uploads live, said once so the Documents page and the empty state
 *  cannot disagree with the server (apps/server/src/routes/finance.ts). */
const FINANCE_FILES_DIR = "02-Areas/finance/files";

/**
 * The savings plan in full: where the target comes from, category by category.
 *
 * The page exists to make the number arguable. A single "you could save €240"
 * is a claim; the same number broken into surplus plus a per-category gap
 * between a typical month and a good one is an argument, and you can disagree
 * with any one line of it.
 */
function SavingsPage({ onBack, onOpenCategory }: { onBack: () => void; onOpenCategory: (name: string) => void }) {
  const [d, setD] = useState<FinanceData | null>(null);
  useEffect(() => {
    void api<FinanceData>("GET", "/api/finance").then(setD);
  }, []);
  if (!d) return <div className="fin"><p className="fin-loading">Working it out…</p></div>;
  const s = d.savings;
  const thin = s.basedOn < 3;

  return (
    <div className="fin">
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Finance</button>
          <div>
            <h1 className="fin-h1">Saving</h1>
            <p className="fin-sub">From {s.basedOn} complete months of your own statement.</p>
          </div>
        </div>
      </header>

      {thin ? (
        <section className="fin-card fin-span">
          <p className="fin-empty-line">
            Three complete months are needed before a typical month means anything. There {s.basedOn === 1 ? "is" : "are"} {s.basedOn}.
          </p>
        </section>
      ) : (
        <>
          <section className="fin-card fin-span fin-plan">
            <div className="fin-head-num">
              <b style={{ color: "var(--fin-pos)" }}>{eur(s.target)}</b>
              <span>
                a month is realistic
                {s.targetRate !== null && <em>{s.targetRate}% of what comes in</em>}
              </span>
            </div>
            {/* The arithmetic, laid out rather than asserted. */}
            <ul className="fin-maths">
              <li>
                <span>Average month in</span>
                <b>{eur(s.incomeMonthly)}</b>
                <em>
                  {s.incomeSource === "balance"
                    ? "what must have landed for the balance to move as it did"
                    : s.incomeSource === "payslips"
                      ? "median payslip"
                      : s.incomeSource === "ledger"
                        ? "income note"
                        : "nothing on record"}
                </em>
              </li>
              <li>
                {/* Money OUT, not money spent. The two differ by every transfer
                    the rules note never claimed, and this row has to be the
                    one the surplus above is actually computed from or the
                    three figures stop adding up. An average, like the drift
                    beside it: a one-off transfer is money that left. */}
                <span>Average month out</span>
                <b className="neg">−{eur(s.outflowMonthly)}</b>
                <em>everything that left, transfers included, over {s.basedOn} months</em>
              </li>
              <li className="sum">
                <span>Left over</span>
                <b className={s.surplus < 0 ? "neg" : "pos"}>{eur(s.surplus)}</b>
                <em>{s.incomeSource === "balance" ? "the balance trend itself" : "before changing anything"}</em>
              </li>
              <li>
                <span>Proven headroom</span>
                <b className="pos">+{eur(s.trimmable)}</b>
                <em>
                  {s.typicalMonth && s.goodMonth
                    ? `${monthName(s.typicalMonth)} against ${monthName(s.goodMonth)}, per category`
                    : "a typical month against a good one, per category"}
                </em>
              </li>
              <li className="total">
                <span>Target</span>
                <b>{eur(s.target)}</b>
                <em>surplus + headroom</em>
              </li>
            </ul>
            {s.observed !== null && (
              <p className="fin-hint">
                Your balance is moving {s.observed >= 0 ? "up" : "down"} by <b>{eur(Math.abs(s.observed))}</b> a
                month across {s.basedOn} months. That is the bank's own arithmetic, so the target above is that
                figure plus {eur(s.trimmable)} of headroom you have already shown you can live inside —{" "}
                {eur(s.target - s.observed)} more a month than you are saving now.
              </p>
            )}
          </section>

          <div className="fin-grid">
            <section className="fin-card">
              <div className="fin-card-head">
                <h2>Where the headroom is</h2>
                <span className="fin-count">{eur(s.trimmable)}</span>
              </div>
              {s.typicalMonth && s.goodMonth && (
                <p className="fin-hint">
                  {monthName(s.typicalMonth)} against {monthName(s.goodMonth)} — two months you have had, so the
                  rows below add up to the total rather than to a sum of quantiles from months that never
                  coincided. A negative row is a category the good month spent MORE on.
                </p>
              )}
              {s.headroom.length > 0 ? (
                <ul className="fin-head-rows">
                  {s.headroom.map((h) => (
                    <li key={h.category}>
                      <button className="fin-head-row" onClick={() => onOpenCategory(h.category)}>
                        <span className="fin-head-name">{h.category}</span>
                        {/* Typical is the bar; the good month is the notch. The
                            distance between them IS the saving. */}
                        <span className="fin-head-bar">
                          <i className="typ" style={{ width: `${(h.typical / (s.headroom[0]?.typical || 1)) * 100}%` }} />
                          <i className="good" style={{ left: `${(h.good / (s.headroom[0]?.typical || 1)) * 100}%` }} />
                        </span>
                        <span className="fin-head-nums">
                          <b>{eur(h.save)}</b>
                          <em>{eur(h.good)} vs {eur(h.typical)}</em>
                        </span>
                        <span className="fin-merch-chev" aria-hidden>›</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fin-empty-line">No category varies enough to trim.</p>
              )}
            </section>

            <section className="fin-card">
              <div className="fin-card-head">
                <h2>What it buys</h2>
              </div>
              <ul className="fin-goals">
                <li>
                  <span>Emergency fund</span>
                  <b>{eur(s.emergencyFund)}</b>
                  <em>
                    three typical months
                    {s.monthsToFund !== null && ` · ${s.monthsToFund} months away`}
                  </em>
                </li>
                <li>
                  <span>A year at this rate</span>
                  <b>{eur(s.target * 12)}</b>
                  <em>if nothing else changes</em>
                </li>
                <li>
                  <span>Committed</span>
                  <b>{eur(s.committedMonthly)}</b>
                  {/* The typical month's own figures, so the two rows add up
                      to a month that happened (FIN-016). */}
                  <em>{s.typicalMonth && `in ${monthName(s.typicalMonth)} · `}only a cancellation moves this</em>
                </li>
                <li>
                  <span>Discretionary</span>
                  <b>{eur(s.discretionaryMonthly)}</b>
                  <em>{s.typicalMonth && `in ${monthName(s.typicalMonth)} · `}where the headroom lives</em>
                </li>
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One month, in full.
 *
 * Every column of the spending chart and every point on a category line opens
 * this. Optionally narrowed to one category, which is what clicking "May" from
 * inside the Shopping page means — the same page, filtered, so there is one
 * month view rather than two that drift apart.
 */
function MonthPage({
  month,
  category,
  onBack,
  onOpenMonth,
  onOpenCategory,
  onOpenMerchant,
}: {
  month: string;
  category?: string;
  onBack: () => void;
  onOpenMonth: (month: string, category?: string) => void;
  onOpenCategory: (name: string) => void;
  onOpenMerchant: (name: string) => void;
}) {
  const [d, setD] = useState<MonthDetail | null>(null);
  useEffect(() => {
    setD(null);
    const ac = new AbortController();
    const q = category && category !== SPENDING_PAGE ? `?category=${encodeURIComponent(category)}` : "";
    void api<MonthDetail>("GET", `/api/finance/month/${month}${q}`, undefined, { signal: ac.signal }).then(setD, unlessAborted);
    return () => ac.abort();
  }, [month, category]);
  if (!d) return <div className="fin"><p className="fin-loading">Opening {monthLong(month)}…</p></div>;

  const delta = d.typical > 0 ? d.total - d.typical : null;
  const days = new Map<string, typeof d.transactions>();
  for (const t of d.transactions) days.set(t.date, [...(days.get(t.date) ?? []), t]);
  const colourOf = paletteFor(d.categories);

  return (
    <div className="fin">
      <header className="fin-top">
        <div className="fin-detail-id">
          <button className="fin-back" onClick={onBack}>← Back</button>
          <div>
            <h1 className="fin-h1">
              {monthLong(month)}
              {d.category && <span className="fin-h1-of"> · {d.category}</span>}
            </h1>
            <p className="fin-sub">
              {d.count} purchases
              {d.transferCount > 0 && ` · ${d.transferCount} transfers`}
              {!d.complete && " · the statement stops inside this month"}
            </p>
          </div>
        </div>
        {/* Stepping month to month without going back up a level — the whole
            point of a linked app is that you rarely have to. */}
        <div className="fin-monthnav">
          <button disabled={!d.prev} onClick={() => d.prev && onOpenMonth(d.prev, category)} aria-label="Previous month">‹</button>
          <button disabled={!d.next} onClick={() => d.next && onOpenMonth(d.next, category)} aria-label="Next month">›</button>
        </div>
      </header>

      <section className="fin-card fin-span">
        <div className="fin-head-num">
          <b>{eur(d.total)}</b>
          <span>
            {d.category ? `on ${d.category}` : "spent this month"}
            {delta !== null && (
              <em className={delta > 0 ? "over" : "under"}>
                {delta > 0 ? "▲" : "▼"} {eur(Math.abs(delta))} against a typical {eur(d.typical)}
              </em>
            )}
          </span>
        </div>
        {/* A transfer is money moving, not spending, and is stated beside the
            headline rather than folded into it — folding it in is what made
            this page disagree with the chart that opened it. A REFUND is a
            different thing: it is money back on something already counted, so
            it comes off the total (audit) and is restated here for what it
            is. Both figures still come from the one shared costOf, so the
            page and the chart cannot disagree. */}
        {(d.movedOut > 0 || d.refunded > 0) && (
          <p className="fin-aside">
            {d.movedOut > 0 && (
              <span>
                <em>{eur(d.movedOut)}</em> moved out (rent, tuition, transfers — not counted as spending)
              </span>
            )}
            {d.refunded > 0 && (
              <span>
                <em>{eur(d.refunded)}</em> refunded, already off the total
              </span>
            )}
          </p>
        )}
        {/* The month's own split. Each band is a door to that category. */}
        {d.categories.length > 1 && (
          <ul className="fin-monthsplit">
            {d.categories.map((c) => (
              <li key={c.category}>
                <button
                  className="fin-monthsplit-row"
                  style={{ ["--c" as string]: colourOf(c.category) }}
                  onClick={() => onOpenCategory(c.category)}
                >
                  <i className="tile">{iconFor(c.category)}</i>
                  <span className="nm">{c.category}</span>
                  <span className="bar">
                    <i style={{ width: `${(c.total / (d.categories[0]?.total || 1)) * 100}%` }} />
                  </span>
                  <b>{eur(c.total)}</b>
                  <em>{c.typical > 0 ? `usually ${eur(c.typical)}` : `${c.count}×`}</em>
                  <span className="fin-merch-chev" aria-hidden>›</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="fin-card fin-span">
        <div className="fin-card-head">
          <h2>Every transaction</h2>
          <span className="fin-count">{d.count}</span>
        </div>
        {d.transactions.length > 0 ? (
          <ul className="fin-txn-rows fin-day-rows">
            {[...days].map(([date, rows], i) => (
              <li key={date} className={`fin-day ${i % 2 ? "alt" : ""}`}>
                <div className="fin-txn-day">
                  <b>{date.slice(8, 10)}</b>
                  <em>{weekday(date)}</em>
                </div>
                <ul className="fin-day-txns">
                  {rows.map((t, n) => (
                    <li key={`${t.date}-${n}`} className={t.refund ? "refund" : t.moved ? "moved" : ""}>
                      <button className="fin-merch-row" onClick={() => onOpenMerchant(t.description)}>
                        <i className="fin-day-dot" style={{ background: t.moved ? "var(--d-line-2)" : colourOf(t.category) }} />
                        <span className="fin-merch-name">{t.description}</span>
                        <span className="fin-txn-type">{t.category}</span>
                        <span className="fin-txn-amt">{t.refund ? `+${eur(t.amount)}` : eur(t.amount)}</span>
                        <span className="fin-merch-chev" aria-hidden>›</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fin-empty-line">Nothing in {monthLong(month)}.</p>
        )}
      </section>
    </div>
  );
}
