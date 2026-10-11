import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isAbort, latestOnly, unlessAborted, type Me, type NoteDetail, type TreeNote } from "./api.js";
import { blankNote, createNote as createNoteAt } from "./newNote.js";
import type { NoteSync } from "@basalt/sync/client";
import { Editor } from "./Editor.js";
import { noteForLink } from "./notes/links.js";
import { FileTree } from "./FileTree.js";
import { CATEGORIES, categoryColor, categoryOf } from "./categories.js";
import { IconLock, IconPlus, IconPromote } from "./icons.js";
import { dropDraft, openNoteSync, readDraft, restoredText, retire } from "./noteSync.js";
import { onWs, sendEditing } from "./ws.js";
import { Icon } from "./ui/Icon.js";
import { NameDialog } from "./ui/NameDialog.js";
import { Button, LinkButton } from "./ui/controls.js";
import { EmptyState, Notice } from "./ui/states.js";
import { dateTimeLabel } from "./ui/dates.js";
import { navigate } from "./ui/router.js";

/** Tree reloads asked for within this long of each other are one reload (WEB-009). */
export const TREE_RELOAD_MS = 500;

/** Architecture: the vault's shape. Files grouped by folder, scoped All / team /
 *  personal, with the link graph glowing faintly behind — structure you can feel. */
