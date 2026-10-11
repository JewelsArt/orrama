import { useRef, useState, type ReactNode } from "react";
import type { DashboardTask } from "./api.js";
import { daysTo, type Category } from "./categories.js";
import { shelfOf, statusOf, statusProblems, type Shelf } from "./entity/index.js";
import { statusLook } from "./entity/StatusMenu.js";
import { dueOf, StepMenu, taskState } from "./ProjectViews.js";
import { Checkbox, DeadlineChip, ProgressRing, Ring, Square } from "./ui/controls.js";
import { dateLabel } from "./ui/dates.js";
import { Icon } from "./ui/Icon.js";
import { HeadMark } from "./ui/orr/Orr.js";
import { Menu, type MenuItem } from "./ui/overlays.js";

/**
 * One project on the Projects board (structure.md §2.4, board projects.html): its progress ring,
 * the area's dot, its name and next step, status as a dot and a word, the next open step's date,
 * the next key deadline, the people (rings for people, squares for companies), Orr's head with a
 * count when something about it is off, and a chevron that unfolds its steps.
 *
 * No control sits inside another (OverviewHead.test.tsx walks the markup): the name is the link
 * and stretches over the row, so the whole width opens the project, while the chevron, the ⋯
 * menu and the steps' own controls are siblings above it. Kept apart from Overview.tsx so it
 * renders without the API client.
 */

export interface BoardPerson {
  id: string;
  title: string;
  kind: "person" | "company";
}

export interface BoardProject {
  slug: string;
  /** The board's own id for the project (`projects` row): Remove from the board uses it. */
  projectId: string | null;
  name: string;
  /** Where the name goes: the project, on the tab used last. */
  href: string;
  noteId: string | null;
  area: Category | null;
  status: string;
  shelf: Shelf;
  total: number;
  done: number;
  tasks: DashboardTask[];
  next: DashboardTask | null;
  key: DashboardTask | null;
  deadline: string | null;
  people: BoardPerson[];
  /** What Orr noticed: no status, a word outside the vocabulary, the graph's warnings. */
  flags: string[];
}

/** The open steps first (late, then by date, undated last), done ones sinking to the bottom. */
export function stepOrder(a: DashboardTask, b: DashboardTask): number {
  return Number(a.checked) - Number(b.checked) || (a.due ?? "9999").localeCompare(b.due ?? "9999") || Number(b.status === "in-progress") - Number(a.status === "in-progress");
}

/**
 * The board's row for a project, from what the app knows: its steps (`/api/dashboard`), its note
 * (`/api/projects`), its area, the people its note links to, and the graph's warnings.
 *
 * The next date is the next OPEN step's (§2.4: it used to be the earliest `due` of any step,
 * done or not), and the key deadline the next open `#deadline` step, else the note's own
 * `deadline:`.
 */
export function boardProject(input: {
  slug: string;
  projectId: string | null;
  name: string;
  href: string;
  noteId: string | null;
  area: Category | null;
  status: string;
  total: number;
  done: number;
  tasks: DashboardTask[];
  deadline: string | null;
  people: BoardPerson[];
  warnings: string[];
}): BoardProject {
  const open = input.tasks.filter((t) => !t.checked);
  const next = open.slice().sort(stepOrder)[0] ?? null;
  const key = open.filter((t) => t.key && t.due).sort((a, b) => a.due!.localeCompare(b.due!))[0] ?? null;
  // The graph says "has no status" itself when it has an ontology: one flag, not two.
  const own = input.warnings.some((w) => /status/i.test(w)) ? [] : statusProblems(input.status);
  return {
    ...input,
    shelf: shelfOf(input),
    next,
    key,
    flags: [...own, ...input.warnings],
  };
}

const shortStep = (s: string) => s.split(/\s+[—–-]\s+|:\s/)[0]!.trim();
/** "Mon 19" within the next four weeks, where the month goes without saying; else "Mon 19 Oct". */
function shortDate(iso: string): string {
  const d = daysTo(iso);
  const full = dateLabel(iso);
  return d !== null && d >= -6 && d <= 27 ? full.split(" ").slice(0, 2).join(" ") : full;
}

