import { IconChevron } from "./icons.js";

/**
 * One project's header row on the Overview board.
 *
 * The row used to be one big <button> holding the lifecycle buttons, which is
 * invalid HTML (React warned: "<button> cannot be a descendant of <button>")
 * and hid those buttons from assistive tech inside another control. Now the
 * row is a plain container: a click anywhere on it still folds the project
 * (mouse convenience), the chevron is the real, focusable toggle, and the
 * name, Gantt switch and lifecycle actions are sibling buttons that stop the
 * click from reaching the row. Kept apart from Overview.tsx so it renders
 * without the API client, which is what lets a test render it.
 */
export function OverviewHead({
  name,
  open,
  parked,
  sleeping,
  pct,
  donePct,
  workPct,
  nextDue,
  gantt,
  onToggle,
  onOpenProject,
  onToggleGantt,
  onLifecycle,
  onCancel,
}: {
  name: string;
  open: boolean;
  /** Sleeping or cancelled — off the active board. */
  parked: boolean;
  sleeping: boolean;
  pct: number;
  donePct: number;
  workPct: number;
  nextDue: string | undefined;
  gantt: boolean;
  onToggle: () => void;
  /** Absent when the project has no workspace to open. */
  onOpenProject?: () => void;
  onToggleGantt: () => void;
  onLifecycle: (status: "on-track" | "sleeping") => void;
  onCancel: () => void;
}) {
  const inner = (f: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    f();
  };
  return (
    <div className="ov-project-head" onClick={onToggle}>
      <button className="ov-chev" data-open={open} aria-expanded={open} aria-label={open ? `Fold ${name}` : `Unfold ${name}`} onClick={inner(onToggle)}>
        <IconChevron open={open} />
      </button>
      {onOpenProject ? (
        <button className="ov-pname link" title="Open the project workspace" onClick={inner(onOpenProject)}>
          {name}
        </button>
      ) : (
        <span className="ov-pname">{name}</span>
      )}
      <span className="ov-battery" aria-hidden>
        <i className="d" style={{ width: `${donePct}%` }} />
        <i className="w" style={{ width: `${workPct}%` }} />
      </span>
      <span className="ov-pct">{pct}%</span>
      {parked ? (
        <span className="ov-state">{sleeping ? "sleeping" : "cancelled"}</span>
      ) : (
        <span className="ov-due">{nextDue ? `due ${nextDue.slice(5)}` : "no due date"}</span>
      )}
      <button className={`ov-gantt-sw ${gantt ? "on" : ""}`} role="switch" aria-checked={gantt} onClick={inner(onToggleGantt)}>
        <i aria-hidden />
        Gantt
      </button>
      <span className="ov-life" role="group" aria-label="Project lifecycle" onClick={(e) => e.stopPropagation()}>
        {parked ? (
          <button className="ov-life-btn" title="Put it back on the active board" onClick={inner(() => onLifecycle("on-track"))}>
            Wake
          </button>
        ) : (
          <button className="ov-life-btn" title="Not this month's problem — keep it, hide it" onClick={inner(() => onLifecycle("sleeping"))}>
            Sleep
          </button>
        )}
        {(!parked || sleeping) && (
          <button className="ov-life-btn danger" title="Stop the project — the note and its history stay" onClick={inner(onCancel)}>
            Cancel
          </button>
        )}
      </span>
    </div>
  );
}
