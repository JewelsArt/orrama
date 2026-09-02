import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DashboardData, type DashboardTask, type Me, type Team } from "./api.js";
import { CharacterAvatar } from "./avatars.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { Gantt } from "./Gantt.js";
import { IconChevron } from "./icons.js";
import { onWs } from "./ws.js";

type Domain = "personal" | "professional" | "academic";
const DOMAINS: { id: Domain; label: string; color: string }[] = [
  { id: "personal", label: "Personal", color: "#57c99b" },
  { id: "professional", label: "Professional", color: "#6fabec" },
  { id: "academic", label: "Academic", color: "#b587e8" },
];
const STEP_CAP = 12;

/**
 * Front-matter `status:` values that park a project. Several spellings each,
 * because the note is hand-editable and "paused" and "on hold" mean the same
 * thing to a person.
 */
const SLEEP_STATES = new Set(["sleeping", "asleep", "paused", "on-hold", "on hold", "someday"]);
const CANCEL_STATES = new Set(["cancelled", "canceled", "dropped", "abandoned"]);

type TaskStatus = "todo" | "in-progress" | "blocked" | "done";
/** Order matters: this is how the dropdown lists them. `cls` maps to the .st.* colours. */
const STATUS_OPTS: { id: TaskStatus; label: string; cls: string }[] = [
  { id: "in-progress", label: "Working on it", cls: "work" },
  { id: "todo", label: "To do", cls: "todo" },
  { id: "blocked", label: "Blocked", cls: "blocked" },
  { id: "done", label: "Done", cls: "done" },
];
const statusOf = (t: DashboardTask): TaskStatus =>
  t.checked ? "done" : t.object?.status === "in-progress" ? "in-progress" : t.object?.status === "blocked" ? "blocked" : "todo";

/** Overview: the project board, split by life-area (Personal / Professional /
 *  Academic). Every step, %, owner is a view over checkboxes in the notes. */
