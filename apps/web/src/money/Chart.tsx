/**
 * Money's charts (structure.md §6 #31): hand-drawn SVG, no chart library, on the board's `.chart`
 * classes (ui.css). Every column is a button (§1.7 #6): a click or Enter opens what it counts.
 *
 * Drawn at the size it is shown — the SVG's units are the box's own pixels, measured — so a
 * tick is 11.5 px on a phone and on a wide screen alike, rather than scaled with the width.
 *
 * Two kinds: `Columns` (one value per month or year: a category, a merchant) and
 * `StackedColumns` (a month split by category: all spending).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { axisEur, niceTicks } from "./format.js";

/** A column's hit area is SVG, not a <button>: these props make it one to the keyboard and to a screen reader. */
const svgButton = (label: string, act: () => void) => ({
  role: "button",
  tabIndex: 0,
  "aria-label": label,
  onClick: act,
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
    }
  },
});

/** The width the chart is shown at, in CSS pixels. */
function useWidth(fallback = 760) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => el.clientWidth > 0 && setW(el.clientWidth);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A rounded-top column from the axis up: the board's path. */
const column = (x: number, w: number, y0: number, h: number) => {
  const r = Math.min(4, h / 2, w / 2);
  const top = y0 - h;
  return `M${x},${y0} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${y0} Z`;
};

/** A column's state: settled, the one open below, still running ("so far"), or not reached yet. */
export type ColumnState = "done" | "selected" | "partial" | "future";

export interface Column {
  key: string;
  /** Under the column: "Sep", "2025". */
  label: string;
  value: number;
  state: ColumnState;
  /** What a click opens, for the screen reader and the tooltip: "Open September 2026". */
  action: string;
}

const PAD = { l: 50, r: 8, t: 14, b: 34 };

function Grid({ max, plotH, y0, width, skipNear }: { max: number; plotH: number; y0: number; width: number; skipNear?: number }) {
  // A tick that lands on the typical line is dropped: two labels in the same 12 px are unreadable.
  const ticks = niceTicks(max).filter((v) => skipNear === undefined || skipNear <= 0 || Math.abs((v / max) * plotH - (skipNear / max) * plotH) > 12);
  return (
    <>
      {ticks.map((v) => {
        const y = y0 - (v / max) * plotH;
        return (
          <g key={v}>
            <line className="gl" x1={PAD.l} x2={width} y1={y} y2={y} />
            <text className="tick" x={PAD.l - 6} y={y + 4} textAnchor="end">
              {axisEur(v)}
            </text>
          </g>
        );
      })}
      <line className="ax" x1={PAD.l} x2={width} y1={y0} y2={y0} />
    </>
  );
}

/**
 * One value per month (or year): the typical month as a dashed line, the range of your own
 * months as a band behind it, a month still running hatched with "so far" above it, months the
 * statements have not reached labelled but not drawn — so the year is still a year.
 */
export function Columns({
  columns,
  colour,
  typical,
  band,
  onPick,
  label,
  tip,
  height = 248,
}: {
  columns: Column[];
  colour: string;
  /** The dashed line: a typical (or average) month. */
  typical?: number;
  /** The shaded band: your lowest to your highest month. */
  band?: [number, number];
  onPick: (key: string) => void;
  label: string;
  /** Shown above the selected column. */
  tip?: ReactNode;
  height?: number;
}) {
  const [ref, width] = useWidth();
  const H = width < 560 ? Math.min(height, 200) : height;
  const y0 = H - PAD.b;
  const plotH = y0 - PAD.t;
  const max = Math.max(1, ...columns.map((c) => c.value), typical ?? 0, band?.[1] ?? 0) * 1.08;
  const y = (v: number) => y0 - (v / max) * plotH;
  const slot = (width - PAD.l - PAD.r) / Math.max(columns.length, 1);
  const barW = Math.min(46, slot * 0.5);
  const hatch = `hatch-${label.replace(/\W+/g, "")}`;
  const sel = columns.findIndex((c) => c.state === "selected");

  return (
    <div className="chart mchart" ref={ref}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={label}>
        <defs>
          <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" style={{ fill: "var(--surface)" }} />
            <line x1="0" y1="0" x2="0" y2="6" style={{ stroke: colour, strokeWidth: 2.2 }} />
          </pattern>
        </defs>
        {band && band[1] > 0 && <rect className="mband" x={PAD.l} y={y(band[1])} width={width - PAD.l} height={Math.max(0, y(band[0]) - y(band[1]))} />}
        <Grid max={max} plotH={plotH} y0={y0} width={width} skipNear={typical} />
        {columns.map((c, i) => {
          const cx = PAD.l + i * slot + slot / 2;
          const h = (c.value / max) * plotH;
          const on = c.state === "selected";
          return (
            <g key={c.key} className={`mk ${c.state}`}>
              {c.state !== "future" && c.value > 0 && (
                <path
                  d={column(cx - barW / 2, barW, y0, Math.max(h, 1))}
                  style={
                    c.state === "partial"
                      ? { fill: `url(#${hatch})`, stroke: colour, strokeWidth: 1.5 }
                      : { fill: colour, opacity: on ? 1 : 0.5, ...(on ? { stroke: "var(--ink)", strokeWidth: 2 } : {}) }
                  }
                />
              )}
              {c.state === "partial" && (
                <text className="tick" x={cx} y={y0 - h - 8} textAnchor="middle">
                  so far
                </text>
              )}
              <text className={`tick lbl ${on ? "on" : ""}`} x={cx} y={H - 12} textAnchor="middle">
                {c.label}
              </text>
              {c.state !== "future" && (
                <rect className="hit" x={cx - slot / 2} y={PAD.t - 4} width={slot} height={plotH + 4} {...svgButton(c.action, () => onPick(c.key))}>
                  <title>{c.action}</title>
                </rect>
              )}
            </g>
          );
        })}
        {typical !== undefined && typical > 0 && <line className="typ" x1={PAD.l} x2={width} y1={y(typical)} y2={y(typical)} />}
      </svg>
      {tip && sel >= 0 && (
        <div className="tip" style={{ left: Math.min(Math.max(PAD.l + sel * slot + slot / 2 - 90, 0), width - 200), top: Math.max(-8, y(columns[sel]!.value) - 64) }}>
          {tip}
        </div>
      )}
    </div>
  );
}

