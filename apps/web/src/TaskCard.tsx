import { useEffect, useState } from "react";
import { Dialog } from "./dialog.js";
import { api } from "./api.js";
import { initials } from "./cards.js";
import type { ProjectWorkspace } from "./Project.js";

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

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const daysTo = (date: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((new Date(`${date}T00:00:00`).getTime() - today) / 86_400_000);
};

const hours = (h: number) => (Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`);

/**
 * One step, in full: what it is, how long it takes, which project it belongs to
 * and when that project is due, who is attached to it, and a date field to put
 * it on the calendar. It exists so a line in the backlog stops being an orphan —
 * the project context it belongs to is one click away, not a different view.
 */
export function TaskCard({
  task,
  onClose,
  onOpenNote,
  onOpenProject,
  onScheduled,
}: {
  task: PlannableTask;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onOpenProject?: (slug: string) => void;
  onScheduled: () => Promise<void> | void;
}) {
  const [project, setProject] = useState<ProjectWorkspace | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [date, setDate] = useState(iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The plan only knows the project's *name*; the workspace is addressed by slug.
  useEffect(() => {
    if (!task.project) return;
    void (async () => {
      const list = await api<{ slug: string; name: string }[]>("GET", "/api/projects");
      const hit = list.find((p) => p.name === task.project);
      if (!hit) return;
      setSlug(hit.slug);
      setProject(await api<ProjectWorkspace>("GET", `/api/projects/${encodeURIComponent(hit.slug)}`));
    })();
  }, [task.project]);

  const schedule = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/tasks/schedule", {
        noteId: task.noteId,
        line: task.line,
        blockId: task.blockId,
        date,
      });
      await onScheduled();
      setDone(`Planned for ${date}`);
    } finally {
      setBusy(false);
    }
  };

  const projectLeft = project?.deadline ? daysTo(project.deadline) : null;
  const taskLeft = task.due ? daysTo(task.due) : null;

  return (
    <div className="ct-backdrop" onClick={onClose}>
      <Dialog label="Task" className="ct-modal task-card">
        <header className="task-head">
          <span className="task-kicker">Step</span>
          <button className="doc-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <h2 className="task-title">{task.text}</h2>
        <p className="task-note">
          in{" "}
          <button className="linkish" onClick={() => onOpenNote(task.noteId)}>
            {task.noteTitle}
          </button>
        </p>

        <div className="task-stats">
          <div>
            <span className="task-k">Estimate</span>
            <b>{hours(task.estimateHours)}</b>
          </div>
          <div>
            <span className="task-k">Planned</span>
            <b>{hours(task.scheduledHours)}</b>
          </div>
          <div>
            <span className="task-k">Left</span>
            <b className={task.remainingHours > 0 ? "" : "ok"}>{hours(task.remainingHours)}</b>
          </div>
          <div>
            <span className="task-k">Due</span>
            <b className={taskLeft !== null && taskLeft < 0 ? "late" : ""}>
              {task.due ? `${task.due}${taskLeft !== null ? ` · ${taskLeft < 0 ? `${-taskLeft}d over` : `${taskLeft}d`}` : ""}` : "—"}
            </b>
          </div>
        </div>

        {task.project && (
          <section className="task-project">
            <div className="task-k">Project</div>
            <div className="task-project-row">
              <button className="task-project-name" onClick={() => slug && onOpenProject?.(slug)} disabled={!slug || !onOpenProject}>
                {task.project}
              </button>
              {project?.status && <span className="task-pill">{project.status}</span>}
              {project?.deadline && (
                <span className={`task-pill ${projectLeft !== null && projectLeft < 0 ? "late" : ""}`}>
                  deadline {project.deadline}
                  {projectLeft !== null && ` · ${projectLeft < 0 ? `${-projectLeft}d over` : `${projectLeft}d left`}`}
                </span>
              )}
            </div>
            {project && project.people.length > 0 && (
              <div className="task-people">
                {project.people.map((p) => (
                  <button key={p.id} className="task-person" onClick={() => onOpenNote(p.id)} title={[p.role, p.company].filter(Boolean).join(" · ")}>
                    <span className="sheet-av sm">{initials(p.title)}</span>
                    {p.title}
                  </button>
                ))}
              </div>
            )}
            {project && project.people.length === 0 && <p className="task-empty">Nobody attached to this project yet.</p>}
          </section>
        )}

        <section className="task-plan">
          <div className="task-k">Put it on a day</div>
          <div className="task-plan-row">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Planned date" />
            <button className="primary" onClick={() => void schedule()} disabled={busy}>
              {busy ? "Planning…" : "Plan it"}
            </button>
          </div>
          {done && <p className="task-done">{done}</p>}
        </section>
      </Dialog>
    </div>
  );
}
