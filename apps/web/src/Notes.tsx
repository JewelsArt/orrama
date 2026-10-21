import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { updateFrontmatter } from "@orrama/core";
import type { GraphRelations, GraphSchema, NotesOverview } from "@orrama/schema/responses";
import type { NoteSync } from "@orrama/sync/client";
import { api, ApiError, isAbort, latestOnly, unlessAborted, type Me, type NoteDetail, type TreeNote } from "./api.js";
import { readKey, removeKey, writeKey } from "./storage.js";
import { blankNote, createNote as createNoteAt } from "./newNote.js";
import { Editor } from "./Editor.js";
import { noteForLink } from "./notes/links.js";
import { FileTree } from "./FileTree.js";
import { categoryOf } from "./categories.js";
import { dropDraft, openNoteSync, readDraft, restoredText, retire } from "./noteSync.js";
import { onWs, sendEditing } from "./ws.js";
import { slugOf } from "./orrery/model.js";
import { AreaChip, NotesHome, NoteTop, SidePanel, TreePane } from "./notes/parts.js";
import { dueOf, folderName, isOrdinary, pinnedIn, thousands, wordCount } from "./notes/read.js";
import { NameDialog } from "./ui/NameDialog.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { folderOf, listFolders, moveFolder, moveNote, nameOf, notePath, sayMoved, trashNoteWithUndo } from "./noteActions.js";
import { folderWords, HistorySheet, MoveDialog, NewFolderDialog, RenameFolderDialog, RenameNoteDialog, TrashView, trashFolderRequest } from "./notes/actions.js";
import type { TreeActions } from "./FileTree.js";
import { Button } from "./ui/controls.js";
import { anyLayerOpen, Sheet, toast, type MenuItem } from "./ui/overlays.js";
import { Notice } from "./ui/states.js";
import { attempt } from "./ui/writes.js";
import { dateLabel, dateTimeLabel } from "./ui/dates.js";
import { navigate, routeHref } from "./ui/router.js";
import { usePageTitle } from "./entity/title.js";

/** The note open when you left Notes, which /notes opens on next time (structure.md §2.3). */
export const LAST_NOTE_KEY = "orrama-notes-last";
/** A note's address is its vault path without ".md". */
export const addressOf = (path: string) => path.replace(/\.md$/i, "");

/** Tree reloads asked for within this long of each other are one reload (WEB-009). */
export const TREE_RELOAD_MS = 500;

/** How many notes the tree's Recent list shows (the board: a short list above the folders). */
const RECENT_IN_TREE = 4;
const RECENT_AT_HOME = 8;

/**
 * Notes (structure.md §2.3, the Notes boards): the tree on the left, the note in a white box,
 * and beside it what the note is about — relations in words first. With no note open it is
 * Notes home. Which note is open is the address (/notes/<path>); /notes opens on the last one
 * until you close it. The map left for the Orrery (§8 #3).
 */
