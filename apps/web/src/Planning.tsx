import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "./api.js";
import { CharacterAvatar } from "./avatars.js";
import { onWs } from "./ws.js";

interface PlanData {
  team: { slug: string; name: string; color: string };
  source: "heuristic" | "ai";
  hoursPerDay: number;
  assignees: {
    assignee: string;
    totalHours: number;
    tasks: {
      noteId: string;
      noteTitle: string;
      text: string;
      project: string | null;
      due: string | null;
      priority: number | null;
      estimateHours: number;
      expectedFinish: string;
      atRisk: boolean;
    }[];
  }[];
  atRisk: number;
  totalHours: number;
}

interface Member {
  id: string;
  username: string;
  avatar: string;
  displayName: string;
}

/** Planning: every open task estimated and laid onto a working calendar, so the
 *  team sees who is over water and which deadlines are already lost. */
export function Planning({ me, onOpenNote }: { me: Me; onOpenNote: (id: string) => void }) {
  const [teamSlug, setTeamSlug] = useState<string | null>(me.teams[0]?.slug ?? null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const load = useCallback(async (slug: string) => setPlan(await api<PlanData>("GET", `/api/plan/${slug}`)), []);

  useEffect(() => {
    if (teamSlug) void load(teamSlug);
    api<Member[]>("GET", "/api/members").then(setMembers);
  }, [teamSlug, load]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const off = onWs((msg) => {
      if (msg.type !== "note-changed") return;
      clearTimeout(timer);
      timer = setTimeout(() => teamSlug && load(teamSlug), 500);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [teamSlug, load]);

  const memberFor = (username: string) => members.find((m) => m.username === username);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="planning">
      <header className="view-head">
        <div className="scope-tabs" role="tablist" aria-label="Team">
          {me.teams.map((t) => (
            <button
              key={t.slug}
              role="tab"
              aria-selected={teamSlug === t.slug}
              className={`scope-tab ${teamSlug === t.slug ? "active" : ""}`}
              style={{ "--team": t.color } as React.CSSProperties}
              onClick={() => setTeamSlug(t.slug)}
            >
              <span className="scope-dot" />
              {t.name}
            </button>
          ))}
        </div>
        {plan && (
          <div className="plan-meta">
            <span className="plan-stat">
              <strong>{plan.totalHours}h</strong> planned
            </span>
            {plan.atRisk > 0 && (
              <span className="plan-stat risk">
                <strong>{plan.atRisk}</strong> deadline{plan.atRisk > 1 ? "s" : ""} at risk
              </span>
            )}
            <span className="plan-source" title={`Assuming ${plan.hoursPerDay} focused hours per day`}>
              {plan.source === "ai" ? "AI estimates" : "heuristic estimates"}
            </span>
          </div>
        )}
      </header>

      <div className="plan-lanes">
        {plan?.assignees.map((lane) => {
          const m = memberFor(lane.assignee);
          const days = Math.ceil(lane.totalHours / plan.hoursPerDay);
          return (
            <section key={lane.assignee} className="plan-lane">
              <header className="plan-lane-head">
                {m ? <CharacterAvatar id={m.avatar} size={26} /> : <span className="avatar sm">?</span>}
                <span className="plan-lane-name">{m?.displayName ?? lane.assignee}</span>
                <span className="plan-lane-load">
                  {lane.totalHours}h · ~{days} day{days !== 1 ? "s" : ""}
                </span>
              </header>
              <ul className="plan-tasks">
                {lane.tasks.map((t, i) => (
                  <li key={`${t.noteId}:${i}`} className={`plan-task ${t.atRisk ? "risk" : ""}`}>
                    <span className="plan-est">{t.estimateHours}h</span>
                    <span className="plan-text">{t.text}</span>
                    {t.project && <span className="plan-project">{t.project}</span>}
                    <span className="plan-dates">
                      <span className="plan-finish" title="Expected finish, given the queue before it">
                        → {t.expectedFinish.slice(5)}
                      </span>
                      {t.due && (
                        <span className={`plan-due ${t.atRisk ? "risk" : t.due < today ? "risk" : ""}`} title="Deadline">
                          due {t.due.slice(5)}
                        </span>
                      )}
                    </span>
                    <button className="ghost plan-open" onClick={() => onOpenNote(t.noteId)} title={t.noteTitle}>
                      open
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
        {plan && plan.assignees.length === 0 && (
          <p className="empty">No open project tasks for this team — either done, or nothing is assigned to a project yet.</p>
        )}
      </div>
      <p className="plan-footnote">
        Estimates schedule each person's queue earliest-deadline-first at {plan?.hoursPerDay ?? 6} focused hours/day, skipping
        weekends. {plan?.source === "heuristic" && "Add an AI key in Admin for model-refined estimates."}
      </p>
    </div>
  );
}
