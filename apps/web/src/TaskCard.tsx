import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ProjectWorkspace } from "@orrama/schema/responses";
import { api, unlessAborted } from "./api.js";
import { isoDay, parseDayInput, parseDurationInput, parsePlanInput, parseTimeInput } from "./calendarMath.js";
import { Button, DeadlineChip, Ring, Square, Status, type StatusWord } from "./ui/controls.js";
import { dateLabel, minutesLabel } from "./ui/dates.js";
import { Input } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { useLayer } from "./ui/overlays.js";
import { createPortal } from "react-dom";

/** The planning view's own task shape (a subset of PlanTask). */
export interface PlannableTask {
  noteId: string;
  noteTitle: string;
  line: number;
  blockId: string | null;
  text: string;
  project: string | null;
  due: string | null;
  priority: number | null;
  estimateHours: number;
  scheduledHours: number;
  remainingHours: number;
  atRisk: boolean;
}

const daysTo = (date: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((new Date(`${date}T00:00:00`).getTime() - today) / 86_400_000);
};

const hours = (h: number) => (Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`);
const STATUS_WORDS = new Set<StatusWord>(["planned", "on track", "at risk", "paused", "completed", "archived", "cancelled"]);

/**
 * One step, in full (structure.md §6 #17, the Hours board): what it is, how long it takes,
 * which project it belongs to and when that is due, who is attached (a person is a ring, a
 * company a square), and a day, a time and a length to put it in the week. "sat 11:00" typed
 * into the day and Enter books it: a time books it in your calendar note, a day alone plans
 * it for that day. It exists so a line in To plan stops being an orphan: the project it
 * belongs to is one click away, not a different view.
 *
 * It floats beside the item it was opened from (a bottom sheet on the phone), over To plan,
 * so one step after another can be planned without closing it.
 */
export function TaskCard({
  task,
  onClose,
  onOpenNote,
  onOpenProject,
  onScheduled,
  anchor,
}: {
  task: PlannableTask;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onOpenProject?: (slug: string) => void;
  onScheduled: () => Promise<void> | void;
  /** What it was opened from: it opens beside that. */
  anchor?: HTMLElement | null;
}) {
  const [project, setProject] = useState<ProjectWorkspace | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [day, setDay] = useState(() => dateLabel(isoDay(new Date())));
  const [time, setTime] = useState("");
  const [len, setLen] = useState(() => hours(Math.max(0.5, task.remainingHours || task.estimateHours)));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);
  useLayer({ kind: "dialog", onClose, box, trap: true });

  // Beside what opened it, on the side with room; centred near the top otherwise.
  useLayoutEffect(() => {
    const b = box.current?.getBoundingClientRect();
    const a = anchor?.getBoundingClientRect();
    if (!b) return;
    if (!a || window.innerWidth <= 760) return setAt({});
    const right = a.right + 12;
    const left = right + b.width <= window.innerWidth - 12 ? right : Math.max(12, a.left - 12 - b.width);
    const top = Math.max(12, Math.min(a.top - 20, window.innerHeight - b.height - 12));
    setAt({ position: "fixed", left, top, margin: 0 });
  }, [anchor]);

  // The plan only knows the project's *name*; the workspace is addressed by slug.
  useEffect(() => {
    if (!task.project) return;
    const ac = new AbortController();
    const { signal } = ac;
    void (async () => {
      const list = await api<{ slug: string; name: string }[]>("GET", "/api/projects", undefined, { signal });
      const hit = list.find((p) => p.name === task.project);
      if (!hit) return;
      setSlug(hit.slug);
      setProject(await api<ProjectWorkspace>("GET", `/api/projects/${encodeURIComponent(hit.slug)}`, undefined, { signal }));
    })().catch(unlessAborted);
    return () => ac.abort();
  }, [task.project]);

  /** Plan it: a day and a time books a block; a day alone plans it for that day. */
  const plan = async (typed?: { date: string; startMin: number | null }) => {
    setError(null);
    const read = typed ?? parsePlanInput(day, new Date());
    const date = read?.date ?? parseDayInput(day, new Date());
    if (!date) return setError("Say a day: “sat”, “fri 9 oct”, “tomorrow”.");
    const startMin = read?.startMin ?? (time.trim() ? parseTimeInput(time) : null);
    if (time.trim() && startMin === null && read?.startMin == null) return setError("Say a time on the 24-hour clock: “11:00”, “14:30”.");
    const durationMin = parseDurationInput(len);
    if (startMin !== null && durationMin === null) return setError("Say a length: “2h”, “90m”, “1h30”.");
    setBusy(true);
    try {
      const ref = { noteId: task.noteId, line: task.line, blockId: task.blockId ?? undefined, text: task.text };
      if (startMin !== null) {
        await api("POST", "/api/tasks/blocks", { ...ref, date, startMin, durationMin, estimateHours: task.estimateHours });
        setDone(`Booked ${dateLabel(date)}, ${minutesLabel(startMin)}–${minutesLabel(Math.min(startMin + durationMin!, 24 * 60))}.`);
      } else {
        await api("POST", "/api/tasks/schedule", { ...ref, date });
        setDone(`Planned for ${dateLabel(date)}.`);
      }
      setDay(dateLabel(date));
      if (startMin !== null) setTime(minutesLabel(startMin));
      await onScheduled();
    } catch {
      setDone("");
      setError("That didn't save. Your note is as it was; try again.");
    } finally {
      setBusy(false);
    }
  };

  const projectLeft = project?.deadline ? daysTo(project.deadline) : null;
  const taskLeft = task.due ? daysTo(task.due) : null;
  const status = project?.status?.trim().toLowerCase().replace(/-/g, " ");

  return createPortal(
    <div className="ui-layer plan-tc-layer" data-kind="dialog">
      <div className="ui-scrim plan-tc-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} role="dialog" aria-modal="true" aria-label={task.text} tabIndex={-1} className="ui tc plan-tc" style={at ?? { visibility: "hidden" }}>
        <div className="tc-k">
          <Icon name="check" size={16} />
          Step
          <Button kind="quiet" size="sm" icon="x" className="x" onClick={onClose} aria-label="Close" />
        </div>
        <div>
          <h3>{task.text}</h3>
          <div className="in">
            {task.project && (
              <>
                In{" "}
                <button type="button" className="ui-nm" onClick={() => slug && onOpenProject?.(slug)} disabled={!slug || !onOpenProject}>
                  {task.project}
                </button>{" "}
                ·{" "}
              </>
            )}
            {task.project ? "from" : "From"} the note{" "}
            <button type="button" className="ui-nm" onClick={() => onOpenNote(task.noteId)}>
              {task.noteTitle}
            </button>
          </div>
        </div>

        <div className="tc-stats">
          <div>
            <span>Estimate</span>
            <b>{hours(task.estimateHours)}</b>
          </div>
          <div>
            <span>Planned</span>
            <b>{hours(task.scheduledHours)}</b>
          </div>
          <div>
            <span>Left</span>
            <b>{hours(task.remainingHours)}</b>
          </div>
          <div>
            <span>Due</span>
            <b className={taskLeft !== null && taskLeft < 0 ? "late" : ""}>{task.due ? dateLabel(task.due) : "no day"}</b>
          </div>
        </div>

        {task.project && (
          <div className="tc-proj">
            <button type="button" className="ui-nm" onClick={() => slug && onOpenProject?.(slug)} disabled={!slug || !onOpenProject}>
              {task.project}
            </button>
            {status && (STATUS_WORDS.has(status as StatusWord) ? <Status value={status as StatusWord} /> : <span className="q3">{project!.status}</span>)}
            {project?.deadline && (
              <DeadlineChip small>
                Key deadline {dateLabel(project.deadline)}
                {projectLeft !== null && projectLeft < 0 ? ` · ${-projectLeft}d over` : ""}
              </DeadlineChip>
            )}
          </div>
        )}
        {project && project.people.length > 0 && (
          <div className="tc-who">
            {project.people.map((p) => (
              <button key={p.id} type="button" className={p.kind === "company" ? "co" : undefined} onClick={() => onOpenNote(p.id)} title={[p.role, p.company].filter(Boolean).join(" · ") || undefined}>
                {p.kind === "company" ? <Square name={p.title} small /> : <Ring name={p.title} small />}
                {p.title}
              </button>
            ))}
          </div>
        )}
        {project && project.people.length === 0 && <p className="tc-none">Nobody attached to this project yet.</p>}

        <div className="lbl" id="tc-plan-lbl">
          Put it in the week
        </div>
        <form
          className="tc-plan"
          aria-labelledby="tc-plan-lbl"
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
        >
          <Input
            aria-label="Day"
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              setDone("");
            }}
            onFocus={(e) => e.target.select()}
            autoFocus
          />
          <Input aria-label="Time" placeholder="time" value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" />
          <Input aria-label="Length" value={len} onChange={(e) => setLen(e.target.value)} />
          <Button kind="solid" type="submit" disabled={busy}>
            {busy ? "Planning…" : "Plan it"}
          </Button>
        </form>
        {error ? (
          <p className="tc-err" role="alert">
            {error}
          </p>
        ) : done ? (
          <p className="tc-done" role="status">
            {done}
          </p>
        ) : (
          <p className="kh">Type “sat 11:00” and press Enter. A time books it in your calendar note; a day alone plans it for that day.</p>
        )}
      </div>
    </div>,
    document.body,
  );
}
