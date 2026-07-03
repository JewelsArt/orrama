import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type DashboardData, type Me, type Team } from "./api.js";
import { CharacterAvatar } from "./avatars.js";
import { IconChevron } from "./icons.js";
import { onWs } from "./ws.js";

/** Overview: the team board. What are we doing, how far along, who's on what —
 *  every number computed from checkboxes in the notes, checkable right here. */
export function Overview({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamSlug, setTeamSlug] = useState<string | null>(localStorage.getItem("basalt-team"));
  const [data, setData] = useState<(DashboardData & { members: (DashboardData["members"][number] & { avatar?: string })[] }) | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  const pickTeam = (slug: string) => {
    setTeamSlug(slug);
    localStorage.setItem("basalt-team", slug);
    setData(null);
    void load(slug);
  };

  const check = async (noteId: string, line: number, blockId: string | undefined, checked: boolean) => {
    await api("POST", "/api/tasks/check", { noteId, line, blockId, checked });
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

  const team = useMemo(() => teams.find((t) => t.slug === teamSlug), [teams, teamSlug]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="overview" style={team ? ({ "--team": team.color } as React.CSSProperties) : undefined}>
      <div className="board">
        <header className="view-head">
          <div className="scope-tabs" role="tablist" aria-label="Team">
            {teams.map((t) => {
              const pct = t.total ? Math.round(((t.done ?? 0) / t.total) * 100) : 0;
              return (
                <button
                  key={t.slug}
                  role="tab"
                  aria-selected={t.slug === teamSlug}
                  className={`scope-tab ${t.slug === teamSlug ? "active" : ""}`}
                  style={{ "--team": t.color } as React.CSSProperties}
                  onClick={() => pickTeam(t.slug)}
                >
                  <span className="scope-dot" />
                  {t.name}
                  <span className="scope-pct">{pct}%</span>
                </button>
              );
            })}
          </div>
          <span className="board-sub">
            {data ? `${data.projects.reduce((s, p) => s + (p.total - p.done), 0)} open tasks · ${data.members.length} members` : "…"}
          </span>
        </header>

        {digest && digest.configured && (
          <div className="digest" role="note">
            {digest.text ? (
              <p>{digest.text}</p>
            ) : (
              <button className="ghost" onClick={generateDigest} disabled={digest.loading}>
                {digest.loading ? "Generating digest…" : "Generate today's digest"}
              </button>
            )}
          </div>
        )}

        {data?.projects.map((p) => {
          const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
          const open = expanded.has(p.project);
          return (
            <article key={p.project} className="project">
              <button className="project-row" onClick={() => setExpanded((s) => toggleSet(s, p.project))} aria-expanded={open}>
                <IconChevron open={open} />
                <span className="project-name">{p.project}</span>
                <span className="project-count">
                  {p.done}/{p.total}
                </span>
                <span className="progress-track" aria-hidden>
                  <span className="progress-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="project-avatars">
                  {p.assignees.slice(0, 4).map((a) => (
                    <span key={a} className="avatar sm" title={a}>
                      {a[0]}
                    </span>
                  ))}
                </span>
                {p.lastActivityMs ? <span className="project-when">{ago(p.lastActivityMs)}</span> : null}
              </button>
              {open && (
                <ul className="task-list">
                  {p.tasks.length === 0 && <li className="empty">All done here.</li>}
                  {p.tasks.map((t) => (
                    <li key={`${t.noteId}:${t.line}`} className="task">
                      <input
                        type="checkbox"
                        checked={t.checked}
                        onChange={(e) => check(t.noteId, t.line, t.blockId, e.target.checked)}
                        aria-label={t.text}
                      />
                      <span className="task-text">{t.text}</span>
                      {t.object?.status === "in-progress" && <span className="badge progress-badge">in progress</span>}
                      {t.priority && <span className={`badge p${t.priority}`}>p{t.priority}</span>}
                      {t.due && <span className={`badge due ${t.due < today ? "overdue" : ""}`}>{t.due.slice(5)}</span>}
                      {t.assignee && (
                        <span className="avatar sm" title={t.assignee}>
                          {t.assignee[0]}
                        </span>
                      )}
                      <button className="task-note ghost" onClick={() => onOpenNote(t.noteId)} title={t.notePath}>
                        {t.noteTitle}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}

        {data && data.orphaned.length > 0 && (
          <div className="orphaned" role="note">
            {data.orphaned.length} promoted task{data.orphaned.length > 1 ? "s" : ""} lost their checkbox line — open the note to
            triage.
          </div>
        )}
        {data && data.projects.length === 0 && <p className="empty">No projects yet — an owner can mark a folder or tag as a project.</p>}
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
