/**
 * Empty, loading and error (structure.md §6 #24–25, the states board). Empty: Orr's pose, one
 * line, one action, never a wall of zeros and never a celebration. Loading: the page's shape in
 * grey, or what is happening and how far along. Errors: what failed, in plain words, and the
 * fix; everything else keeps working. Orr is never in an error.
 */
import { type ReactNode } from "react";
import { Bar } from "./controls.js";
import { Icon } from "./Icon.js";
import { Orr, type OrrPose } from "./orr/Orr.js";

export function EmptyState({ pose, title, text, actions }: { pose: OrrPose; title: string; text?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ui-empty">
      <div className="orrbox">
        <Orr pose={pose} size={64} />
      </div>
      <div>
        <b>{title}</b>
        {text && <p>{text}</p>}
        {actions && <div className="acts">{actions}</div>}
      </div>
    </div>
  );
}

/** A notice: an error with its fix (the default), or good news. Never raw exception text. */
export function Notice({ title, text, actions, ok }: { title: string; text?: ReactNode; actions?: ReactNode; ok?: boolean }) {
  return (
    <div className={ok ? "notice ok" : "notice"} role={ok ? "status" : "alert"}>
      <Icon name={ok ? "check" : "warn"} />
      <div>
        <b>{title}</b>
        {text && <span>{text}</span>}
        {actions && <div className="acts">{actions}</div>}
      </div>
    </div>
  );
}

/** Grey row shapes where content is on its way. No spinner. */
export function Skeleton({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  const widths = ["92%", "74%", "86%", "62%", "80%"];
  return (
    <div className="skels" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skel" style={{ width: widths[i % widths.length], margin: "10px 0 14px" }} />
      ))}
    </div>
  );
}

/** A long job, said with numbers: "Reading 312 notes… 184 done", and a real bar. */
export function Progress({ title, done, value, note }: { title: string; done?: string; value: number; note?: ReactNode }) {
  return (
    <div className="progress" role="status">
      <div className="mh">
        <b>{title}</b>
        {done && <span className="c">{done}</span>}
      </div>
      <Bar value={value} label={`${Math.round(value * 100)}%`} />
      {note && <p className="q3">{note}</p>}
    </div>
  );
}
