/**
 * The story: every place on one timeline (ME). One lane per Lane (Study, Work, Built), a bar per
 * Experience row in its lane's colour, the "now" line in --sun, years given room by how much
 * happened in them and each labelled, so the scale is honest (core storyOf).
 *
 * A bar's label sits inside it; if it doesn't fit, the place alone; if that doesn't either, beside
 * the bar when there is room before the next one, else shortened with the whole name in its tooltip. Measured after layout and on
 * resize. Where the story is narrower than 720 px it scrolls sideways in its box and opens on now.
 */
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { Story as StoryData } from "@orrama/core/persona-graph";
import { laneColor } from "./model.js";
import { useLink, useMe } from "./context.js";

function placeLabels(box: HTMLElement) {
  for (const row of box.querySelectorAll<HTMLElement>(".me-lr")) {
    const bars = [...row.querySelectorAll<HTMLElement>(".me-bar")].sort((a, b) => a.offsetLeft - b.offsetLeft);
    bars.forEach((bar, i) => {
      delete bar.dataset.place;
      const label = bar.querySelector("span")!;
      const fits = () => label.scrollWidth <= label.clientWidth + 1;
      label.textContent = bar.dataset.label ?? "";
      if (fits()) return;
      // Too long: the place alone, then beside the bar when there is room, else cut short.
      label.textContent = bar.dataset.short ?? "";
      if (fits()) return;
      const next = bars[i + 1];
      const room = (next ? next.offsetLeft : row.clientWidth) - (bar.offsetLeft + bar.offsetWidth) - 12;
      if (label.scrollWidth <= room) bar.dataset.place = "beside";
    });
  }
}

export function Story({ story }: { story: StoryData }) {
  const { lanes } = useMe();
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    placeLabels(el);
    // A story that scrolls opens at now.
    if (el.scrollWidth > el.clientWidth + 1) el.scrollLeft = Math.max(0, (el.scrollWidth * story.now) / 100 - el.clientWidth * 0.75);
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => placeLabels(el));
    watch.observe(el);
    void document.fonts?.ready.then(() => placeLabels(el));
    return () => watch.disconnect();
  }, [story]);
  let i = 0;
  return (
    <div className="me-story" ref={box}>
      <div className="me-story-in" style={{ "--now": story.now } as CSSProperties}>
        <div className="me-ax">
          <span className="me-lnm" />
          <div className="me-lt">
            {story.years.map((y) => (
              <span key={y.year} className="me-yr" style={{ left: `${y.left}%`, width: `${y.width}%` }}>
                {y.year}
              </span>
            ))}
          </div>
        </div>
        {story.lanes.map((l) => (
          <div key={l.lane} className="me-ln" role="group" aria-label={l.lane}>
            <span className="me-lnm">
              <span className="me-dot" style={{ background: laneColor(l.lane, lanes) }} />
              {l.lane}
            </span>
            <div className="me-lt">
              {Array.from({ length: l.rows }, (_, row) => (
                <div key={row} className="me-lr">
                  {story.bars
                    .filter((b) => b.lane === l.lane && b.row === row)
                    .map((b) => (
                      <Bar key={b.key} bar={b} color={laneColor(b.lane, lanes)} order={i++} />
                    ))}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="me-nowl" aria-hidden="true">
          <span>Now</span>
        </div>
      </div>
    </div>
  );
}

function Bar({ bar, color, order }: { bar: StoryData["bars"][number]; color: string; order: number }) {
  const link = useLink(bar.key);
  return (
    <button
      type="button"
      {...link}
      className={["me-bar", bar.open && "open", bar.now && "now", link.className].filter(Boolean).join(" ")}
      style={{ left: `${bar.left}%`, width: `${bar.width}%`, "--lc": color, "--i": order } as CSSProperties}
      title={bar.label}
      data-label={bar.label}
      data-short={bar.short}
      data-left={bar.left.toFixed(2)}
    >
      {/* Its text is set after layout (placeLabels): the whole label, or the place alone. */}
      <span>{bar.label}</span>
    </button>
  );
}
