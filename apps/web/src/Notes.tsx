import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Me, type NoteDetail, type TreeNote } from "./api.js";
import { Editor } from "./Editor.js";

/** Notes workspace: permission-filtered tree · editor · backlinks/tags/related panel (spec §8). */
export function Notes({ me, noteId }: { me: Me; noteId?: string }) {
  const [tree, setTree] = useState<TreeNote[]>([]);
  const [open, setOpen] = useState<NoteDetail | null>(null);
  const [related, setRelated] = useState<{ id: string; title: string; score: number }[]>([]);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const openRef = useRef<NoteDetail | null>(null);
  openRef.current = open;

  const loadTree = useCallback(async () => setTree(await api<TreeNote[]>("GET", "/api/vault/tree")), []);

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

  const save = useCallback(
    (content: string) => {
      const note = openRef.current;
      if (!note || content === note.content) return;
      setStatus("saving");
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          const res = await api<{ id: string; hash: string; content: string }>("PUT", "/api/vault/note", {
            path: note.path,
            content,
            baseHash: note.hash,
          });
          // Refresh metadata (links/tags/tasks) without stealing the caret.
          const fresh = await api<NoteDetail>("GET", `/api/vault/note/${res.id}`);
          setOpen(fresh);
          setStatus("saved");
          void loadTree();
        } catch (e) {
          setStatus("error");
        }
      }, 600);
    },
    [loadTree],
  );

  const createNote = async () => {
    const name = prompt("Note path (e.g. Engineering/New Idea.md):");
    if (!name) return;
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

  const folders = useMemo(() => {
    const map = new Map<string, TreeNote[]>();
    for (const n of tree) {
      const list = map.get(n.folder) ?? [];
      list.push(n);
      map.set(n.folder, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tree]);

  const completions = useMemo(
    () => ({
      titles: tree.map((n) => n.title),
      users: [me.username, ...new Set(tree.flatMap(() => []))],
      tags: [...new Set(tree.flatMap((n) => n.tags))],
    }),
    [tree, me.username],
  );

  return (
    <div className="notes">
      <aside className="tree" aria-label="Files">
        <div className="tree-head">
          <span>Vault</span>
          <button className="ghost" onClick={createNote} title="New note">
            ＋
          </button>
        </div>
        {folders.map(([folder, notes]) => (
          <div key={folder || "(root)"} className="tree-folder">
            <button className="tree-folder-name ghost" onClick={() => setCollapsed((s) => toggle(s, folder))}>
              <span className={`disclosure ${collapsed.has(folder) ? "" : "open"}`}>▸</span>
              {folder === "" ? "/" : folder}
            </button>
            {!collapsed.has(folder) &&
              notes.map((n) => (
                <button
                  key={n.id}
                  className={`tree-note ghost ${open?.id === n.id ? "active" : ""}`}
                  onClick={() => openNote(n.id)}
                >
                  <span className="tree-note-title">{n.title}</span>
                  {n.openTasks > 0 && <span className="tree-note-count">{n.openTasks}</span>}
                </button>
              ))}
          </div>
        ))}
      </aside>

      <section className="editor-pane">
        {open ? (
          <>
            <header className="editor-head">
              <div>
                <h1 className="editor-title">{open.title}</h1>
                <span className="editor-path">{open.path}</span>
              </div>
              <span className={`save-state ${status}`}>
                {open.canEdit ? (status === "saved" ? "saved" : status === "saving" ? "saving…" : "⚠ save failed") : "read-only"}
              </span>
            </header>
            <Editor
              noteId={open.id}
              content={open.content}
              readOnly={!open.canEdit}
              completions={completions}
              onChange={save}
            />
          </>
        ) : (
          <div className="editor-empty">
            <p>Select a note — or press <kbd>⌘K</kbd> to search, <kbd>c</kbd> to capture.</p>
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
                      <span className="badge">◆</span>
                    ) : (
                      open.canEdit && (
                        <button className="ghost promote" title="Promote to task object" onClick={() => promote(t.line)}>
                          ◇
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
                // Locked stub (§5.4): the text the author wrote, nothing more.
                <span key={i} className="side-link locked" title="You don't have access to this note">
                  🔒 {l.alias ?? l.target}
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
                  ✦ {r.title}
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

function toggle(s: Set<string>, key: string): Set<string> {
  const next = new Set(s);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
