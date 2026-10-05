import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isAbort, latestOnly, unlessAborted, type Me, type NoteDetail, type TreeNote } from "./api.js";
import type { NoteSync } from "@basalt/sync/client";
import { Editor } from "./Editor.js";
import { FileTree } from "./FileTree.js";
import { GraphCanvas, type GraphData } from "./GraphCanvas.js";
import { CATEGORIES, categoryColor, categoryOf } from "./categories.js";
import { IconLock, IconPlus, IconPromote } from "./icons.js";
import { openNoteSync, retire } from "./noteSync.js";
import { onWs, sendEditing } from "./ws.js";

/** Architecture: the vault's shape. Files grouped by folder, scoped All / team /
 *  personal, with the link graph glowing faintly behind — structure you can feel. */
export function Architecture({ me, noteId, category: initialCategory }: { me: Me; noteId?: string; category?: string }) {
  const [tree, setTree] = useState<TreeNote[]>([]);
  const [graph, setGraph] = useState<GraphData | null>(null);
  // Seeded from the route so the Dashboard's category donut can open this view
  // already scoped to the slice that was clicked.
  const [category, setCategory] = useState(initialCategory ?? "all");
  const [open, setOpen] = useState<NoteDetail | null>(null);
  const [related, setRelated] = useState<{ id: string; title: string; score: number }[]>([]);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [editingBy, setEditingBy] = useState<{ username: string; at: number } | null>(null);
  const openRef = useRef<NoteDetail | null>(null);
  openRef.current = open;
  // The open note's TEXT lives here, not in `open` (which is its header, tasks
  // and backlinks). See packages/sync/src/client.ts.
  const [sync, setSync] = useState<NoteSync | null>(null);
  const syncRef = useRef<{ id: string; sync: NoteSync | null } | null>(null);
  // Opening a note is a latest-wins load: click A then B, and A's reply
  // landing second used to open A — with its live sync — while B was chosen.
  const [nextOpen] = useState(latestOnly);
  /** The note last asked for, which may still be on its way. */
  const wantRef = useRef<string | null>(null);

  const loadTree = useCallback(async () => {
    setTree(await api<TreeNote[]>("GET", "/api/vault/tree"));
    setGraph(await api<GraphData>("GET", "/api/vault/graph"));
  }, []);

  /** Close the open note, saving anything still pending first. */
  const closeNote = useCallback(() => {
    nextOpen(); // a note still on its way must not open after the close
    wantRef.current = null;
    retire(syncRef.current?.sync ?? null);
    syncRef.current = null;
    setSync(null);
    setOpen(null);
  }, [nextOpen]);
  useEffect(() => () => retire(syncRef.current?.sync ?? null), []);

  // Remembered after the note closes so the map can stay anchored on it — that
  // is what makes the local graph useful: read a note, step back, see its web.
  const [lastOpenId, setLastOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState<{ count: number; local: boolean; depth: number; hidden: number }>({ count: 0, local: false, depth: 1, hidden: 0 });
  // What the file tree is pointing at, mirrored onto the map.
  const [spotlight, setSpotlight] = useState<{ ids: Set<string>; label: string } | null>(null);

  // Esc closes the note and drops you back on the map — the way every editor works.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName) || !!el.closest(".cm-editor"));
      if (!typing) closeNote();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeNote]);

  const openNote = useCallback(
    async (id: string) => {
      wantRef.current = id;
      const signal = nextOpen();
      let note: NoteDetail;
      try {
        note = await api<NoteDetail>("GET", `/api/vault/note/${id}`, undefined, { signal });
      } catch (e) {
        if (isAbort(e)) return;
        if (wantRef.current === id) wantRef.current = openRef.current?.id ?? null;
        throw e;
      }
      if (syncRef.current?.id === id) {
        // The same note again (a toggle, a live-sync event): refresh the header
        // and let the sync merge the text into whatever is being typed.
        setOpen(note);
        void syncRef.current.sync?.refresh();
        return;
      }
      retire(syncRef.current?.sync ?? null);
      const next = note.canEdit ? openNoteSync(note, { status: setStatus, saved: () => void loadTree() }) : null;
      syncRef.current = { id, sync: next };
      setSync(next);
      setOpen(note);
      setLastOpenId(note.id);
      setStatus("saved");
      api<{ id: string; title: string; score: number }[]>("GET", `/api/vault/note/${id}/related`, undefined, { signal }).then(setRelated, unlessAborted);
    },
    [loadTree, nextOpen],
  );

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
        // Not while another note is on its way: refreshing this one would
        // cancel the note just clicked.
        if (current && msg.noteId === current.id && wantRef.current === current.id) {
          // Someone else: refresh the header too. You (another tab, the phone,
          // a toggle on this page): the text is all that can have moved, and a
          // refresh after your own save is a no-op.
          if (msg.authorId !== me.id) void openNote(current.id);
          else void syncRef.current?.sync?.refresh();
        }
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

  const onEdit = useCallback((content: string) => {
    const note = openRef.current;
    if (note) sendEditing(note.id);
    syncRef.current?.sync?.edit(content);
  }, []);

  const createNote = async () => {
    const name = prompt("Note path:", "");
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

  const isProject = open?.tags?.some((t) => /^project\//i.test(t.tag)) ?? false;
  const makeProject = async () => {
    if (!open) return;
    await api("POST", "/api/projects/promote", { noteId: open.id });
    await openNote(open.id);
  };

  const scoped = useMemo(
    () => (category === "all" ? tree : tree.filter((n) => categoryOf(n) === category)),
    [tree, category],
  );
  const scopedIds = useMemo(() => new Set(scoped.map((n) => n.id)), [scoped]);
  const allIds = useMemo(() => new Set(tree.map((n) => n.id)), [tree]);
  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of tree) m.set(categoryOf(n), (m.get(categoryOf(n)) ?? 0) + 1);
    return m;
  }, [tree]);

  // One colour per note id, shared by the map and the file list so the vault is
  // colour-coded consistently everywhere.
  const noteColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of tree) m.set(n.id, categoryColor(categoryOf(n)));
    return m;
  }, [tree]);
  // Goes to the file tree (DOM), never to the graph canvas — the canvas reads
  // --text-dim itself and stays monochrome, so a var() here is safe.
  const colorForId = useCallback((id: string) => noteColor.get(id) ?? "var(--vault-other)", [noteColor]);

  const completions = useMemo(
    () => ({
      titles: tree.map((n) => n.title),
      users: [me.username],
      tags: [...new Set(tree.flatMap((n) => n.tags))],
    }),
    [tree, me.username],
  );

  return (
    <div className="arch">
      <aside className="arch-files">
        <div className="cat-bar">
          <label className="cat-picker">
            <span className="cat-picker-label">Show</span>
            <select
              className="cat-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              aria-label="Filter notes by category"
            >
              <option value="all">All notes · {tree.length}</option>
              {CATEGORIES.filter((c) => (catCounts.get(c.id) ?? 0) > 0).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {catCounts.get(c.id)}
                </option>
              ))}
            </select>
          </label>
          <button className="ghost scope-new" onClick={createNote} title="New note" aria-label="New note">
            <IconPlus />
          </button>
        </div>
        <div className="cat-legend" role="group" aria-label="Categories">
          {CATEGORIES.filter((c) => (catCounts.get(c.id) ?? 0) > 0).map((c) => (
            <button
              key={c.id}
              className={`legend-chip ${category === c.id ? "active" : ""}`}
              style={{ ["--cat" as string]: c.color }}
              onClick={() => setCategory(category === c.id ? "all" : c.id)}
              title={`${c.label} · ${catCounts.get(c.id)}`}
            >
              <span className="legend-dot" />
              {c.label}
            </button>
          ))}
        </div>
        <FileTree notes={scoped} activeId={open?.id ?? null} colorForId={colorForId} onOpen={openNote} onSpotlight={setSpotlight} />
        {open && (
          <button className="ft-map ghost" onClick={closeNote}>
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
                <button className="editor-close" onClick={closeNote} title="Close note (Esc)" aria-label="Close note">
                  ✕
                </button>
                {open.canEdit && !isProject && (
                  <button className="make-project" onClick={makeProject} title="Add project tags so this note shows on the board">
                    + Make this a project
                  </button>
                )}
                {isProject && <span className="is-project-badge" title="This note is a project">● project</span>}
                {editingBy && <span className="presence-badge">{editingBy.username} is editing</span>}
                <span className={`save-state ${status}`}>
                  {open.canEdit ? (status === "saved" ? "saved" : status === "saving" ? "saving…" : "save failed") : "read-only"}
                </span>
              </span>
            </header>
            <Editor
              noteId={open.id}
              content={sync?.content ?? open.content}
              readOnly={!open.canEdit}
              completions={completions}
              onChange={onEdit}
              sync={sync}
              onFollowLink={(title) => {
                const target = tree.find((n) => n.title.toLowerCase() === title.toLowerCase());
                if (target) void openNote(target.id);
              }}
            />
          </>
        ) : (
          <div className="map-stage">
            <GraphCanvas
              graph={graph}
              visibleIds={allIds}
              highlightIds={category === "all" ? null : scopedIds}
              focusId={lastOpenId}
              spotlight={spotlight}
              onShown={setShown}
              onOpen={openNote}
            />
            <span className="map-hint">
              {shown.local
                ? `${shown.count} of ${tree.length} · local graph, depth ${shown.depth}`
                : category === "all"
                  ? `${shown.count} notes${shown.hidden ? ` · ${shown.hidden} conversation${shown.hidden === 1 ? "" : "s"} hidden` : ""}`
                  : `${shown.count} of ${tree.length} · ${CATEGORIES.find((c) => c.id === category)?.label}`}{" "}
              · drag a node · scroll to zoom · click to open
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
                    <input
                      type="checkbox"
                      checked={t.checked}
                      // `[/]` / `[b]`: open, but not untouched — a dash, like the editor's half box.
                      ref={(el) => {
                        if (el) el.indeterminate = t.status === "in-progress" || t.status === "blocked";
                      }}
                      title={t.status === "in-progress" ? "In progress" : t.status === "blocked" ? "Blocked" : undefined}
                      onChange={(e) => checkTask(t.line, e.target.checked)}
                      aria-label={t.text}
                    />
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
