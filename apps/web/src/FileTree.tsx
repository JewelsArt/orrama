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
  onOpen,
}: {
  notes: TreeNote[];
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("basalt-tree-closed") ?? "[]"));
    } catch {
      return new Set();
    }
  });

  const toggle = (path: string) => {
    const next = new Set(closed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setClosed(next);
    localStorage.setItem("basalt-tree-closed", JSON.stringify([...next]));
  };

  const tree = useMemo(() => buildTree(notes), [notes]);

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
          aria-expanded={!closed.has(node.path)}
        >
          <IconChevron open={!closed.has(node.path)} />
          <span className="ft-folder-name">{node.name}</span>
          <span className="ft-count">{node.count}</span>
        </button>
      )}
      {(node.path === "" || !closed.has(node.path)) && (
        <>
          {node.folders.map((f) => renderFolder(f, depth + 1))}
          {node.notes.map((n) => (
            <button
              key={n.id}
              className={`ft-note ${n.id === activeId ? "active" : ""}`}
              style={{ paddingLeft: (depth + 1) * 14 + 4 }}
              onClick={() => onOpen(n.id)}
            >
              <span className="ft-note-title">{n.title}</span>
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
              <button key={n.id} className={`ft-note ft-match ${n.id === activeId ? "active" : ""}`} onClick={() => onOpen(n.id)}>
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