export function Notes({ me, noteId, notePath: openPath, trash = false }: { me: Me; noteId?: string; notePath?: string; trash?: boolean }) {
  const notePathProp = openPath;
  const [tree, setTree] = useState<TreeNote[] | null>(null);
  /** Every folder, empty ones too (1C). */
  const [folders, setFolders] = useState<string[]>([]);
  const treeRef = useRef<TreeNote[]>([]);
  treeRef.current = tree ?? [];
  const [category, setCategory] = useState("all");
  /** What is typed in the tree's filter (`#tag` filters by tag). */
  const [filter, setFilter] = useState("");
  /** A folder the tree should show open (a crumb was clicked). */
  const [reveal, setReveal] = useState<string | undefined>();
  /** On a phone, the tree is a sheet from the note's top row. */
  const [treeSheet, setTreeSheet] = useState(false);
  const [overview, setOverview] = useState<NotesOverview | null>(null);
  const [projects, setProjects] = useState<{ slug: string; name: string; noteId: string | null }[]>([]);
  /** Does this vault have an ontology? Without one, Relations shows links (structure.md §2.3). */
  const [typed, setTyped] = useState<boolean | null>(null);
  const [relations, setRelations] = useState<GraphRelations | null>(null);
  /** An address naming a note this vault doesn't have (or you can't read). */
  const [missing, setMissing] = useState<string | null>(null);
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
  const [nextOverview] = useState(latestOnly);
  const loadTree = useCallback(async () => {
    clearTimeout(treeTimer.current);
    // Notes home's pins and counts come with the tree, and like it, the latest answer wins.
    // An older server (mid-ship) may not know the route yet: no pins and no counts, not a crash.
    api<NotesOverview>("GET", "/api/notes/overview", undefined, { signal: nextOverview() }).then(
      (o) => setOverview(Array.isArray(o?.pinned) ? o : null),
      (e) => {
        if (isAbort(e)) return;
        setOverview(null);
      },
    );
    listFolders().then(
      (f) => setFolders(Array.isArray(f) ? f : []),
      () => {},
    );
    try {
      setTree(await api<TreeNote[]>("GET", "/api/vault/tree", undefined, { signal: nextTree() }));
    } catch (e) {
      unlessAborted(e);
    }
  }, [nextTree, nextOverview]);
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
    setRelations(null);
  }, [nextOpen]);
  useEffect(() => () => retire(syncRef.current?.sync ?? null), []);

  /*
   * Which note is open is the address (WEB-024). Every way of opening one — the tree, a link,
   * a backlink, a new note — goes to its address, and closing goes to /notes; the page then
   * follows the address. Opening used to be this screen's own state, so App still held the
   * note you arrived on: after moving on or closing it, ⌘K back to that note changed nothing.
   */
  const go = useCallback((id: string) => {
    const n = treeRef.current.find((t) => t.id === id);
    navigate(n ? { kind: "notes", path: addressOf(n.path) } : { kind: "notes", id });
  }, []);
  /** Close the open note: Notes home, which /notes also opens on until you open another. */
  const leave = useCallback(() => {
    removeKey(LAST_NOTE_KEY);
    navigate({ kind: "notes" });
  }, []);

  // Esc closes the note — the way every editor works. Not while typing, and not under an overlay
  // (its own Escape closes it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || anyLayerOpen()) return;
      const el = document.activeElement;
      const typing = el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName) || !!el.closest(".cm-editor"));
      if (!typing && openRef.current) leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leave]);

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
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
          if (syncRef.current?.id === id) closeNote(); // the open note is gone
          setMissing(treeRef.current.find((t) => t.id === id)?.path ?? id);
          return;
        }
        throw e;
      }
      setMissing(null);
      writeKey(LAST_NOTE_KEY, id);
      if (syncRef.current?.id === id) {
        // The same note again (a toggle, a live-sync event): refresh the header
        // and let the sync merge the text into whatever is being typed. Renamed or moved
        // meanwhile (here or elsewhere): the address follows it.
        const was = openRef.current;
        setOpen(note);
        if (was && was.id === id && was.path !== note.path && wantRef.current === id) navigate({ kind: "notes", path: addressOf(note.path) }, { replace: true });
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
            // Renamed elsewhere: the header and the address show where it is now (WEB-005).
            moved: (path) => {
              setOpen((o) => (o && o.id === id ? { ...o, path } : o));
              if (wantRef.current === id) navigate({ kind: "notes", path: addressOf(path) }, { replace: true });
            },
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
      setRelations(null);
      api<{ id: string; title: string; score: number }[]>("GET", `/api/vault/note/${id}/related`, undefined, { signal }).then(setRelated, unlessAborted);
    },
    [nextOpen, closeNote],
  );

  // Relations in words, from the graph (structure.md §4 #2), for a vault that has an ontology.
  // Asked again whenever the note is (a save may have added a link); a newer note cancels it.
  const [nextRelations] = useState(latestOnly);
  useEffect(() => {
    if (!open || !typed) return;
    api<GraphRelations>("GET", `/api/graph/relations?entity=${encodeURIComponent(open.id)}`, undefined, { signal: nextRelations() }).then(
      (r) => setRelations(r.entity.id === openRef.current?.id ? r : null),
      (e) => {
        unlessAborted(e);
      },
    );
  }, [open, typed, nextRelations]);

  useEffect(() => {
    void loadTree();
    // Once per visit: which notes are projects (their slug opens the Orrery on them, their name
    // is the note's chip), and whether the vault has an ontology at all.
    api<{ slug: string; name: string; noteId: string | null }[]>("GET", "/api/projects").then((p) => setProjects(Array.isArray(p) ? p : []), () => {});
    api<GraphSchema>("GET", "/api/graph/schema").then(
      (s) => setTyped(Array.isArray(s?.types) && s.types.length > 0),
      () => setTyped(false),
    );
  }, [loadTree]);

  // Follow the address. A path is looked up in the tree (App's copy of it may predate a note
  // just made); bare /notes opens the note you had open last, until you close it.
  const treeLoaded = tree !== null;
  // The open note just renamed or moved is the note at its new address before the tree has it.
  const wanted =
    noteId ??
    (notePathProp !== undefined
      ? ((tree ?? []).find((n) => addressOf(n.path) === notePathProp)?.id ?? (open && addressOf(open.path) === notePathProp ? open.id : undefined))
      : undefined);
  useEffect(() => {
    if (trash) {
      if (wantRef.current || openRef.current) closeNote();
      setMissing(null);
      return;
    }
    if (wanted) {
      if (wanted !== wantRef.current) void openNote(wanted);
      return;
    }
    if (notePathProp !== undefined) {
      if (treeLoaded) {
        closeNote();
        setMissing(`${notePathProp}.md`);
      }
      return;
    }
    setMissing(null);
    const last = readKey(LAST_NOTE_KEY);
    if (last && treeLoaded && treeRef.current.some((n) => n.id === last)) go(last);
    else if (wantRef.current || openRef.current) closeNote();
  }, [wanted, notePathProp, treeLoaded, openNote, closeNote, go, trash]);
  // Opened by its id: once the tree knows the path, the address says it (replacing, not adding).
  useEffect(() => {
    if (!noteId || notePathProp !== undefined || !open || open.id !== noteId) return;
    navigate({ kind: "notes", path: addressOf(open.path) }, { replace: true });
  }, [noteId, notePathProp, open]);

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
    go(res.id);
  };

  // A task is named by its block id or its text, the line only a hint: if the
  // note moved since the panel was drawn, the server finds the task or says
  // 409, and the panel reloads either way (COR-001, WEB-004).
  const checkTask = async (t: NoteDetail["tasks"][number], checked: boolean) => {
    if (!open) return;
    const id = open.id;
    await attempt(checked ? "The task wasn't ticked." : "The task wasn't unticked.", async () => {
      try {
        await api("POST", "/api/tasks/check", { noteId: id, line: t.line, blockId: t.blockId, text: t.text, checked });
      } finally {
        await openNote(id);
      }
    });
  };

  const promote = async (t: NoteDetail["tasks"][number]) => {
    if (!open) return;
    const id = open.id;
    await attempt("The task wasn't promoted.", async () => {
      try {
        await api("POST", "/api/tasks/promote", { noteId: id, line: t.line, text: t.text });
      } finally {
        await openNote(id);
      }
    });
  };

  const project = useMemo(() => {
    if (!open) return null;
    const own = projects.find((p) => p.noteId === open.id);
    if (own) return own;
    const tag = open.tags.find((t) => /^project\//i.test(t.tag))?.tag.slice("project/".length);
    return (tag && projects.find((p) => p.slug === tag)) || null;
  }, [open, projects]);
  const isProject = (open?.tags?.some((t) => /^project\//i.test(t.tag)) ?? false) || projects.some((p) => p.noteId === open?.id);
  const makeProject = async () => {
    if (!open) return;
    const id = open.id;
    await attempt("The note wasn't made a project.", async () => {
      await api("POST", "/api/projects/promote", { noteId: id });
      api<{ slug: string; name: string; noteId: string | null }[]>("GET", "/api/projects").then(setProjects, () => {});
      await openNote(id);
    });
  };

  /** The note's text as the editor has it now. */
  const text = sync?.content ?? open?.content ?? "";
  const pinned = !!open && pinnedIn(text);
  // A pin is the note's own front matter (Jules's choice, 11 Oct 2026): one line, through the
  // same sync as typing, so it saves, merges and survives like any edit.
  const togglePin = () => {
    const s = syncRef.current?.sync;
    if (!s || !open) return;
    const next = updateFrontmatter(s.content, (d) => {
      const { pinned: _was, ...rest } = d;
      return pinned ? rest : { ...rest, pinned: true };
    });
    if (next === s.content) {
      toast("This note's properties can't be changed safely here. Pin it in its front matter.");
      return;
    }
    s.edit(next);
    setRestored((n) => n + 1); // the editor takes the new text
    void s.flush().then(() => void loadTree());
  };

  // ---- rename, move, the trash and history (1C: none of it had a screen) ----
  const [renaming, setRenaming] = useState<{ id: string; path: string } | null>(null);
  const [moving, setMoving] = useState<Parameters<typeof MoveDialog>[0]["item"] | null>(null);
  const [newFolderIn, setNewFolderIn] = useState<string | null>(null);
  const [newNoteIn, setNewNoteIn] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [asking, setAsking] = useState<ConfirmRequest | null>(null);

  /** Before the open note moves or goes: what is typed is saved where it is now. */
  const settleOpen = useCallback(async () => {
    await syncRef.current?.sync?.flush();
  }, []);
  /** After anything moved: the tree again, and the open note read again — its header, its
   *  sync and the address follow where it is now (openNote), live sync or not. */
  const afterChange = useCallback(async () => {
    await loadTree();
    const cur = openRef.current;
    if (cur && wantRef.current === cur.id) await openNote(cur.id);
  }, [loadTree, openNote]);
  /** Put a note in the trash; the open one closes, and Undo opens it again. */
  const trashOne = useCallback(
    async (n: { id: string; path: string; title: string }) => {
      const isOpen = openRef.current?.id === n.id;
      if (isOpen) await settleOpen();
      await trashNoteWithUndo(n.path, n.title, {
        after: () => {
          if (isOpen) {
            void syncRef.current?.sync?.refresh(); // it is gone: the sync stops saving
            leave();
          }
          void loadTree();
        },
        restored: (id) => {
          void loadTree();
          // By its id: the tree that knows its path again may not have been drawn yet.
          if (isOpen && id) navigate({ kind: "notes", id });
        },
      });
    },
    [settleOpen, leave, loadTree],
  );
  const moveNoteTo = useCallback(
    async (n: { id: string; path: string; title: string }, folder: string) => {
      if (folderOf(n.path) === folder) return;
      if (openRef.current?.id === n.id) await settleOpen();
      await attempt(`“${n.title}” wasn't moved.`, async () => {
        const done = await moveNote(n.path, notePath(folder, nameOf(n.path)));
        sayMoved(`Moved “${n.title}” to ${folderWords(folder)}.`, n.path, done, () => void afterChange());
        await afterChange();
      });
    },
    [settleOpen, afterChange],
  );
  const moveFolderTo = useCallback(
    async (from: string, folder: string) => {
      const leaf = from.slice(from.lastIndexOf("/") + 1);
      await settleOpen();
      await attempt("The folder wasn't moved.", async () => {
        const done = await moveFolder(from, folder ? `${folder}/${leaf}` : leaf);
        toast(`Moved “${folderName(leaf)}” to ${folderWords(folder)}.`, {
          ms: 8000,
          action: { label: "Undo", run: () => void attempt("The folder wasn't put back.", () => moveFolder(done.path, from).then(afterChange)) },
        });
        setReveal(folder || undefined);
        await afterChange();
      });
    },
    [settleOpen, afterChange],
  );
  const treeActions: TreeActions = useMemo(
    () => ({
      noteMenu: (n) => [
        {
          label: "Rename…",
          onSelect: () => {
            if (openRef.current?.id === n.id) void settleOpen();
            setRenaming({ id: n.id, path: n.path });
          },
        },
        { label: "Move to…", onSelect: () => setMoving({ kind: "note", id: n.id, path: n.path, title: n.title }) },
        "-" as const,
        { label: "Move to the trash", danger: true, onSelect: () => void trashOne(n) },
      ],
      folderMenu: (folder, count) => [
        { label: "New note here", onSelect: () => setNewNoteIn(folder) },
        { label: "New folder here", onSelect: () => setNewFolderIn(folder) },
        { label: "Rename…", onSelect: () => setRenamingFolder(folder) },
        { label: "Move to…", onSelect: () => setMoving({ kind: "folder", path: folder }) },
        "-" as const,
        {
          label: "Move to the trash",
          danger: true,
          onSelect: () => {
            void settleOpen();
            setAsking(trashFolderRequest(folder, count, () => void afterChange()));
          },
        },
      ],
      onDropNote: (id, folder) => {
        const n = treeRef.current.find((t) => t.id === id);
        if (n) void moveNoteTo(n, folder);
      },
      onDropFolder: (from, folder) => void moveFolderTo(from, folder),
    }),
    [settleOpen, trashOne, afterChange, moveNoteTo, moveFolderTo],
  );
  /** An earlier version back in the note: a normal edit through its sync, so it is the newest
   *  version now and Undo (or History again) steps back. */
  const restoreVersion = (text: string, at: number) => {
    const s = syncRef.current?.sync;
    if (!s) return;
    const before = s.content;
    s.edit(text);
    setRestored((n) => n + 1);
    void s.flush().then(() =>
      toast(`Restored the version from ${dateTimeLabel(at)}.`, {
        ms: 8000,
        action: {
          label: "Undo",
          run: () => {
            s.edit(before);
            setRestored((n) => n + 1);
            void s.flush();
          },
        },
      }),
    );
  };

  const scoped = useMemo(() => (category === "all" ? (tree ?? []) : (tree ?? []).filter((n) => categoryOf(n) === category)), [tree, category]);
  const catCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of tree ?? []) m.set(categoryOf(n), (m.get(categoryOf(n)) ?? 0) + 1);
    return m;
  }, [tree]);
  const byId = useMemo(() => new Map((tree ?? []).map((n) => [n.id, n])), [tree]);
  const pinnedNotes = useMemo(() => (overview?.pinned ?? []).flatMap((id) => byId.get(id) ?? []), [overview, byId]);
  const inbox = useMemo(() => (tree ?? []).find((n) => n.path.toLowerCase() === `personal/${me.username.toLowerCase()}/inbox.md`) ?? null, [tree, me.username]);
  const recentAll = useMemo(() => [...(tree ?? [])].filter((n) => n.id !== inbox?.id).sort((a, b) => b.mtimeMs - a.mtimeMs), [tree, inbox]);

  const completions = useMemo(
    () => ({
      titles: (tree ?? []).map((n) => n.title),
      users: [me.username],
      tags: [...new Set((tree ?? []).flatMap((n) => n.tags))],
    }),
    [tree, me.username],
  );

  const hrefOf = useCallback((n: TreeNote) => routeHref({ kind: "notes", path: addressOf(n.path) }), []);
  const hrefOfId = useCallback((id: string) => {
    const n = treeRef.current.find((t) => t.id === id);
    return routeHref(n ? { kind: "notes", path: addressOf(n.path) } : { kind: "notes", id });
  }, []);
  const openFromTree = useCallback(
    (id: string) => {
      setTreeSheet(false);
      go(id);
    },
    [go],
  );
  const showArea = (id: string) => {
    setCategory(id);
    setFilter("");
  };
  const showTag = (tag: string) => {
    setFilter(`#${tag}`);
    if (matchMedia("(max-width: 760px)").matches) setTreeSheet(true);
  };
  const showFolder = (folder: string) => {
    setFilter("");
    setReveal(folder);
    if (matchMedia("(max-width: 760px)").matches) setTreeSheet(true);
  };

  const treeProps = {
    tree,
    shown: scoped,
    activeId: open?.id ?? null,
    pinned: pinnedNotes,
    recent: recentAll.slice(0, RECENT_IN_TREE),
    inbox,
    filter,
    onFilter: setFilter,
    area: category,
    onArea: showArea,
    areaCounts: catCounts,
    reveal,
    onOpen: openFromTree,
    hrefOf,
    onHome: () => {
      setTreeSheet(false);
      leave();
    },
    onNew: () => setNaming(true),
    onNewFolder: () => setNewFolderIn(""),
    folders,
    actions: treeActions,
    trashHref: routeHref({ kind: "notes", trash: true }),
    onTrash: () => {
      setTreeSheet(false);
      navigate({ kind: "notes", trash: true });
    },
    inTrash: trash,
  };

  const treeNote = open ? byId.get(open.id) : undefined;
  const kindOf = useCallback(
    (id: string): "person" | "company" | "note" => {
      const tags = byId.get(id)?.tags ?? [];
      return tags.includes("contact") ? "person" : tags.includes("company") ? "company" : "note";
    },
    [byId],
  );
  // A project's folder (04-Projects/<slug>/) is said as the project's name in the crumbs.
  const folderLabel = useCallback((_folder: string, segment: string) => projects.find((p) => p.slug === segment)?.name ?? folderName(segment), [projects]);
  const due = open ? dueOf(text) : null;
  const ordinary = !!open && isOrdinary({ content: text, tags: open.tags }, { project: isProject, type: relations?.entity.type ?? null });
  const orrery = open ? routeHref({ kind: "orrery", center: project && projects.find((p) => p.noteId === open.id) ? project.slug : slugOf(open.path) }) : "/orrery";
  // The window and the phone's top bar name the note as the page does (a title that is only an
  // id is shown by its kind, date and gist, F3), not by its file name.
  usePageTitle(open ? routeHref({ kind: "notes", path: addressOf(open.path) }) : "", open?.title);
  const menu: (MenuItem | "-")[] = open
    ? [
        ...(open.canEdit ? [{ label: pinned ? "Unpin from Notes home" : "Pin to Notes home", onSelect: togglePin }] : []),
        // Only on an ordinary note: never on a person, a company, a conversation, the ontology,
        // or a project already (structure.md §8 #7).
        ...(open.canEdit && ordinary ? [{ label: "Make this a project", onSelect: () => void makeProject() }] : []),
        ...(open.canEdit
          ? [
              {
                label: "Rename…",
                onSelect: () => {
                  void settleOpen();
                  setRenaming({ id: open.id, path: open.path });
                },
              },
              { label: "Move to…", onSelect: () => setMoving({ kind: "note" as const, id: open.id, path: open.path, title: open.title }) },
            ]
          : []),
        { label: "History", onSelect: () => setHistory(true) },
        { label: "Show in the Orrery", onSelect: () => navigate(orrery) },
        { label: "Close note", onSelect: leave },
        ...(open.canEdit ? ["-" as const, { label: "Move to the trash", danger: true, onSelect: () => void trashOne(open) }] : []),
      ]
    : [];

  return (
    <div className={open ? "nt ui has-note" : "nt ui"}>
      <TreePane {...treeProps} />

      <div className="nt-ed">
        <div className="nt-box">
          {trash ? (
            <TrashView onOpen={(id) => navigate({ kind: "notes", id })} onChanged={() => void loadTree()} ask={setAsking} />
          ) : open ? (
            <>
              <NoteTop path={open.path} folderLabel={folderLabel} onHome={leave} onFolder={showFolder} orrery={orrery} menu={menu} onTree={() => setTreeSheet(true)} />
              <article className="nt-doc">
                <h1>{open.title}</h1>
                <div className="nt-meta">
                  <AreaChip note={treeNote} project={project} onArea={showArea} />
                  <span>
                    {[
                      treeNote ? `Edited ${dateTimeLabel(treeNote.mtimeMs)}` : null,
                      `${thousands(wordCount(text))} ${wordCount(text) === 1 ? "word" : "words"}`,
                      due ? `due ${dateLabel(due)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {pinned && (
                    <span className="nt-flag">
                      <svg className="i" viewBox="0 0 20 20" aria-hidden="true" width="14" height="14">
                        <path d="M10 14v4M6.5 3.5h7l-1 4.5 3 3H4.5l3-3z" />
                      </svg>
                      pinned
                    </span>
                  )}
                  {editingBy && <span className="nt-flag">{editingBy.username} is editing</span>}
                  <span className={`nt-save ${open.canEdit ? status : "ro"}`} title={status === "error" ? why : undefined}>
                    {open.canEdit ? (status === "saved" ? "saved" : status === "saving" ? "saving…" : "not saved") : "read-only"}
                  </span>
                </div>
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
                    const id = noteForLink(target, open.links, treeRef.current);
                    if (id) go(id);
                  }}
                />
              </article>
            </>
          ) : missing ? (
            <Notice title={`Can't open “${missing}”.`} text="It isn't in your notes, or it isn't yours to read." />
          ) : (
            <NotesHome
              tree={tree}
              overview={overview}
              pinned={pinnedNotes}
              recent={recentAll.slice(0, RECENT_AT_HOME)}
              inbox={inbox}
              areaCounts={catCounts}
              onOpen={go}
              hrefOf={hrefOf}
              onArea={showArea}
              onNew={() => setNaming(true)}
              folderLabel={folderLabel}
              phoneTree={
                tree && (tree.length > 0 || folders.length > 0) ? (
                  <FileTree notes={scoped} activeId={null} onOpen={go} hrefOf={hrefOf} folders={category === "all" ? folders : undefined} actions={treeActions} />
                ) : undefined
              }
            />
          )}
        </div>
      </div>

      {open && (
        <SidePanel
          note={open}
          kindOf={kindOf}
          relations={typed ? (relations?.relations ?? null) : null}
          related={related}
          hrefOfId={hrefOfId}
          onOpen={go}
          onTag={showTag}
          onCheck={(t) => void checkTask(t, !t.checked)}
          onPromote={(t) => void promote(t)}
        />
      )}

      {treeSheet && (
        <Sheet
          title="Notes"
          onClose={() => setTreeSheet(false)}
          className="nt-tree-sheet"
          head={<Button kind="quiet" size="sm" icon="folder" aria-label="New folder" onClick={() => setNewFolderIn("")} />}
        >
          <TreePane {...treeProps} />
        </Sheet>
      )}
      {naming && (
        <NameDialog title="New note" label="Path" help="A folder and a name, like Ideas/Reading list" onSubmit={createNote} onClose={() => setNaming(false)} />
      )}
      {newNoteIn !== null && (
        <NameDialog
          title="New note"
          label="Name"
          help={`Inside ${folderWords(newNoteIn)}`}
          onSubmit={(name) => createNote(`${newNoteIn}/${name}`)}
          onClose={() => setNewNoteIn(null)}
        />
      )}
      {newFolderIn !== null && (
        <NewFolderDialog
          parent={newFolderIn}
          onDone={(path) => {
            setReveal(path);
            void loadTree();
          }}
          onClose={() => setNewFolderIn(null)}
        />
      )}
      {renamingFolder !== null && (
        <RenameFolderDialog folder={renamingFolder} onDone={(path) => {
          setReveal(path);
          void afterChange();
        }} onClose={() => setRenamingFolder(null)} />
      )}
      {renaming && <RenameNoteDialog note={renaming} onDone={() => void afterChange()} onClose={() => setRenaming(null)} />}
      {moving && <MoveDialog item={moving} folders={folders} onDone={(path) => {
        setReveal(moving.kind === "folder" ? path : folderOf(path) || undefined);
        void afterChange();
      }} onClose={() => setMoving(null)} />}
      {history && open && (
        <HistorySheet noteId={open.id} title={open.title} current={text} me={me} canEdit={open.canEdit && !!sync} onRestore={restoreVersion} onClose={() => setHistory(false)} />
      )}
      <Confirm request={asking} onClose={() => setAsking(null)} />
    </div>
  );
}
