/**
 * The Orrery's five shapes, drawn small for the panel, the legend and Find: a project is a
 * progress ring, a person a ring, a company a rounded square, a note a dot, a conversation an
 * open circle; reviews and templates a faint dot. The canvas draws the same shapes.
 */
import type { Kind } from "./model.js";

export function Glyph({ t, size = 18 }: { t: Kind; size?: number }) {
  if (t === 0)
    return (
      <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="11" fill="none" stroke="var(--line-2)" strokeWidth="3.4" />
        <circle cx="15" cy="15" r="11" fill="none" stroke="var(--ink)" strokeWidth="3.4" strokeDasharray="22 69" transform="rotate(-90 15 15)" strokeLinecap="round" />
      </svg>
    );
  if (t === 1)
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="7" fill="var(--surface)" stroke="var(--ink-2)" strokeWidth="1.4" />
      </svg>
    );
  if (t === 2)
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
        <rect x="2" y="2" width="14" height="14" rx="4" fill="var(--surface)" stroke="var(--ink-2)" strokeWidth="1.4" />
      </svg>
    );
  if (t === 4)
    return (
      <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r="5" fill="none" stroke="var(--ink-2)" strokeWidth="1.6" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="9" cy="9" r="4.5" fill={t === 5 ? "var(--ink-3)" : "var(--ink)"} />
    </svg>
  );
}
