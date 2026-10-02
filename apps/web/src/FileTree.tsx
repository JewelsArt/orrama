import { useMemo, useState } from "react";
import type { TreeNote } from "./api.js";
import { IconChevron, IconSearch } from "./icons.js";

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  notes: TreeNote[];
  count: number;
}

/** Drop the "NN-" ordering prefix Jules uses on top-level PARA folders. */
function cleanFolderName(name: string): string {
  return name.replace(/^\d+[-_.\s]+/, "");
}

/**
 * Notes that share a title with another in the same folder, mapped to their
 * filename. A copy made outside Basalt keeps the original's `title:`, so
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

function buildTree(notes: TreeNote[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: [], notes: [], count: 0 };
  const dir = (path: string): FolderNode => {
    if (path === "") return root;
    const parts = path.split("/");
    let cur = root;
    let acc = "";
    for (const part of parts) {
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
 * File tree built for a real vault (hundreds of notes): properly nested,
 * collapse state remembered, and a filter box because past ~50 files
 * navigation is typing, not scrolling.
 */
export function FileTree({
  notes,
  activeId,
  colorForId,
  onOpen,
  onSpotlight,
}: {
  notes: TreeNote[];
  activeId: string | null;
  colorForId?: (id: string) => string;
  onOpen: (id: string) => void;
  /**
   * Pointing at a row lights the matching nodes on the map: one note for a file,
   * everything beneath it for a folder. `null` when the pointer leaves.
   */
  onSpotlight?: (spot: { ids: Set<string>; label: string } | null) => void;
}) {
  const dot = (id: string) =>
    colorForId ? <span className="ft-dot" style={{ background: colorForId(id) }} aria-hidden /> : null;
  const [filter, setFilter] = useState("");
  // null = user hasn't touched the tree yet → default to fully collapsed for a
  // calm starting view; once they toggle, their exact choices persist.
  const [closed, setClosed] = useState<Set<string> | null>(() => {
    try {
      const saved = localStorage.getItem("basalt-tree-closed");
      return saved ? new Set<string>(JSON.parse(saved)) : null;
    } catch {
      return null;
    }
  });

  const tree = useMemo(() => buildTree(notes), [notes]);
  const filenames = useMemo(() => sameTitleFilenames(notes), [notes]);

  /** Every note id at or below a folder — what "hovering the group" means. */
  const idsUnder = (node: FolderNode): Set<string> => {
    const out = new Set<string>();
    const walk = (n: FolderNode) => {
      for (const note of n.notes) out.add(note.id);
      for (const f of n.folders) walk(f);
    };
    walk(node);
    return out;
  };
  const spotlight = (spot: { ids: Set<string>; label: string } | null) => onSpotlight?.(spot);

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

  const toggle = (path: string) => {
    const next = new Set(effectiveClosed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setClosed(next);
    localStorage.setItem("basalt-tree-closed", JSON.stringify([...next]));
  };

  const q = filter.trim().toLowerCase();
  const matches = useMemo(
    () =>
      q === ""
        ? []
        : notes
            .filter((n) => n.title.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
            .slice(0, 60),
    [notes, q],
  );

  const renderFolder = (node: FolderNode, depth: number): React.ReactNode => (
    <div key={node.path || "(root)"}>
      {node.path !== "" && (
        <button
          className="ft-folder"
          style={{ paddingLeft: depth * 14 }}
          onClick={() => toggle(node.path)}
          onPointerEnter={() => spotlight({ ids: idsUnder(node), label: cleanFolderName(node.name) })}
          onPointerLeave={() => spotlight(null)}
          onFocus={() => spotlight({ ids: idsUnder(node), label: cleanFolderName(node.name) })}
          onBlur={() => spotlight(null)}
          aria-expanded={!effectiveClosed.has(node.path)}
        >
          <IconChevron open={!effectiveClosed.has(node.path)} />
          <span className="ft-folder-name">{cleanFolderName(node.name)}</span>
          <span className="ft-count">{node.count}</span>
        </button>
      )}
      {(node.path === "" || !effectiveClosed.has(node.path)) && (
        <>
          {node.folders.map((f) => renderFolder(f, depth + 1))}
          {node.notes.map((n) => (
            <button
              key={n.id}
              className={`ft-note ${n.id === activeId ? "active" : ""}`}
              style={{ paddingLeft: (depth + 1) * 14 + 4 }}
              onClick={() => onOpen(n.id)}
              onPointerEnter={() => spotlight({ ids: new Set([n.id]), label: n.title })}
              onPointerLeave={() => spotlight(null)}
              onFocus={() => spotlight({ ids: new Set([n.id]), label: n.title })}
              onBlur={() => spotlight(null)}
            >
              {dot(n.id)}
              <span className="ft-note-title">{n.title}</span>
              {filenames.has(n.id) && <span className="ft-note-path">{filenames.get(n.id)}</span>}
              {n.openTasks > 0 && <span className="ft-count">{n.openTasks}</span>}
            </button>
          ))}
        </>
      )}
    </div>
  );

  return (
    <div className="filetree">
      <label className="ft-filter">
        <IconSearch />
        <input
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter files"
        />
        {filter && (
          <button className="ghost" onClick={() => setFilter("")} aria-label="Clear filter">
            ×
          </button>
        )}
      </label>
      <div className="ft-scroll">
        {q === "" ? (
          renderFolder(tree, 0)
        ) : (
          <>
            {matches.map((n) => (
              <button
                key={n.id}
                className={`ft-note ft-match ${n.id === activeId ? "active" : ""}`}
                onClick={() => onOpen(n.id)}
                onPointerEnter={() => spotlight({ ids: new Set([n.id]), label: n.title })}
                onPointerLeave={() => spotlight(null)}
              >
                {dot(n.id)}
                <span className="ft-note-title">{n.title}</span>
                <span className="ft-note-path">{n.folder || "/"}</span>
              </button>
            ))}
            {matches.length === 0 && <p className="empty">No files match “{filter}”.</p>}
          </>
        )}
      </div>
    </div>
  );
}
