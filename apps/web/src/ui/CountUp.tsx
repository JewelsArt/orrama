/**
 * A hero's figure that counts up as it arrives (Clay, 19 October 2026: the reel's counting
 * number). `text` is the figure as the page writes it ("€1,520.00"); its whole part is wrapped
 * so clay.css can count it up with a registered integer (@property) and CSS counters.
 *
 * The real figure is always in the page as text. Clay, with motion allowed, hides that text
 * visually (screen readers still read it) and draws the counting digits in ::before, whose
 * alternative text is empty, so nothing is read twice. Paper, and anyone who asked for less
 * motion, sees the text as it is. Counters know no thousands separator, so from 1,000 the
 * count is drawn as thousands "," hundreds (--k), and starts at the first thousand.
 */
import type { CSSProperties } from "react";

export function CountUp({ text }: { text: string }) {
  const m = /^(\D*?)(\d{1,3}(?:,\d{3})*|\d+)(.*)$/.exec(text);
  if (!m) return <>{text}</>;
  const [, before, whole, after] = m as unknown as [string, string, string, string];
  const n = Number(whole.replace(/,/g, ""));
  if (!Number.isSafeInteger(n) || n >= 1_000_000) return <>{text}</>;
  const thousands = n >= 1000;
  const style = { "--to": n, "--from": thousands ? Math.floor(n / 1000) * 1000 : 0 } as CSSProperties;
  return (
    <>
      {before}
      <span className={thousands ? "cnt k" : "cnt"} style={style}>
        <span className="cnt-n">{whole}</span>
      </span>
      {after}
    </>
  );
}
