import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { TreeNote } from "./api.js";
import { readJson, writeKey } from "./storage.js";
import { Icon } from "./ui/Icon.js";
import { Menu, type MenuItem } from "./ui/overlays.js";
import { folderName } from "./notes/read.js";

/**
 * What can be done to a row (1C): its ⋯ menu — always there on a touch screen, on hover and
 * focus with a mouse, and on a right-click — and, on a desktop, dragging a note or a folder
 * onto a folder (or onto the tree's own space, for the top folder).
 */
export interface TreeActions {
  noteMenu: (n: TreeNote) => (MenuItem | "-")[];
  folderMenu: (folder: string, notes: number) => (MenuItem | "-")[];
  onDropNote: (noteId: string, folder: string) => void;
  onDropFolder: (from: string, folder: string) => void;
}

const DRAG_NOTE = "application/x-orrama-note";
const DRAG_FOLDER = "application/x-orrama-folder";

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  notes: TreeNote[];
  count: number;
}

/**
 * Notes that share a title with another in the same folder, mapped to their
 * filename. A copy made outside Orrama keeps the original's `title:`, so
 * without this the tree shows "Atlas Roadmap" twice and nothing tells them
 * apart; those rows also show the file they are.
 */
export function sameTitleFilenames(notes: { id: string; title: string; folder: string; path: string }[]): Map<string, string> {
  const groups = new Map<string, typeof notes>();
  for (const n of notes) {
    const key = `${n.folder}\u0000${n.title.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const out = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const n of group) out.set(n.id, n.path.slice(n.path.lastIndexOf("/") + 1));
  }
  return out;
}

function buildTree(notes: TreeNote[], folders: string[] = []): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], notes: [], count: 0 };
  const dir = (path: string): FolderNode => {
    if (path === "") return root;
    let cur = root;
    let acc = "";
    for (const part of path.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      let next = cur.folders.find((f) => f.path === acc);
      if (!next) {
        next = { name: part, path: acc, folders: [], notes: [], count: 0 };
        cur.folders.push(next);
      }
      cur = next;
    }
    return cur;
  };
  for (const f of folders) dir(f);
  for (const n of notes) dir(n.folder).notes.push(n);
  const finish = (node: FolderNode): number => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.notes.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    node.count = node.notes.length + node.folders.reduce((s, f) => s + finish(f), 0);
    return node.count;
  };
  finish(root);
  return root;
}

/**
 * Notes matching what was typed in the filter: by title or path, or, starting with `#`, by
 * tag (a tag chip in the side panel filters this way, structure.md §1.7 #5).
 */
export function filterNotes(notes: TreeNote[], query: string, limit = 60): TreeNote[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  if (q.startsWith("#") && q.length > 1) {
    const tag = q.slice(1);
    return notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(`${tag}/`))).slice(0, limit);
  }
  return notes.filter((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)).slice(0, limit);
}

const CLOSED_KEY = "orrama-tree-closed";
const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * The folder tree, built for a real vault (hundreds of notes): properly nested, collapse state
 * remembered, and the filter above it, because past ~50 files navigation is typing, not
 * scrolling. Drawn as the Notes board's rows (`.ti`): folders in the UI font with their count,
 * notes as links to their address.
 */
export function FileTree({
  notes,
  activeId,
  onOpen,
  hrefOf,
  filter = "",
  reveal,
  folders,
  actions,
}: {
  notes: TreeNote[];
  activeId: string | null;
  onOpen: (id: string) => void;
  /** The note's address, so a row is a real link (cmd-click opens a new window). */
  hrefOf: (n: TreeNote) => string;
  filter?: string;
  /** A folder to show open (the crumb of the note you are reading). */
  reveal?: string;
  /** Every folder there is, so an empty one shows too (GET /api/vault/folders). */
  folders?: string[];
  actions?: TreeActions;
}) {
  // null = never touched → everything starts folded, for a calm first view; once you toggle,
  // your exact choices persist.
  const [closed, setClosed] = useState<Set<string> | null>(() => {
    const saved = readJson<unknown>(CLOSED_KEY, null);
    return Array.isArray(saved) ? new Set(saved.filter((s): s is string => typeof s === "string")) : null;
  });

  // Empty folders only when the whole tree is shown: a life area's tree is its notes' folders.
  const tree = useMemo(() => buildTree(notes, folders), [notes, folders]);
  const filenames = useMemo(() => sameTitleFilenames(notes), [notes]);
  const allFolderPaths = useMemo(() => {
    const s = new Set<string>();
    const walk = (n: FolderNode) => {
      if (n.path) s.add(n.path);
      n.folders.forEach(walk);
    };
    walk(tree);
    return s;
  }, [tree]);
  const effectiveClosed = closed ?? allFolderPaths;

  const save = (next: Set<string>) => {
    setClosed(next);
    writeKey(CLOSED_KEY, JSON.stringify([...next]));
  };
  const toggle = (path: string) => {
    const next = new Set(effectiveClosed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    save(next);
  };

  // Show the folder asked for: open it and every folder above it.
  useEffect(() => {
    if (!reveal) return;
    const chain = reveal.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"));
    if (chain.every((p) => !effectiveClosed.has(p))) return;
    const next = new Set(effectiveClosed);
    for (const p of chain) next.delete(p);
    save(next);
    // Only when asked: toggling a folder by hand must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  const matches = useMemo(() => filterNotes(notes, filter), [notes, filter]);

  // One menu at a time, under the ⋯ (or the row) it was asked from.
  const [menu, setMenu] = useState<{ items: (MenuItem | "-")[]; label: string } | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const openMenu = (el: HTMLElement, label: string, items: (MenuItem | "-")[]) => {
    anchor.current = el;
    setMenu({ label, items });
  };
  const more = (label: string, items: () => (MenuItem | "-")[]) =>
    actions && (
      <button
        type="button"
        className="ti-more"
        aria-label={`More for ${label}`}
        aria-haspopup="menu"
        onClick={(e) => openMenu(e.currentTarget, label, items())}
      >
        <Icon name="dots" size={16} />
      </button>
    );
  const onContext = (label: string, items: () => (MenuItem | "-")[]) => (e: MouseEvent<HTMLElement>) => {
    if (!actions) return;
    e.preventDefault();
    openMenu(e.currentTarget, label, items());
  };

  // Drag a row onto a folder: the folder under the pointer is marked.
  const [over, setOver] = useState<string | null>(null);
  const dragging = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_NOTE) || e.dataTransfer.types.includes(DRAG_FOLDER);
  const dropOn = (folder: string) =>
    actions && {
      onDragOver: (e: DragEvent) => {
        if (!dragging(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (over !== folder) setOver(folder);
      },
      onDragLeave: (e: DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver((o) => (o === folder ? null : o));
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(null);
        const note = e.dataTransfer.getData(DRAG_NOTE);
        const from = e.dataTransfer.getData(DRAG_FOLDER);
        if (note) actions.onDropNote(note, folder);
        else if (from && from !== folder && !folder.startsWith(`${from}/`)) actions.onDropFolder(from, folder);
      },
    };
  const dragFrom = (type: string, value: string) =>
    actions && {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        e.dataTransfer.setData(type, value);
        e.dataTransfer.effectAllowed = "move";
      },
      onDragEnd: () => setOver(null),
    };

  const noteRow = (n: TreeNote, depth: number, meta?: string) => (
    <div key={n.id} className="ti-row" onContextMenu={onContext(n.title, () => actions!.noteMenu(n))}>
      <a
        className={n.id === activeId ? "ti on" : "ti"}
        style={{ paddingLeft: 8 + depth * 14 }}
        href={hrefOf(n)}
        aria-current={n.id === activeId ? "page" : undefined}
        onClick={(e) => {
          if (!plainClick(e)) return;
          e.preventDefault();
          onOpen(n.id);
        }}
        {...dragFrom(DRAG_NOTE, n.id)}
      >
        <Icon name="doc" />
        <span>
          {n.title}
          {filenames.has(n.id) && <em className="ti-file"> {filenames.get(n.id)}</em>}
        </span>
        <small>{meta ?? (n.openTasks > 0 ? n.openTasks : "")}</small>
      </a>
      {more(n.title, () => actions!.noteMenu(n))}
    </div>
  );

  const renderFolder = (node: FolderNode, depth: number): React.ReactNode => {
    const isOpen = node.path === "" || !effectiveClosed.has(node.path);
    return (
      <div key={node.path || "(root)"} role="group" aria-label={node.path ? folderName(node.name) : undefined}>
        {node.path !== "" && (
          <div className={over === node.path ? "ti-row drop" : "ti-row"} onContextMenu={onContext(folderName(node.name), () => actions!.folderMenu(node.path, node.count))} {...dropOn(node.path)}>
            <button type="button" className="ti" style={{ paddingLeft: 8 + (depth - 1) * 14 }} onClick={() => toggle(node.path)} aria-expanded={isOpen} {...dragFrom(DRAG_FOLDER, node.path)}>
              <Icon name={isOpen ? "chev-d" : "chev-r"} />
              <span>{folderName(node.name)}</span>
              <small>{node.count || ""}</small>
            </button>
            {more(folderName(node.name), () => actions!.folderMenu(node.path, node.count))}
          </div>
        )}
        {isOpen && (
          <>
            {node.folders.map((f) => renderFolder(f, depth + 1))}
            {node.notes.map((n) => noteRow(n, depth))}
          </>
        )}
      </div>
    );
  };

  const menuEl = menu && <Menu anchor={anchor} label={menu.label} items={menu.items} align="end" onClose={() => setMenu(null)} />;

  if (filter.trim() !== "")
    return (
      <div className="nt-filetree" aria-label="Notes matching the filter">
        {matches.map((n) => noteRow(n, 0, n.folder ? folderName(n.folder.split("/").pop()!) : ""))}
        {matches.length === 0 && <p className="nt-none">No notes match “{filter.trim()}”.</p>}
        {menuEl}
      </div>
    );
  // The tree's own space is the top folder: a row dropped there leaves its folder.
  return (
    <div className={over === "" ? "nt-filetree drop" : "nt-filetree"} {...dropOn("")}>
      {renderFolder(tree, 0)}
      {menuEl}
    </div>
  );
}