/** The next date's two lines: "Today" / "in 3 days", "5 days late" / "was Sat 3 Oct". */
export function nextDate(t: DashboardTask | null, today: Date = new Date()): { big: string; small: string; late: boolean } | null {
  if (!t?.due) return null;
  const due = dueOf(t);
  if (due.late) return { big: due.text, small: `was ${dateLabel(t.due, today)}`, late: true };
  if (due.text === "today") return { big: "Today", small: "", late: false };
  if (due.text === "tomorrow") return { big: "Tomorrow", small: "", late: false };
  return { big: dateLabel(t.due, today), small: "", late: false };
}

export function ProjectRow({
  p,
  open,
  onToggle,
  onOpen,
  menu,
  people = true,
}: {
  p: BoardProject;
  open: boolean;
  onToggle: () => void;
  onOpen: () => void;
  /** The ⋯ menu's actions; none, no menu. */
  menu: (MenuItem | "-")[];
  /** Draw the people column (off on a shelf, where there is none). */
  people?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const look = statusLook(p.status);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const nd = nextDate(p.next);
  const keyDate = p.key?.due ?? p.deadline ?? null;
  const keyWhat = p.key ? shortStep(p.key.text) : p.deadline ? "Deadline" : "";
  const keyWhen = p.key ? shortDate(p.key.due!) : p.deadline ? shortDate(p.deadline) : "";
  const atRisk = statusOf(p.status) === "at-risk";
  return (
    <div className={`pg pr-row${open ? " open" : ""}`}>
      <span style={atRisk ? ({ "--prog": "var(--warn)" } as React.CSSProperties) : undefined}>
        <ProgressRing value={p.total ? p.done / p.total : 0} size={34} label={`${pct}% done`} />
      </span>
      <div className="x">
        <span className="t">
          {p.area && <span className="ui-dot" style={{ background: p.area.color }} title={p.area.label} />}
          <a
            className="pr-link"
            href={p.href}
            onClick={(e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              onOpen();
            }}
          >
            {p.name}
          </a>
        </span>
        <span className="m">
          {p.next ? (
            <>
              Next: <em>{p.next.text}</em>
            </>
          ) : p.total > 0 ? (
            "Every step done"
          ) : (
            "No steps yet"
          )}
          {p.total > 0 && ` · ${pct}% · ${p.done} of ${p.total} ${p.total === 1 ? "step" : "steps"}`}
        </span>
        <span className="m2">
          <span className={`status ${look.cls}`}>{look.word}</span>
          {keyDate && <DeadlineChip small>{dateLabel(keyDate)}</DeadlineChip>}
        </span>
      </div>
      <span className={`c-status status ${look.cls}`}>{look.word}</span>
      <span className={`c-date d${nd?.late ? " late" : ""}`}>
        {nd ? (
          <>
            {nd.big}
            {nd.small && <small>{nd.small}</small>}
          </>
        ) : (
          <span className="none">—</span>
        )}
      </span>
      <span className="c-key">
        {keyWhat ? (
          <span title={`${p.key?.text ?? "Deadline"} · ${dateLabel(keyDate!)}`}>
            <DeadlineChip small>
              <span className="kt">{keyWhat}</span>
              <span className="kd">&nbsp;·&nbsp;{keyWhen}</span>
            </DeadlineChip>
          </span>
        ) : (
          <span className="none">—</span>
        )}
      </span>
      <span className="c-who who">
        {people && p.people.length > 0 ? (
          p.people.slice(0, 4).map((x) =>
            x.kind === "company" ? (
              <span key={x.id} title={x.title}>
                <Square name={x.title} small />
              </span>
            ) : (
              <span key={x.id} title={x.title}>
                <Ring name={x.title} small />
              </span>
            ),
          )
        ) : (
          <span className="none">—</span>
        )}
        {people && p.people.length > 4 && <span className="more">+{p.people.length - 4}</span>}
      </span>
      <span className="c-flag">
        {p.flags.length > 0 && (
          <span className="flag" title={p.flags.join("\n")} role="img" aria-label={`Orr noticed: ${p.flags.join(" ")}`}>
            <HeadMark size={16} />
            {p.flags.length}
          </span>
        )}
      </span>
      <span className="c-end">
        {menu.length > 0 && (
          <>
            <button ref={more} type="button" className="ov-act" aria-label={`More for ${p.name}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <Icon name="dots" size={16} />
            </button>
            {menuOpen && <Menu anchor={more} align="end" label={p.name} onClose={() => setMenuOpen(false)} items={menu} />}
          </>
        )}
        <button type="button" className="chev" aria-expanded={open} aria-label={open ? `Fold ${p.name}'s steps` : `Show ${p.name}'s steps`} onClick={onToggle}>
          <Icon name="chev-r" size={16} />
        </button>
      </span>
    </div>
  );
}

const STEP_CAP = 5;

/** An unfolded project's steps: open ones first, done ones sinking, each with its checkbox. */
export function ProjectSteps({
  p,
  canEdit,
  all,
  onAll,
  onCheck,
  onStatus,
  onOpenStep,
  links,
}: {
  p: BoardProject;
  canEdit: boolean;
  all: boolean;
  onAll: () => void;
  onCheck: (t: DashboardTask) => void;
  onStatus: (t: DashboardTask, s: string) => void;
  onOpenStep: (t: DashboardTask) => void;
  /** "Open the project", "Timeline and Gantt": links with their own addresses. */
  links: ReactNode;
}) {
  const sorted = p.tasks.slice().sort(stepOrder);
  const openSteps = sorted.filter((t) => !t.checked);
  const done = sorted.filter((t) => t.checked);
  const shown = all ? sorted : [...openSteps.slice(0, STEP_CAP), ...done.slice(0, openSteps.length < STEP_CAP ? 1 : 0)];
  const hidden = openSteps.length - Math.min(openSteps.length, all ? openSteps.length : STEP_CAP);
  return (
    <div className="steps" role="group" aria-label={`${p.name}, its steps`}>
      {sorted.length === 0 && <p className="none">No steps yet: a checkbox in the note is a step.</p>}
      {shown.map((t) => {
        const due = dueOf(t);
        return (
          <div key={`${t.noteId}:${t.line}`} className={`st${t.checked ? " done" : ""}`}>
            <Checkbox state={taskState(t)} label={t.checked ? `Reopen ${t.text}` : `Complete ${t.text}`} onToggle={canEdit ? () => onCheck(t) : undefined} />
            <button type="button" className="stt pj-open" title={t.text} onClick={() => onOpenStep(t)}>
              {t.text}
              {t.status === "blocked" && !t.checked && <span className="q3"> · blocked</span>}
              {t.key && !t.checked && <DeadlineChip small>Key deadline</DeadlineChip>}
            </button>
            <span className="nt">
              {t.noteId !== p.noteId && (
                <>
                  in <span className="nm">{t.noteTitle}</span>
                </>
              )}
            </span>
            <span className={`dd${due.late ? " late" : ""}`}>{due.text}</span>
            <span className="sta">{canEdit && <StepMenu t={t} onStatus={(s) => onStatus(t, s)} />}</span>
          </div>
        );
      })}
      <div className="sub">
        {hidden > 0 && (
          <button type="button" className="ent-link lk" onClick={onAll}>
            {hidden} more open {hidden === 1 ? "step" : "steps"}
          </button>
        )}
        {links}
        {done.length > 0 && !all && (
          <span className="q3">
            {done.length} done {done.length === 1 ? "step sinks" : "steps sink"} to the bottom
          </span>
        )}
      </div>
    </div>
  );
}