export function Overview({
  me,
  onOpenNote,
  onOpenProject,
}: {
  me: Me;
  onOpenNote: (id: string) => void;
  onOpenProject: (slug: string) => void;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamSlug, setTeamSlug] = useState<string | null>(localStorage.getItem("basalt-team"));
  const [data, setData] = useState<DashboardData | null>(null);
  const [scope, setScope] = useState<Domain | "all">("all");
  // Projects are open by default (like the mock); this tracks the ones collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  // Anything not being worked on folds away: finished, sleeping, or dropped.
  const [shelf, setShelf] = useState<"active" | "sleeping" | "cancelled" | "completed">("active");
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  // Projects flipped to the Gantt view; persisted so the board reopens the way you left it.
  const [gantt, setGantt] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("basalt-gantt") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleGantt = (project: string) =>
    setGantt((s) => {
      const next = toggleSet(s, project);
      localStorage.setItem("basalt-gantt", JSON.stringify([...next]));
      return next;
    });
  const [digest, setDigest] = useState<{ configured: boolean; text?: string; loading?: boolean } | null>(null);

  const load = useCallback(async (slug: string) => {
    setData(await api<DashboardData>("GET", `/api/dashboard/${slug}`));
  }, []);

  useEffect(() => {
    api<Team[]>("GET", "/api/teams").then((ts) => {
      setTeams(ts);
      const slug = ts.some((t) => t.slug === teamSlug) ? teamSlug! : ts[0]?.slug;
      if (slug) {
        setTeamSlug(slug);
        localStorage.setItem("basalt-team", slug);
        void load(slug);
      }
    });
    api<{ configured: boolean }>("GET", "/api/ai/status").then((s) => setDigest({ configured: s.configured }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teamSlugRef = useRef(teamSlug);
  teamSlugRef.current = teamSlug;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (teamSlugRef.current) void load(teamSlugRef.current);
      }, 400);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [load]);

  const setStatus = async (t: DashboardTask, status: TaskStatus) => {
    await api("POST", "/api/tasks/status", { noteId: t.noteId, line: t.line, blockId: t.blockId, status });
    if (teamSlug) void load(teamSlug);
  };

  // Owners can unregister a project (removes the board mapping; the note stays).
  const removeProject = (id: string, name: string) =>
    setConfirm({
      title: `Remove “${name}” from the board?`,
      body: "The note and its tag stay — it just stops being tracked as a project.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        await api("DELETE", `/api/admin/projects/${id}`);
        if (teamSlug) void load(teamSlug);
      },
    });

  // Gantt drag/resize/schedule → start:/due: tokens on the task line (file is the truth).
  const setDates = async (t: DashboardTask, dates: { start?: string | null; due?: string | null }) => {
    await api("POST", "/api/tasks/dates", { noteId: t.noteId, line: t.line, blockId: t.blockId, ...dates });
    if (teamSlug) void load(teamSlug);
  };

  const generateDigest = async () => {
    if (!teamSlug) return;
    setDigest((d) => ({ ...(d ?? { configured: true }), loading: true }));
    try {
      const res = await api<{ digest: string }>("POST", `/api/ai/digest/${teamSlug}`);
      setDigest({ configured: true, text: res.digest });
    } catch (e) {
      setDigest({ configured: true, text: e instanceof Error ? e.message : "digest failed" });
    }
  };

  const projects = useMemo(
    () => (data?.projects ?? []).filter((p) => scope === "all" || p.domain === scope),
    [data, scope],
  );
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: data?.projects.length ?? 0, personal: 0, professional: 0, academic: 0 };
    for (const p of data?.projects ?? []) if (p.domain) m[p.domain] = (m[p.domain] ?? 0) + 1;
    return m;
  }, [data]);

  /**
   * Where a project sits. `status:` in the note wins — a sleeping project stays
   * asleep even with steps left, a cancelled one never comes back on its own —
   * and otherwise "complete" means every step is ticked (0-step projects never
   * count as done).
   */
  const sleeping = useMemo(() => projects.filter((p) => SLEEP_STATES.has(p.status)), [projects]);
  const cancelled = useMemo(() => projects.filter((p) => CANCEL_STATES.has(p.status)), [projects]);
  const parked = new Set([...sleeping, ...cancelled].map((p) => p.project));
  const activeProjects = useMemo(
    () => projects.filter((p) => !parked.has(p.project) && !(p.total > 0 && p.done === p.total)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, sleeping, cancelled],
  );
  const completedProjects = useMemo(
    () => projects.filter((p) => !parked.has(p.project) && p.total > 0 && p.done === p.total),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, sleeping, cancelled],
  );
  const shown = shelf === "completed" ? completedProjects : shelf === "sleeping" ? sleeping : shelf === "cancelled" ? cancelled : activeProjects;
  const openTasks = activeProjects.reduce((s, p) => s + (p.total - p.done), 0);

  /** Sleep / cancel / wake — one front-matter field, written to the note. */
  const setLifecycle = async (p: { slug: string | null; project: string }, status: string) => {
    if (!p.slug) return;
    await api("PATCH", `/api/projects/${encodeURIComponent(p.slug)}`, { status });
    if (teamSlug) void load(teamSlug);
  };

  return (
    <div className="overview">
      <div className="board">
        <header className="ov-top">
          <h1 className="ov-h1">Overview</h1>
          <p className="ov-sub">Where every project stands, generated from your notes.</p>
        </header>

        <div className="ov-bar">
          <span className="ov-bar-lbl">Area</span>
          <div className="seg" role="tablist" aria-label="Life area">
            <button role="tab" aria-selected={scope === "all"} className={`seg-btn ${scope === "all" ? "active" : ""}`} onClick={() => setScope("all")}>
              All
            </button>
            {DOMAINS.map((d) => (
              <button
                key={d.id}
                role="tab"
                aria-selected={scope === d.id}
                className={`seg-btn ${scope === d.id ? "active" : ""}`}
                onClick={() => setScope(d.id)}
              >
                <span className="dot" style={{ background: d.color }} />
                {d.label}
                <span className="seg-count">{counts[d.id]}</span>
              </button>
            ))}
          </div>
          <span className="ov-bar-meta">
            {shelf === "active"
              ? `${openTasks} open · ${activeProjects.length} ${activeProjects.length === 1 ? "project" : "projects"}`
              : `${shown.length} ${shelf}`}
          </span>
          <div className="ov-shelves">
            {/* Every shelf is reachable from every shelf — no going home first. */}
            {shelf !== "active" && (
              <button className="ov-completed-tab on" onClick={() => setShelf("active")}>
                ‹ Active projects
              </button>
            )}
            {shelf !== "sleeping" && sleeping.length > 0 && (
              <button className="ov-completed-tab" onClick={() => setShelf("sleeping")}>
                Sleeping · {sleeping.length}
              </button>
            )}
            {shelf !== "cancelled" && cancelled.length > 0 && (
              <button className="ov-completed-tab" onClick={() => setShelf("cancelled")}>
                Cancelled · {cancelled.length}
              </button>
            )}
            {shelf !== "completed" && completedProjects.length > 0 && (
              <button className="ov-completed-tab" onClick={() => setShelf("completed")}>
                Completed · {completedProjects.length}
              </button>
            )}
          </div>
        </div>

        {digest && digest.configured && (
          <div className="ov-digest" role="note">
            <span className="ov-digest-ic" aria-hidden>
              ✦
            </span>
            {digest.text ? (
              <p>
                <span className="ov-ai-tag">AI summary</span> {digest.text}
              </p>
            ) : (
              <button className="ghost" onClick={generateDigest} disabled={digest.loading}>
                {digest.loading ? "Generating digest…" : "Generate today's summary"}
              </button>
            )}
          </div>
        )}

        {shown.map((p, pi) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          const open = !collapsed.has(p.project);
          const color = DOMAIN_COLOR[p.domain ?? "personal"] ?? PROJECT_COLORS[pi % PROJECT_COLORS.length] ?? "#6fabec";
          const inProgress = p.tasks.filter((t) => !t.checked && t.object?.status === "in-progress").length;
          const donePct = p.total ? (p.done / p.total) * 100 : 0;
          const workPct = p.total ? (inProgress / p.total) * 100 : 0;
          const all = showAll.has(p.project);
          const steps = all ? p.tasks : p.tasks.slice(0, STEP_CAP);
          const nextDue = p.tasks.map((t) => t.due).filter(Boolean).sort()[0];
          return (
            <article
              key={p.project}
              className={`ov-project ${parked.has(p.project) ? "parked" : ""}`}
              style={{ ["--pc" as string]: color }}
            >
              <button className="ov-project-head" onClick={() => setCollapsed((s) => toggleSet(s, p.project))} aria-expanded={open}>
                <span className="ov-chev" data-open={open}>
                  <IconChevron open={open} />
                </span>
                <span
                  className="ov-pname link"
                  role="link"
                  tabIndex={0}
                  title="Open the project workspace"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (p.slug) onOpenProject(p.slug);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && p.slug) {
                      e.preventDefault();
                      e.stopPropagation();
                      onOpenProject(p.slug);
                    }
                  }}
                >
                  {p.project}
                </span>
                <span className="ov-battery" aria-hidden>
                  <i className="d" style={{ width: `${donePct}%` }} />
                  <i className="w" style={{ width: `${workPct}%` }} />
                </span>
                <span className="ov-pct">{pct}%</span>
                {parked.has(p.project) ? (
                  <span className="ov-state">{SLEEP_STATES.has(p.status) ? "sleeping" : "cancelled"}</span>
                ) : (
                  <span className="ov-due">{nextDue ? `due ${nextDue.slice(5)}` : "no due date"}</span>
                )}
                <span
                  className={`ov-gantt-sw ${gantt.has(p.project) ? "on" : ""}`}
                  role="switch"
                  aria-checked={gantt.has(p.project)}
                  aria-label="Gantt view"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGantt(p.project);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleGantt(p.project);
                    }
                  }}
                >
                  <i aria-hidden />
                  Gantt
                </span>
                <span
                  className="ov-life"
                  role="group"
                  aria-label="Project lifecycle"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {parked.has(p.project) ? (
                    <>
                      <button className="ov-life-btn" title="Put it back on the active board" onClick={() => void setLifecycle(p, "on-track")}>
                        Wake
                      </button>
                      {SLEEP_STATES.has(p.status) && (
                        <button
                          className="ov-life-btn danger"
                          title="Stop the project — the note and its history stay"
                          onClick={() =>
                            setConfirm({
                              title: `Cancel “${p.project}”?`,
                              body: "It moves to the Cancelled shelf. Everything in the note stays.",
                              confirmLabel: "Cancel the project",
                              danger: true,
                              onConfirm: () => void setLifecycle(p, "cancelled"),
                            })
                          }
                        >
                          Cancel
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      <button className="ov-life-btn" title="Not this month's problem — keep it, hide it" onClick={() => void setLifecycle(p, "sleeping")}>
                        Sleep
                      </button>
                      <button
                        className="ov-life-btn danger"
                        title="Stop the project — the note and its history stay"
                        onClick={() =>
                          setConfirm({
                            title: `Cancel “${p.project}”?`,
                            body: "It moves to the Cancelled shelf. The note, its steps, its documents and its history stay exactly as they are — you can bring it back any time.",
                            confirmLabel: "Cancel the project",
                            danger: true,
                            onConfirm: () => void setLifecycle(p, "cancelled"),
                          })
                        }
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </span>
              </button>

              {open && gantt.has(p.project) && (
                <div className="ov-steps ov-steps-gantt">
                  {p.tasks.length === 0 ? (
                    <p className="ov-step-empty">
                    No steps yet — add checkboxes to the note.
                    {me.isOwner && p.projectId && (
                      <button className="ov-remove" onClick={() => removeProject(p.projectId!, p.project)}>
                        Remove from board
                      </button>
                    )}
                  </p>
                  ) : (
                    <Gantt tasks={p.tasks} color={color} onSetDates={setDates} onOpen={onOpenNote} />
                  )}
                </div>
              )}

              {open && !gantt.has(p.project) && (
                <div className="ov-steps">
                  {p.tasks.length === 0 ? (
                    <p className="ov-step-empty">
                    No steps yet — add checkboxes to the note.
                    {me.isOwner && p.projectId && (
                      <button className="ov-remove" onClick={() => removeProject(p.projectId!, p.project)}>
                        Remove from board
                      </button>
                    )}
                  </p>
                  ) : (
                    <>
                      <div className="ov-steps-head">
                        <span>Status</span>
                        <span>Step</span>
                        <span>Timeline</span>
                        <span>Note</span>
                      </div>
                      {steps.map((t) => (
                        <Step key={`${t.noteId}:${t.line}`} t={t} onStatus={setStatus} onOpen={onOpenNote} />
                      ))}
                      {!all && p.tasks.length > STEP_CAP && (
                        <button className="ov-more" onClick={() => setShowAll((s) => toggleSet(s, p.project))}>
                          + {p.tasks.length - STEP_CAP} more steps
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {data && shown.length === 0 && (
          <p className="empty">
            {shelf === "completed"
              ? "No completed projects yet — finish every step in a project and it lands here."
              : shelf === "sleeping"
                ? "Nothing asleep. Park a project here when it is not this month's problem."
                : shelf === "cancelled"
                  ? "Nothing cancelled."
                  : `No ${scope === "all" ? "" : scope} projects here yet.`}
          </p>
        )}
      </div>

      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function Step({
  t,
  onStatus,
  onOpen,
}: {
  t: DashboardTask;
  onStatus: (t: DashboardTask, status: TaskStatus) => void;
  onOpen: (id: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const status = statusOf(t);
  const cur = STATUS_OPTS.find((s) => s.id === status)!;

  // Close the dropdown on any click outside it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  return (
    <div className={`ov-step ${status === "done" ? "is-done" : ""}`}>
      <div className="st-wrap" ref={ref}>
        <button className={`st ${cur.cls}`} onClick={() => setMenu((m) => !m)} aria-haspopup="listbox" aria-expanded={menu}>
          {cur.label}
          <span className="st-caret" aria-hidden>
            ▾
          </span>
        </button>
        {menu && (
          <div className="st-menu" role="listbox">
            {STATUS_OPTS.map((s) => (
              <button
                key={s.id}
                role="option"
                aria-selected={s.id === status}
                className={`st-opt ${s.id === status ? "sel" : ""}`}
                onClick={() => {
                  setMenu(false);
                  if (s.id !== status) onStatus(t, s.id);
                }}
              >
                <span className={`st-dot ${s.cls}`} />
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="ov-step-name" title={t.text}>
        {t.text}
      </span>
      <span className="ov-tl">
        {t.due ? <span className={`ov-tl-pill ${cur.cls}`}>{t.due.slice(5)}</span> : <span className="ov-tl-none">—</span>}
      </span>
      <button className="ov-docs" onClick={() => onOpen(t.noteId)} title={t.notePath}>
        {t.noteTitle}
      </button>
    </div>
  );
}

const DOMAIN_COLOR: Record<string, string> = { personal: "#57c99b", professional: "#6fabec", academic: "#b587e8" };
const PROJECT_COLORS = ["#6fabec", "#b587e8", "#e284a6", "#57c99b", "#e2a662", "#7ea6ff"];

function toggleSet(s: Set<string>, key: string): Set<string> {
  const next = new Set(s);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
