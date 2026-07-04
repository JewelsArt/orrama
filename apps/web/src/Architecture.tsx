import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Me, type NoteDetail, type TreeNote } from "./api.js";
import { Editor } from "./Editor.js";
import { FileTree } from "./FileTree.js";
import { GraphCanvas, type GraphData } from "./GraphCanvas.js";
import { IconLock, IconPlus, IconPromote } from "./icons.js";
import { onWs, sendEditing } from "./ws.js";

type Scope = { kind: "all" } | { kind: "team"; slug: string; name: string } | { kind: "personal" };

function inScope(note: TreeNote, scope: Scope, username: string): boolean {
  const top = note.path.split("/")[0] ?? "";
  if (scope.kind === "all") return !note.path.startsWith("Personal/") || note.path.startsWith(`Personal/${username}`);
  if (scope.kind === "personal") return note.path.startsWith(`Personal/${username}`);
  // team scope: top-level folder named like the team, or note tagged with the team slug
  return top.toLowerCase() === scope.name.toLowerCase() || top.toLowerCase() === scope.slug || note.tags.includes(scope.slug);
}

/** Architecture: the vault's shape. Files grouped by folder, scoped All / team /
 *  personal, with the link graph glowing faintly behind — structure you can feel. */
export function Architecture({ me, noteId }: { me: Me; noteId?: string }) {
  const [tree, setTree] = useState<TreeNote[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [open, setOpen] = useState<NoteDetail | null>(null);
  const [related, setRelated] = useState<{ id: string; title: string; score: number }[]>([]);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [editingBy, setEditingBy] = useState<{ username: string; at: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openRef = useRef<NoteDetail | null>(null);
  openRef.current = open;

  const loadTree = useCallback(async () => {
    setTree(await api<TreeNote[]>("GET", "/api/vault/tree"));
    setGraph(await api<GraphData>("GET", "/api/vault/graph"));
  }, []);

  const openNote = useCallback(async (id: string) => {
    const note = await api<NoteDetail>("GET", `/api/vault/note/${id}`);
    setOpen(note);
    setStatus("saved");
    api<{ id: string; title: string; score: number }[]>("GET", `/api/vault/note/${id}/related`).then(setRelated);
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  useEffect(() => {
    if (noteId) void openNote(noteId);
  }, [noteId, openNote]);

  useEffect(() => {
    const off = onWs((msg) => {
      if (msg.type === "note-changed") {
        void loadTree();
        const current = openRef.current;
        if (current && msg.noteId === current.id && msg.authorId !== me.id) void openNote(current.id);
      } else if (msg.type === "presence") {
        const current = openRef.current;
        if (current && msg.noteId === current.id) setEditingBy({ username: msg.username, at: msg.at });
      }
    });
    const expire = setInterval(() => setEditingBy((e) => (e && Date.now() - e.at > 6000 ? null : e)), 2000);
    return () => {
      off();
      clearInterval(expire);
    };
  }, [loadTree, openNote, me.id]);

  const save = useCallback(
    (content: string) => {
      const note = openRef.current;
      if (!note || content === note.content) return;
      sendEditing(note.id);
      setStatus("saving");
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const res = await api<{ id: string }>("PUT", "/api/vault/note", { path: note.path, content, baseHash: note.hash });
          const fresh = await api<NoteDetail>("GET", `/api/vault/note/${res.id}`);
          setOpen(fresh);
          setStatus("saved");
          void loadTree();
        } catch {
          setStatus("error");
        }
      }, 600);
    },
    [loadTree],
  );

  const createNote = async () => {
    const suggestion =
      scope.kind === "personal" ? `Personal/${me.username}/` : scope.kind === "team" ? `${scope.name}/` : "";
    const name = prompt("Note path:", suggestion);
    if (!name || name.endsWith("/")) return;
    const path = name.endsWith(".md") ? name : `${name}.md`;
    try {
      const res = await api<{ id: string }>("PUT", "/api/vault/note", {
        path,
        content: `---\ntitle: ${path.split("/").pop()!.replace(/\.md$/, "")}\n---\n\n`,
      });
      await loadTree();
      await openNote(res.id);
    } catch (e) {
      alert(e instanceof Error ? e.message : "failed");
    }
  };

  const checkTask = async (line: number, checked: boolean) => {
    if (!open) return;
    await api("POST", "/api/tasks/check", { noteId: open.id, line, checked });
    await openNote(open.id);
  };

  const promote = async (line: number) => {
    if (!open) return;
    await api("POST", "/api/tasks/promote", { noteId: open.id, line });
    await openNote(open.id);
  };

  const scoped = useMemo(() => tree.filter((n) => inScope(n, scope, me.username)), [tree, scope, me.username]);
  const scopedIds = useMemo(() => new Set(scoped.map((n) => n.id)), [scoped]);

  const completions = useMemo(
    () => ({
      titles: tree.map((n) => n.title),
      users: [me.username],
      tags: [...new Set(tree.flatMap((n) => n.tags))],
    }),
    [tree, me.username],
  );

  const scopes: Scope[] = [
    { kind: "all" },
    ...me.teams.map((t) => ({ kind: "team" as const, slug: t.slug, name: t.name })),
    { kind: "personal" },
  ];

  return (
    <div className="arch">
      <aside className="arch-files">
        <div className="scope-tabs" role="tablist" aria-label="Scope">
          {scopes.map((s) => {
            const key = s.kind === "team" ? s.slug : s.kind;
            const label = s.kind === "all" ? "All" : s.kind === "personal" ? "Personal" : s.name;
            const active = JSON.stringify(s) === JSON.stringify(scope);
            const color = s.kind === "team" ? me.teams.find((t) => t.slug === s.slug)?.color : undefined;
            return (
              <button
                key={key}
                role="tab"
                aria-selected={active}
                className={`scope-tab ${active ? "active" : ""}`}
                style={color ? ({ "--team": color } as React.CSSProperties) : undefined}
                onClick={() => setScope(s)}
              >
                {s.kind === "team" && <span className="scope-dot" />}
                {label}
              </button>
            );
          })}
          <button className="ghost scope-new" onClick={createNote} title="New note" aria-label="New note">
            <IconPlus />
          </button>
        </div>
        <FileTree notes={scoped} activeId={open?.id ?? null} onOpen={openNote} />
        {open && (
          <button className="ft-map ghost" onClick={() => setOpen(null)}>
            ← Back to the map
          </button>
        )}
      </aside>

      <section className="editor-pane">
        {open ? (
          <>
            <header className="editor-head">
              <div>
                <h1 className="editor-title">{open.title}</h1>
                <span className="editor-path">{open.path}</span>
              </div>
              <span className="editor-presence">
                {editingBy && <span className="presence-badge">{editingBy.username} is editing</span>}
                <span className={`save-state ${status}`}>
                  {open.canEdit ? (status === "saved" ? "saved" : status === "saving" ? "saving…" : "save failed") : "read-only"}
                </span>
              </span>
            </header>
            <Editor
              noteId={open.id}
              content={open.content}
              readOnly={!open.canEdit}
              completions={completions}
              onChange={save}
              onFollowLink={(title) => {
                const target = tree.find((n) => n.title.toLowerCase() === title.toLowerCase());
                if (target) void openNote(target.id);
              }}
            />
          </>
        ) : (
          <div className="map-stage">
            <GraphCanvas graph={graph} visibleIds={scopedIds} onOpen={openNote} />
            <span className="map-hint">
              {scoped.length} notes · click a node to open · <kbd>⌘K</kbd> search · <kbd>c</kbd> capture
            </span>
          </div>
        )}
      </section>

      {open && (
        <aside className="side" aria-label="Note context">
          {open.tasks.length > 0 && (
            <section>
              <h3>Tasks</h3>
              <ul className="side-tasks">
                {open.tasks.map((t) => (
                  <li key={t.line}>
                    <input type="checkbox" checked={t.checked} onChange={(e) => checkTask(t.line, e.target.checked)} aria-label={t.text} />
                    <span>{t.text}</span>
                    {t.blockId ? (
                      <span className="promoted-mark" title="Promoted task">
                        <IconPromote />
                      </span>
                    ) : (
                      open.canEdit && (
                        <button className="ghost promote" title="Promote to task object" onClick={() => promote(t.line)}>
                          <IconPromote />
                        </button>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h3>Backlinks</h3>
            {open.backlinks.length === 0 && <p className="empty">No backlinks yet</p>}
            {open.backlinks.map((b, i) => (
              <button key={i} className="side-link ghost" onClick={() => openNote(b.fromId)}>
                <span className="side-link-title">{b.fromTitle}</span>
                <span className="side-link-ctx">{b.context}</span>
              </button>
            ))}
          </section>
          <section>
            <h3>Links here</h3>
            {open.links.length === 0 && <p className="empty">No outgoing links</p>}
            {open.links.map((l, i) =>
              l.locked ? (
                <span key={i} className="side-link locked" title="You don't have access to this note">
                  <IconLock /> {l.alias ?? l.target}
                </span>
              ) : (
                <button key={i} className="side-link ghost" disabled={!l.targetId} onClick={() => l.targetId && openNote(l.targetId)}>
                  {l.alias ?? l.target}
                  {!l.targetId && <span className="side-link-ctx">not created yet</span>}
                </button>
              ),
            )}
          </section>
          {related.length > 0 && (
            <section>
              <h3>Possibly related</h3>
              {related.map((r) => (
                <button key={r.id} className="side-link ghost" onClick={() => openNote(r.id)}>
                  {r.title}
                </button>
              ))}
            </section>
          )}
          {open.tags.length > 0 && (
            <section>
              <h3>Tags</h3>
              <div className="side-tags">
                {[...new Set(open.tags.map((t) => t.tag))].map((t) => (
                  <span key={t} className="tag-chip">
                    #{t}
                  </span>
                ))}
              </div>
            </section>
          )}
        </aside>
      )}
    </div>
  );
}
