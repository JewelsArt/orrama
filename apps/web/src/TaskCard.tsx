import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ProjectWorkspace, TaskCardData } from "@orrama/schema/responses";
import { api, ApiError, unlessAborted } from "./api.js";
import { isoDay, parseDayInput, parseDurationInput, parsePlanInput, parseTimeInput } from "./calendarMath.js";
import { parseDateInput } from "./entity/dateInput.js";
import { Button, DeadlineChip, Ring, Segmented, Square, Status, type StatusWord } from "./ui/controls.js";
import { dateLabel, minutesLabel } from "./ui/dates.js";
import { Field, Input, Select, Switch } from "./ui/fields.js";
import { Icon } from "./ui/Icon.js";
import { Menu, toast, useLayer } from "./ui/overlays.js";
import { Notice } from "./ui/states.js";
import { failureText } from "./ui/writes.js";
import { PRIORITY_WORDS, STATUS_MENU, type TaskStatus } from "./steps.js";
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

type Edit = { words?: string; due?: string | null; start?: string | null; priority?: 1 | 2 | 3 | null; key?: boolean; status?: TaskStatus };
type View = "card" | "move" | "delete";

/**
 * One step, in full (structure.md §6 #17, the Hours board), and the one place a step is changed:
 * its words, its due and start dates, its priority, the key-deadline tag and its status, each
 * written into its own line in its note (`POST /api/tasks/edit`), moved to another project's
 * section or the inbox, or deleted. Below that, what it belongs to and when that is due, who is
 * attached (a person is a ring, a company a square), and a day, a time and a length to put it
 * in the week: "sat 11:00" and Enter books it in your calendar note, a day alone sets its due.
 *
 * It floats beside the item it was opened from (a bottom sheet on the phone), over To plan,
 * so one step after another can be planned without closing it. Moving and deleting happen in
 * the card itself: a second dialog would replace it in the overlay stack.
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
  /** Something about the step changed in its note: the page reloads. */
  onScheduled: () => Promise<void> | void;
  /** What it was opened from: it opens beside that. */
  anchor?: HTMLElement | null;
}) {
  const [data, setData] = useState<TaskCardData | null>(null);
  const [gone, setGone] = useState(false);
  const [project, setProject] = useState<ProjectWorkspace | null>(null);
  const [view, setView] = useState<View>("card");
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

  /** The step as its note has it now, named the way every task edit names it (COR-001). */
  const ref = useCallback(
    (t: { noteId: string; line: number; blockId?: string | null; text: string }) => ({ noteId: t.noteId, line: t.line, text: t.text, ...(t.blockId ? { blockId: t.blockId } : {}) }),
    [],
  );
  const current = data ? ref(data.task) : ref(task);

  const load = useCallback(
    async (r: ReturnType<typeof ref>, signal?: AbortSignal) => {
      const q = new URLSearchParams({ noteId: r.noteId, line: String(r.line), text: r.text, ...(r.blockId ? { blockId: r.blockId } : {}) });
      try {
        setData(await api<TaskCardData>("GET", `/api/tasks/card?${q}`, undefined, { signal }));
        setGone(false);
      } catch (e) {
        // Not in its note as it is now (409), or the note itself is gone or out of reach (404).
        if (e instanceof ApiError && (e.status === 409 || e.status === 404)) setGone(true);
        else if (!signal?.aborted) setError(failureText(e, "The step couldn't be read."));
      }
    },
    [],
  );
  // The step it opened on; every later change comes back in its write's answer.
  useEffect(() => {
    const ac = new AbortController();
    void load(ref(task), ac.signal);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The project's status, deadline and people, from its workspace.
  const slug = data?.project?.slug ?? null;
  useEffect(() => {
    setProject(null);
    if (!slug) return;
    const ac = new AbortController();
    api<ProjectWorkspace>("GET", `/api/projects/${encodeURIComponent(slug)}`, undefined, { signal: ac.signal }).then(setProject).catch(unlessAborted);
    return () => ac.abort();
  }, [slug]);

  /**
   * One write from the card. A step changed in its note since (409) is read again and said;
   * anything else is said beside the card. The page reloads after every landed change.
   */
  const write = async (what: string, url: string, body: object): Promise<TaskCardData | null> => {
    setError(null);
    setDone("");
    try {
      const next = await api<TaskCardData>("POST", url, { ...current, ...body });
      await onScheduled();
      return next;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        await load(current);
        setError("This step changed in its note since the card opened. Here it is as it is now.");
      } else setError(failureText(e, what));
      return null;
    }
  };
  const change = async (edit: Edit, what: string) => {
    const next = await write(what, "/api/tasks/edit", edit);
    if (next) setData(next);
    return !!next;
  };

  /** Plan it: a day and a time books a block; a day alone sets the step's due date. */
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
      if (startMin !== null) {
        await api("POST", "/api/tasks/blocks", { ...current, date, startMin, durationMin, estimateHours: task.estimateHours });
        setDone(`Booked ${dateLabel(date)}, ${minutesLabel(startMin)}–${minutesLabel(Math.min(startMin + durationMin!, 24 * 60))}.`);
        setDay(dateLabel(date));
        setTime(minutesLabel(startMin));
        await onScheduled();
        await load(current);
      } else if (await change({ due: date }, "The due date wasn't set.")) {
        setDone(`Due ${dateLabel(date)}.`);
        setDay(dateLabel(date));
      }
    } catch {
      setDone("");
      setError("That didn't save. Your note is as it was; try again.");
    } finally {
      setBusy(false);
    }
  };

  /** Delete the step; `write` says any failure in the card. */
  const remove = async () => {
    setBusy(true);
    try {
      if (!(await write("The step wasn't deleted.", "/api/tasks/delete", {}))) return;
      toast("Step deleted.");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const t = data?.task;
  const canEdit = !!data?.canEdit && !gone;
  const title = t?.text ?? task.text;
  const due = t ? (t.due ?? null) : task.due;
  const projectLeft = project?.deadline ? daysTo(project.deadline) : null;
  const taskLeft = due ? daysTo(due) : null;
  const projStatus = project?.status?.trim().toLowerCase().replace(/-/g, " ");
  const projectName = data?.project?.name ?? task.project;

  return createPortal(
    <div className="ui-layer plan-tc-layer" data-kind="dialog">
      <div className="ui-scrim plan-tc-scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="ui tc plan-tc" style={at ?? { visibility: "hidden" }}>
        <div className="tc-k">
          <Icon name="check" size={16} />
          Step
          <Button kind="quiet" size="sm" icon="x" className="x" onClick={onClose} aria-label="Close" />
        </div>

        {view === "move" && data ? (
          <MoveStep data={data} onBack={() => setView("card")} onMove={async (to) => {
            const next = await write("The step wasn't moved.", "/api/tasks/move", { to });
            if (!next) return false;
            setData(next);
            setView("card");
            setDone(next.inInbox ? "Moved to your inbox." : `Moved to ${next.project?.name ?? next.task.noteTitle}${next.section ? `, under ${next.section}` : ""}.`);
            return true;
          }} error={error} />
        ) : view === "delete" ? (
          <div className="tc-ask" role="alertdialog" aria-label="Delete this step?">
            <h3>Delete this step?</h3>
            <p>
              “{title}” is taken out of {t?.noteTitle ?? task.noteTitle}.
            </p>
            {error && <Notice title={error} />}
            <div className="tc-acts">
              <Button onClick={() => setView("card")}>Keep it</Button>
              <Button danger data-autofocus disabled={busy} onClick={() => void remove()}>
                Delete the step
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <TitleField title={title} words={t?.words ?? null} canEdit={canEdit} onSave={(words) => change({ words }, "The step wasn't renamed.")} />
              <div className="in">
                {projectName && (
                  <>
                    In{" "}
                    <button type="button" className="ui-nm" onClick={() => slug && onOpenProject?.(slug)} disabled={!slug || !onOpenProject}>
                      {projectName}
                    </button>
                    {data?.section ? ` · ${data.section}` : ""} ·{" "}
                  </>
                )}
                {projectName ? "from" : "From"} the note{" "}
                <button type="button" className="ui-nm" onClick={() => onOpenNote(t?.noteId ?? task.noteId)}>
                  {t?.noteTitle ?? task.noteTitle}
                </button>
              </div>
              {t?.key && (
                <div className="tc-key">
                  <DeadlineChip small>Key deadline{due ? ` ${dateLabel(due)}` : ""}</DeadlineChip>
                </div>
              )}
            </div>

            {gone && <Notice title="This step is no longer in its note." text="It was changed or taken out somewhere else. Open the note to see it as it is." />}

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
                <b className={taskLeft !== null && taskLeft < 0 && t?.status !== "done" ? "late" : ""}>{due ? dateLabel(due) : "no day"}</b>
              </div>
            </div>

            <div className="tc-facts">
              <Fact label="Status">
                <StatusPick value={t?.status ?? "todo"} disabled={!canEdit} onPick={(status) => void change({ status }, "The step's status wasn't changed.")} />
              </Fact>
              <Fact label="Due">
                <DateField label="Due" value={due} disabled={!canEdit} onSave={(v) => change({ due: v }, "The due date wasn't changed.")} />
              </Fact>
              <Fact label="Start">
                <DateField label="Start" value={t?.start ?? null} disabled={!canEdit} onSave={(v) => change({ start: v }, "The start date wasn't changed.")} />
              </Fact>
              <Fact label="Priority">
                <fieldset className="tc-prio" disabled={!canEdit}>
                  <Segmented
                    label="Priority"
                    items={PRIORITY_WORDS.map((p) => ({ id: p.id, label: p.label }))}
                    value={String(t?.priority ?? 0) as (typeof PRIORITY_WORDS)[number]["id"]}
                    onChange={(id) => void change({ priority: id === "0" ? null : (Number(id) as 1 | 2 | 3) }, "The priority wasn't changed.")}
                  />
                </fieldset>
              </Fact>
              <Fact label="Key deadline">
                <Switch label="Key deadline" checked={!!t?.key} disabled={!canEdit} onChange={(on) => void change({ key: on }, on ? "The step wasn't made a key deadline." : "The key deadline wasn't taken off.")} />
              </Fact>
            </div>

            {projectName && (
              <div className="tc-proj">
                <button type="button" className="ui-nm" onClick={() => slug && onOpenProject?.(slug)} disabled={!slug || !onOpenProject}>
                  {projectName}
                </button>
                {projStatus && (STATUS_WORDS.has(projStatus as StatusWord) ? <Status value={projStatus as StatusWord} /> : <span className="q3">{project!.status}</span>)}
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
                disabled={gone}
                autoFocus
              />
              <Input aria-label="Time" placeholder="time" value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" disabled={gone} />
              <Input aria-label="Length" value={len} onChange={(e) => setLen(e.target.value)} disabled={gone} />
              <Button kind="solid" type="submit" disabled={busy || gone}>
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
              <p className="kh">Type “sat 11:00” and press Enter. A time books it in your calendar; a day alone makes it the step's due date.</p>
            )}

            {canEdit && (
              <div className="tc-acts">
                <Button size="sm" icon="arrow-r" onClick={() => setView("move")} disabled={!data}>
                  Move to…
                </Button>
                <Button size="sm" kind="quiet" danger icon="trash" onClick={() => setView("delete")}>
                  Delete
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** A label and its control, one row of the card's facts. */
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="tc-fact">
    <span className="tc-fl">{label}</span>
    {children}
  </div>
);

/** The step's words: its title, and a field when clicked. Enter or leaving saves; Escape closes the card, as it always does. */
function TitleField({ title, words, canEdit, onSave }: { title: string; words: string | null; canEdit: boolean; onSave: (words: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (editing === null || words === null)
    return (
      <h3>
        {canEdit && words !== null ? (
          <button type="button" className="tc-title" onClick={() => setEditing(words)} title="Change the words">
            {title}
          </button>
        ) : (
          title
        )}
      </h3>
    );
  const save = async () => {
    const next = editing.replace(/\s+/g, " ").trim();
    if (!next || next === words) return setEditing(null);
    if (await onSave(next)) setEditing(null);
  };
  return (
    <Input
      className="tc-title-in"
      aria-label="The step"
      autoFocus
      value={editing}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        }
      }}
    />
  );
}

/**
 * A date typed as text (entity/dateInput.ts: day before month), written when the field is left
 * or Enter is pressed, never while typing. Empty clears it. What it would write is said first.
 */
function DateField({ label, value, disabled, onSave }: { label: string; value: string | null; disabled: boolean; onSave: (v: string | null) => Promise<boolean> }) {
  const shown = value ? dateLabel(value) : "";
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const parsed = parseDateInput(text);
  const commit = async () => {
    if (parsed === null) return;
    const next = parsed === "" ? null : parsed;
    if (next === value) return setText(shown);
    if (!(await onSave(next))) setText(shown);
  };
  return (
    <span className="tc-date">
      <Input
        aria-label={label}
        value={text}
        placeholder="no day"
        disabled={disabled}
        aria-invalid={parsed === null || undefined}
        onFocus={() => setFocused(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setFocused(false);
          void commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
        }}
      />
      {focused && text !== shown && <span className={parsed === null ? "tc-dh bad" : "tc-dh"}>{parsed === null ? "Not a date yet: try 19 Oct" : parsed ? dateLabel(parsed) : "No date"}</span>}
    </span>
  );
}

/** The step's status as a menu: the same four the project To-do's menu offers. */
function StatusPick({ value, disabled, onPick }: { value: TaskStatus; disabled: boolean; onPick: (s: TaskStatus) => void }) {
  const [open, setOpen] = useState(false);
  const at = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={at} size="sm" className="tc-status" aria-haspopup="menu" aria-expanded={open} aria-label={`Status: ${STATUS_MENU.find((s) => s.id === value)!.label}`} disabled={disabled} onClick={() => setOpen((v) => !v)}>
        {STATUS_MENU.find((s) => s.id === value)!.label}
        <Icon name="chev-d" size={14} />
      </Button>
      {open && <Menu anchor={at} label="Status" onClose={() => setOpen(false)} items={STATUS_MENU.map((s) => ({ label: s.label, checked: s.id === value, onSelect: () => s.id !== value && onPick(s.id) }))} />}
    </>
  );
}

const INBOX = "\u0000inbox";

/** Where the step goes: a project (its sections listed) or your inbox. */
function MoveStep({ data, onBack, onMove, error }: { data: TaskCardData; onBack: () => void; onMove: (to: { project: string; section: string } | { inbox: true }) => Promise<boolean>; error: string | null }) {
  const first = data.project && data.places.some((p) => p.slug === data.project!.slug) ? data.project.slug : (data.places[0]?.slug ?? INBOX);
  const [where, setWhere] = useState(first);
  const place = data.places.find((p) => p.slug === where);
  const [section, setSection] = useState(() => (place && data.section && place.sections.includes(data.section) ? data.section : (place?.sections[0] ?? "")));
  const [busy, setBusy] = useState(false);
  /** `onMove` says any failure in the card; busy ends whatever happens. */
  const move = async () => {
    setBusy(true);
    try {
      await onMove(where === INBOX ? { inbox: true } : { project: where, section });
    } finally {
      setBusy(false);
    }
  };
  const pick = (slug: string) => {
    setWhere(slug);
    setSection(data.places.find((p) => p.slug === slug)?.sections[0] ?? "");
  };
  return (
    <form
      className="tc-ask"
      aria-label="Move this step"
      onSubmit={(e) => {
        e.preventDefault();
        void move();
      }}
    >
      <h3>Move this step</h3>
      <p>“{data.task.text}” leaves {data.task.noteTitle} and goes last under the place you pick.</p>
      <Field label="To">
        <Select value={where} onChange={(e) => pick(e.target.value)}>
          {data.places.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
          {!data.inInbox && <option value={INBOX}>Your inbox</option>}
        </Select>
      </Field>
      {place && (
        <Field label="Under">
          <Select value={section} onChange={(e) => setSection(e.target.value)}>
            {place.sections.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {error && <Notice title={error} />}
      <div className="tc-acts">
        <Button type="button" onClick={onBack}>
          Back
        </Button>
        <Button kind="solid" type="submit" disabled={busy || (where !== INBOX && !section)}>
          {busy ? "Moving…" : "Move it"}
        </Button>
      </div>
    </form>
  );
}