export interface Stack {
  key: string;
  label: string;
  /** Bands from the axis up, in the order given. */
  parts: { name: string; value: number; colour: string }[];
  total: number;
  partial: boolean;
  /** Written above a partial column instead of its total: "part month", "€13,018 · part year". */
  partialNote: string;
  action: string;
}

/**
 * Spending by month (or year), each column split by category. Only the categories with a colour
 * get a band; the rest share the neutral one. A partial month is faded and says so — comparing a
 * few days with a whole month is the mistake the chart should help you avoid.
 */
export function StackedColumns({
  columns,
  typical,
  active,
  onHover,
  onPick,
  label,
}: {
  columns: Stack[];
  typical: number;
  /** The category pointed at: the others fade. */
  active: string | null;
  onHover: (name: string | null) => void;
  onPick: (key: string) => void;
  label: string;
}) {
  const [ref, width] = useWidth();
  const H = width < 560 ? 220 : 260;
  const y0 = H - PAD.b;
  const plotH = y0 - PAD.t - 16;
  const max = Math.max(1, ...columns.map((c) => c.total), typical) * 1.04;
  const slot = (width - PAD.l - PAD.r) / Math.max(columns.length, 1);
  const barW = Math.min(46, slot * 0.56);
  const ty = y0 - (typical / max) * plotH;

  return (
    <div className="chart mchart" ref={ref}>
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={label}>
        <defs>
          {columns.map((c, i) => {
            const h = (c.total / max) * plotH;
            const x = PAD.l + i * slot + (slot - barW) / 2;
            return (
              <clipPath key={c.key} id={`mcol-${i}`}>
                <path d={column(x, barW, y0, Math.max(h, 0))} />
              </clipPath>
            );
          })}
        </defs>
        <Grid max={max} plotH={plotH} y0={y0} width={width} skipNear={typical} />
        {columns.map((c, i) => {
          const x = PAD.l + i * slot + (slot - barW) / 2;
          let yy = y0;
          return (
            <g key={c.key} className="mk" opacity={c.partial ? 0.42 : 1}>
              <g clipPath={`url(#mcol-${i})`}>
                {c.parts.map((p) => {
                  if (p.value <= 0) return null;
                  const h = (p.value / max) * plotH;
                  yy -= h;
                  return (
                    <rect
                      key={p.name}
                      x={x}
                      y={yy}
                      width={barW}
                      height={h}
                      style={{ fill: p.colour }}
                      opacity={active !== null && active !== p.name ? 0.16 : 1}
                      onMouseEnter={() => onHover(p.name)}
                      onMouseLeave={() => onHover(null)}
                    >
                      <title>{`${p.name} · ${c.label} · €${p.value.toFixed(2)}`}</title>
                    </rect>
                  );
                })}
              </g>
              <text className="tick" x={x + barW / 2} y={y0 - (c.total / max) * plotH - 7} textAnchor="middle">
                {c.partial ? c.partialNote : `€${Math.round(c.total)}`}
              </text>
              <text className="tick lbl" x={x + barW / 2} y={H - 12} textAnchor="middle">
                {c.label}
              </text>
              <rect className="hit" x={PAD.l + i * slot} y={PAD.t} width={slot} height={plotH + 16} {...svgButton(c.action, () => onPick(c.key))}>
                <title>{c.action}</title>
              </rect>
            </g>
          );
        })}
        {typical > 0 && (
          <>
            <line className="typ" x1={PAD.l} x2={width} y1={ty} y2={ty} />
            <text className="tick" x={PAD.l - 6} y={ty + 4} textAnchor="end">
              {`€${Math.round(typical)}`}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