export function Architecture({ me, noteId, category: initialCategory }: { me: Me; noteId?: string; category?: string }) {
  const [tree, setTree] = useState<TreeNote[]>([]);
  // Seeded from the route so the Dashboard's category donut can open this view
  // already scoped to the slice that was clicked.
  const [category, setCategory] = useState(initialCategory ?? "all");
  const [open, setOpen] = useState<NoteDetail | null>(null);
  const [related, setRelated] = useState<{ id: string; title: string; score: number }[]>([]);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  /** Why the open note's last save failed, in the server's words (WEB-002). */
  const [why, setWhy] = useState<string | undefined>();
  /** The note left the vault while open: saving has stopped, the typing is still here. */
  const [gone, setGone] = useState(false);
  /** Typing an earlier page never saved, offered back merged onto the note as it is now. */
  const [draft, setDraft] = useState<{ text: string; at: number } | null>(null);
  /** Bumped to give the editor a restored text (its content prop is read once per note). */
  const [restored, setRestored] = useState(0);
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

  // The tree is the whole vault. One load at a time, the latest wins (an older reply landing
  // last used to put old titles and counts back), and the reloads that every save and every
  // live-sync event ask for come together into one, half a second after the last (WEB-009).
  const [nextTree] = useState(latestOnly);
  const loadTree = useCallback(async () => {
    clearTimeout(treeTimer.current);
    try {
      setTree(await api<TreeNote[]>("GET", "/api/vault/tree", undefined, { signal: nextTree() }));
    } catch (e) {
      unlessAborted(e);
    }
  }, [nextTree]);
  const treeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reloadTree = useCallback(() => {
    clearTimeout(treeTimer.current);
    treeTimer.current = setTimeout(() => void loadTree(), TREE_RELOAD_MS);
  }, [loadTree]);
  useEffect(() => () => clearTimeout(treeTimer.current), []);

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
      // Hooks of this note's own: a note closed while its save fails can't report on this one.
      const next = note.canEdit
        ? openNoteSync(note, {
            status: (s, reason) => {
              setStatus(s);
              setWhy(reason);
            },
            // Renamed elsewhere: the header shows where it is now (WEB-005).
            moved: (path) => setOpen((o) => (o && o.id === id ? { ...o, path } : o)),
            gone: () => setGone(true),
          })
        : null;
      syncRef.current = { id, sync: next };
      setSync(next);
      setOpen(note);
      setGone(false);
      // A sync picked up with its unsaved typing reports its own state; a fresh one is saved.
      setStatus(next?.dirty ? (next.error ? "error" : "saving") : "saved");
      setWhy(next?.error ?? undefined);
      const d = next && !next.dirty ? readDraft(id) : null;
      const text = d && restoredText(d, note.content);
      if (d && !text) dropDraft(id);
      setDraft(text ? { text, at: d!.at } : null);
      api<{ id: string; title: string; score: number }[]>("GET", `/api/vault/note/${id}/related`, undefined, { signal }).then(setRelated, unlessAborted);
    },
    [nextOpen],
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
        // Your own save comes back this way too: the one tree reload a save causes.
        reloadTree();
        const current = openRef.current;
        // Not while another note is on its way: refreshing this one would
        // cancel the note just clicked.
        if (current && (msg.noteId === current.id || msg.resync) && wantRef.current === current.id) {
          // Whoever wrote it — you included, in this tab or another — refresh
          // the header too: the panel's tasks, links and tags are read off the
          // text, so a save that moved lines moved them (WEB-004). The text
          // itself merges into whatever is being typed.
          void openNote(current.id);
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
  }, [reloadTree, openNote]);

  const onEdit = useCallback((content: string) => {
    const note = openRef.current;
    if (note) sendEditing(note.id);
    syncRef.current?.sync?.edit(content);
  }, []);

  // New note: a name in the Dialog (§8 #12). What the server refuses is said under the field.
  const [naming, setNaming] = useState(false);
  const createNote = async (name: string) => {
    if (name.endsWith("/")) throw new Error("Add the note's name after the folder.");
    const path = name.endsWith(".md") ? name : `${name}.md`;
    // Create-only: an existing note at this path is a 409, said under the field, never replaced.
    const res = await createNoteAt(path, blankNote(path.split("/").pop()!.replace(/\.md$/, "")));
    await loadTree();
    await openNote(res.id);
  };

  // A task is named by its block id or its text, the line only a hint: if the
  // note moved since the panel was drawn, the server finds the task or says
  // 409, and the panel reloads either way (COR-001, WEB-004).
  const checkTask = async (t: NoteDetail["tasks"][number], checked: boolean) => {
    if (!open) return;
    try {
      await api("POST", "/api/tasks/check", { noteId: open.id, line: t.line, blockId: t.blockId, text: t.text, checked });
    } finally {
      await openNote(open.id);
    }
  };

  const promote = async (t: NoteDetail["tasks"][number]) => {
    if (!open) return;
    try {
      await api("POST", "/api/tasks/promote", { noteId: open.id, line: t.line, text: t.text });
    } finally {
      await openNote(open.id);
    }
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
          <button className="ghost scope-new" onClick={() => setNaming(true)} title="New note" aria-label="New note">
            <IconPlus />
          </button>
          {naming && (
            <NameDialog
              title="New note"
              label="Path"
              help="A folder and a name, like Ideas/Reading list"
              onSubmit={createNote}
              onClose={() => setNaming(false)}
            />
          )}
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
        <FileTree notes={scoped} activeId={open?.id ?? null} colorForId={colorForId} onOpen={openNote} />
        {open && (
          <button className="ft-map ghost" onClick={closeNote}>
            Close note
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
                  <Icon name="x" size={14} />
                </button>
                {open.canEdit && !isProject && (
                  <button className="make-project" onClick={makeProject} title="Add project tags so this note shows on the board">
                    + Make this a project
                  </button>
                )}
                {isProject && <span className="is-project-badge" title="This note is a project">● project</span>}
                {editingBy && <span className="presence-badge">{editingBy.username} is editing</span>}
                <span className={`save-state ${status}`} title={status === "error" ? why : undefined}>
                  {open.canEdit ? (status === "saved" ? "saved" : status === "saving" ? "saving…" : "not saved") : "read-only"}
                </span>
              </span>
            </header>
            {status === "error" && (
              <Notice
                title={gone ? "This note is no longer in your notes." : "Not saved yet."}
                text={gone ? "It was deleted or moved out of reach. Your typing is still here: copy it before you leave." : `${why ? `The server said: ${why}. ` : ""}Your typing is kept here and tried again.`}
              />
            )}
            {draft && (
              <Notice
                ok
                title={`Typing from ${dateTimeLabel(draft.at)} wasn't saved.`}
                text="It was kept on this device. Restore it into the note, or let it go."
                actions={
                  <>
                    <Button
                      size="sm"
                      onClick={() => {
                        sync?.edit(draft.text);
                        setDraft(null);
                        setRestored((n) => n + 1);
                      }}
                    >
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      kind="quiet"
                      onClick={() => {
                        dropDraft(open.id);
                        setDraft(null);
                      }}
                    >
                      Discard
                    </Button>
                  </>
                }
              />
            )}
            <Editor
              key={restored}
              noteId={open.id}
              content={sync?.content ?? open.content}
              readOnly={!open.canEdit}
              completions={completions}
              onChange={onEdit}
              sync={sync}
              onFollowLink={(target) => {
                // The link's own target, resolved the way the server did (WEB-007).
                const id = noteForLink(target, open.links, tree);
                if (id) void openNote(id);
              }}
            />
          </>
        ) : (
          // The map left Notes for its own place, the Orrery (§8 #3); R7 redraws this page.
          <EmptyState
            pose="read"
            title="Open a note from the list"
            text="The map of your notes is the Orrery now."
            actions={
              <LinkButton
                href="/orrery"
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  navigate({ kind: "orrery" });
                }}
              >
                Open the Orrery
              </LinkButton>
            }
          />
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
                      onChange={(e) => checkTask(t, e.target.checked)}
                      aria-label={t.text}
                    />
                    <span>{t.text}</span>
                    {t.blockId ? (
                      <span className="promoted-mark" title="Promoted task">
                        <IconPromote />
                      </span>
                    ) : (
                      open.canEdit && (
                        <button className="ghost promote" title="Promote to task object" onClick={() => promote(t)}>
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
