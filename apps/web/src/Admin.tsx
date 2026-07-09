import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * Workspace administration (owners only). Access control is spatial: drag a team
 * chip from the palette onto a folder to grant it access; click the chip on the
 * folder to cycle viewer → editor → admin; ✕ revokes. Personal/ never appears —
 * personal space is permissioned by path, not by grants.
 */

interface Overview {
  teams: { id: string; slug: string; name: string; color: string; icon: string; members: string[] }[];
  users: { id: string; username: string; displayName: string; isOwner: boolean }[];
  folders: string[];
  grants: { id: string; teamId: string; folder: string; role: "viewer" | "editor" | "admin" }[];
  projects: { id: string; kind: string; key: string; name: string; teamId: string | null }[];
  invites: { token: string; teamIds: string; expiresAt: number }[];
  ai: { provider: string | null; model: string | null; configured: boolean; instructions: string };
}

const NEXT_ROLE = { viewer: "editor", editor: "admin", admin: "viewer" } as const;
/* Team palette = the vault's graph group colors. */
const COLORS = ["#4a9eff", "#e5383b", "#a855f7", "#2dd4bf", "#f5a623", "#8888aa"];

export function Admin() {
  const [data, setData] = useState<Overview | null>(null);
  const [dragTeam, setDragTeam] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const [inviteTeams, setInviteTeams] = useState<Set<string>>(new Set());
  const [newInvite, setNewInvite] = useState<string | null>(null);
  const [flash, setFlash] = useState("");

  const load = useCallback(async () => setData(await api<Overview>("GET", "/api/admin/overview")), []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await load();
      if (ok) {
        setFlash(ok);
        setTimeout(() => setFlash(""), 2500);
      }
    } catch (e) {
      setFlash(`⚠ ${e instanceof Error ? e.message : "failed"}`);
      setTimeout(() => setFlash(""), 4000);
    }
  };

  if (!data) return <div className="boot">admin</div>;
  const teamById = new Map(data.teams.map((t) => [t.id, t]));

  return (
    <div className="admin">
      <div className="admin-col">
        <section className="admin-card">
          <h2>Teams</h2>
          <p className="admin-hint">Drag a team onto a folder (right) to grant access.</p>
          <div className="team-palette">
            {data.teams.map((t) => (
              <div
                key={t.id}
                className="team-drag"
                draggable
                onDragStart={(e) => {
                  setDragTeam(t.id);
                  e.dataTransfer.setData("text/team", t.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDragEnd={() => {
                  setDragTeam(null);
                  setDropFolder(null);
                }}
                style={{ ["--team" as string]: t.color }}
              >
                <span className="team-dot" /> {t.name}
                <span className="team-drag-count">{t.members.length}</span>
              </div>
            ))}
          </div>
          <form
            className="admin-row"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const name = String(f.get("name") ?? "").trim();
              if (!name) return;
              const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              void act(
                () =>
                  api("POST", "/api/admin/teams", {
                    slug,
                    name,
                    color: COLORS[data.teams.length % COLORS.length],
                  }),
                `team "${name}" created`,
              );
              e.currentTarget.reset();
            }}
          >
            <input name="name" placeholder="New team name…" aria-label="New team name" />
            <button className="primary">Add</button>
          </form>
          <h3>Members</h3>
          {data.teams.map((t) => (
            <div key={t.id} className="member-row">
              <span className="member-team" style={{ ["--team" as string]: t.color }}>
                <span className="team-dot" /> {t.name}
              </span>
              <span className="member-names">
                {t.members.map((uid) => data.users.find((u) => u.id === uid)?.username).filter(Boolean).join(", ") || "—"}
              </span>
              <select
                aria-label={`Add member to ${t.name}`}
                value=""
                onChange={(e) => {
                  const userId = e.target.value;
                  if (userId) void act(() => api("POST", `/api/admin/teams/${t.id}/members`, { userId }), "member added");
                }}
              >
                <option value="">+ add…</option>
                {data.users
                  .filter((u) => !t.members.includes(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}
                    </option>
                  ))}
              </select>
            </div>
          ))}
        </section>

        <section className="admin-card">
          <h2>Invites</h2>
          <div className="invite-teams">
            {data.teams.map((t) => (
              <label key={t.id} className="invite-team">
                <input
                  type="checkbox"
                  checked={inviteTeams.has(t.id)}
                  onChange={(e) => {
                    const next = new Set(inviteTeams);
                    e.target.checked ? next.add(t.id) : next.delete(t.id);
                    setInviteTeams(next);
                  }}
                />
                {t.name}
              </label>
            ))}
            <button
              className="primary"
              disabled={inviteTeams.size === 0}
              onClick={() =>
                act(async () => {
                  const inv = await api<{ token: string }>("POST", "/api/admin/invites", { teamIds: [...inviteTeams] });
                  setNewInvite(inv.token);
                })
              }
            >
              Create invite
            </button>
          </div>
          {newInvite && (
            <p className="invite-link">
              Share this token with the new member: <code>{newInvite}</code>
            </p>
          )}
          {data.invites.length > 0 && <p className="admin-hint">{data.invites.length} unused invite(s) outstanding.</p>}
        </section>

        <section className="admin-card">
          <h2>AI</h2>
          <p className="admin-hint">
            {data.ai.configured
              ? `Configured: ${data.ai.provider} · ${data.ai.model}. Key is encrypted at rest; requests go straight from this server to the provider.`
              : "Bring your own key — nothing is sent anywhere until you add one."}
          </p>
          <form
            className="ai-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(
                () =>
                  api("POST", "/api/admin/ai", {
                    provider: String(f.get("provider")),
                    apiKey: String(f.get("apiKey")),
                    model: String(f.get("model")),
                  }),
                "AI configured",
              );
              e.currentTarget.reset();
            }}
          >
            <select name="provider" defaultValue="anthropic" aria-label="Provider">
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
            <input name="model" placeholder="model, e.g. claude-sonnet-5" defaultValue="claude-sonnet-5" aria-label="Model" />
            <input name="apiKey" type="password" placeholder="API key" aria-label="API key" required />
            <button className="primary">Save</button>
          </form>

          <h3 className="admin-subhead">Agent instructions</h3>
          <p className="admin-hint">
            Teach the agent how to work for you — tone, priorities, habits (“always push me on deadlines”). It’s appended to a
            built-in guide that already covers projects, tasks and the calendar, plus your vault’s CLAUDE.md.
          </p>
          <form
            className="ai-instructions-form"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(() => api("POST", "/api/admin/ai/instructions", { instructions: String(f.get("instructions")) }), "Instructions saved");
            }}
          >
            <textarea
              name="instructions"
              rows={6}
              defaultValue={data.ai.instructions}
              placeholder="e.g. I'm a finance student — be direct and structured. When I share something I built, suggest a LinkedIn angle. Push me on deadlines."
              aria-label="Agent instructions"
            />
            <button className="primary">Save instructions</button>
          </form>
        </section>
      </div>

      <div className="admin-col">
        <section className="admin-card">
          <h2>Folder access</h2>
          <p className="admin-hint">Click a chip to cycle viewer → editor → admin. ✕ revokes on next sync.</p>
          <div className="folder-list">
            {data.folders.map((folder) => {
              const grants = data.grants.filter((g) => g.folder === folder);
              return (
                <div
                  key={folder || "(root)"}
                  className={`folder-row ${dropFolder === folder && dragTeam ? "droppable" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                    setDropFolder(folder);
                  }}
                  onDragLeave={() => setDropFolder((f) => (f === folder ? null : f))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const teamId = e.dataTransfer.getData("text/team") || dragTeam;
                    setDropFolder(null);
                    setDragTeam(null);
                    if (teamId) {
                      const team = teamById.get(teamId);
                      void act(
                        () => api("POST", "/api/admin/grants", { teamId, folder, role: "editor" }),
                        `${team?.name ?? "team"} → ${folder || "vault root"} (editor)`,
                      );
                    }
                  }}
                >
                  <span className="folder-name">
                    <span className="folder-icon">▸</span>
                    {folder === "" ? "/ (vault root)" : folder}
                  </span>
                  <span className="folder-grants">
                    {grants.map((g) => {
                      const team = teamById.get(g.teamId);
                      return (
                        <span key={g.id} className="grant-chip" style={{ ["--team" as string]: team?.color ?? "var(--accent)" }}>
                          <button
                            className="grant-role"
                            title="Click to cycle role"
                            onClick={() =>
                              act(
                                () => api("POST", "/api/admin/grants", { teamId: g.teamId, folder, role: NEXT_ROLE[g.role] }),
                                `${team?.name}: ${NEXT_ROLE[g.role]} on ${folder || "root"}`,
                              )
                            }
                          >
                            {team?.name} · {g.role}
                          </button>
                          <button
                            className="grant-x"
                            title="Revoke"
                            aria-label={`Revoke ${team?.name} from ${folder || "root"}`}
                            onClick={() => act(() => api("DELETE", `/api/admin/grants/${g.id}`), `revoked ${team?.name} from ${folder || "root"}`)}
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })}
                    {grants.length === 0 && <span className="grant-none">no direct grant</span>}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="admin-card">
          <h2>Projects</h2>
          <p className="admin-hint">A folder or tag whose checkboxes become a dashboard progress bar.</p>
          {data.projects.map((p) => (
            <div key={p.id} className="project-def">
              <span className="badge">{p.kind}</span>
              <code>{p.key}</code> → <strong>{p.name}</strong>
              <span className="project-def-team">{p.teamId ? (teamById.get(p.teamId)?.name ?? "?") : "all teams"}</span>
            </div>
          ))}
          <form
            className="admin-row"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const key = String(f.get("key") ?? "").trim();
              const name = String(f.get("pname") ?? "").trim();
              if (!key || !name) return;
              void act(
                () =>
                  api("POST", "/api/admin/projects", {
                    kind: String(f.get("kind")),
                    key,
                    name,
                    teamId: String(f.get("team")) || null,
                  }),
                `project "${name}" created`,
              );
              e.currentTarget.reset();
            }}
          >
            <select name="kind" defaultValue="tag" aria-label="Project kind">
              <option value="tag">tag</option>
              <option value="folder">folder</option>
            </select>
            <input name="key" placeholder="project/atlas or Folder/Path" aria-label="Project key" />
            <input name="pname" placeholder="Display name" aria-label="Project name" />
            <select name="team" defaultValue="" aria-label="Owning team">
              <option value="">all teams</option>
              {data.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className="primary">Add</button>
          </form>
        </section>
      </div>

      {flash && <div className="admin-flash" role="status">{flash}</div>}
    </div>
  );
}
