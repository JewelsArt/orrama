import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DashboardData, type DashboardTask, type Me, type Team } from "./api.js";
import { CharacterAvatar } from "./avatars.js";
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

/** Overview: the project board, split by life-area (Personal / Professional /
 *  Academic). Every step, %, owner is a view over checkboxes in the notes. */
export function Overview({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamSlug, setTeamSlug] = useState<string | null>(localStorage.getItem("basalt-team"));
  const [data, setData] = useState<DashboardData | null>(null);
  const [scope, setScope] = useState<Domain | "all">("all");
  // Projects are open by default (like the mock); this tracks the ones collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
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

  const check = async (noteId: string, line: number, blockId: string | undefined, checked: boolean) => {
    await api("POST", "/api/tasks/check", { noteId, line, blockId, checked });
    if (teamSlug) void load(teamSlug);
  };

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

  const openTasks = projects.reduce((s, p) => s + (p.total - p.done), 0);

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
            {openTasks} open · {projects.length} {projects.length === 1 ? "project" : "projects"}
          </span>
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

        {projects.map((p, pi) => {
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
            <article key={p.project} className="ov-project" style={{ ["--pc" as string]: color }}>
              <button className="ov-project-head" onClick={() => setCollapsed((s) => toggleSet(s, p.project))} aria-expanded={open}>
                <span className="ov-chev" data-open={open}>
                  <IconChevron open={open} />
                </span>
                <span className="ov-pname">{p.project}</span>
                <span className="ov-battery" aria-hidden>
                  <i className="d" style={{ width: `${donePct}%` }} />
                  <i className="w" style={{ width: `${workPct}%` }} />
                </span>
                <span className="ov-pct">{pct}%</span>
                <span className="ov-owners">
                  {(p.assignees.length ? p.assignees : [me.displayName]).slice(0, 3).map((a) => (
                    <span key={a} className="av" title={a} style={{ background: color }}>
                      {a[0]?.toUpperCase()}
                    </span>
                  ))}
                </span>
                <span className="ov-due">{nextDue ? `due ${nextDue.slice(5)}` : "no due date"}</span>
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
              </button>

              {open && gantt.has(p.project) && (
                <div className="ov-steps ov-steps-gantt">
                  {p.tasks.length === 0 ? (
                    <p className="ov-step-empty">No steps yet — add checkboxes to the note.</p>
                  ) : (
                    <Gantt tasks={p.tasks} color={color} onSetDates={setDates} onOpen={onOpenNote} />
                  )}
                </div>
              )}

              {open && !gantt.has(p.project) && (
                <div className="ov-steps">
                  {p.tasks.length === 0 ? (
                    <p className="ov-step-empty">No steps yet — add checkboxes to the note.</p>
                  ) : (
                    <>
                      <div className="ov-steps-head">
                        <span>Status</span>
                        <span>Step</span>
                        <span>Owner</span>
                        <span>Timeline</span>
                        <span>Docs</span>
                      </div>
                      {steps.map((t) => (
                        <Step key={`${t.noteId}:${t.line}`} t={t} color={color} defaultOwner={me.displayName} onCheck={check} onOpen={onOpenNote} />
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

        {data && projects.length === 0 && <p className="empty">No {scope === "all" ? "" : scope} projects here yet.</p>}
      </div>

      <aside className="who" aria-label="Who's working on what">
        <h2>Who's on what</h2>
        {data?.members.map((m) => (
          <div key={m.id} className="who-row">
            <CharacterAvatar id={m.avatar ?? "basalt"} size={28} />
            <div className="who-body">
              <div className="who-name">
                {m.displayName}
                <span className="who-open">{m.openTasks} open</span>
              </div>
              {m.inProgress.map((t, i) => (
                <button key={i} className="who-task now ghost" onClick={() => onOpenNote(t.noteId)}>
                  {t.text}
                </button>
              ))}
              {m.inProgress.length === 0 &&
                m.assigned.slice(0, 2).map((t, i) => (
                  <button key={i} className="who-task ghost" onClick={() => onOpenNote(t.noteId)}>
                    {t.text}
                  </button>
                ))}
              {m.lastEdit && (
                <button className="who-last ghost" onClick={() => onOpenNote(m.lastEdit!.id)}>
                  edited “{m.lastEdit.title}” {ago(m.lastEdit.at)}
                </button>
              )}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

function Step({
  t,
  color,
  defaultOwner,
  onCheck,
  onOpen,
}: {
  t: DashboardTask;
  color: string;
  defaultOwner: string;
  onCheck: (noteId: string, line: number, blockId: string | undefined, checked: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const status = t.checked ? "done" : t.object?.status === "in-progress" ? "work" : "todo";
  const label = status === "done" ? "Done" : status === "work" ? "Working on it" : "To do";
  const owner = t.assignee ?? defaultOwner;
  return (
    <div className="ov-step">
      <button
        className={`st ${status}`}
        onClick={() => onCheck(t.noteId, t.line, t.blockId, !t.checked)}
        title={t.checked ? "Mark not done" : "Mark done"}
      >
        {label}
      </button>
      <span className="ov-step-name" title={t.text}>
        {t.text}
      </span>
      <span className="ov-step-owner">
        <span className="av" style={{ background: color }}>
          {owner[0]?.toUpperCase()}
        </span>
        {owner}
      </span>
      <span className="ov-tl">
        {t.due ? <span className={`ov-tl-pill ${status}`}>{t.due.slice(5)}</span> : <span className="ov-tl-none">—</span>}
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
