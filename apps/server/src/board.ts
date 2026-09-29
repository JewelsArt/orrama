/**
 * The project documents board, stored as JSON Canvas
 * (https://jsoncanvas.org, the format Obsidian's canvases use) in
 * `04-Projects/<slug>/documents.canvas`, beside the project note. Nothing about
 * the board lives in the database: delete the DB and the board comes back.
 *
 * Nodes are either a project FILE (a card) or a GROUP (a labelled box). Edges
 * link two cards; an edge Claude proposed carries `basaltSuggested: true` until
 * the user accepts it. Unknown fields from other tools are dropped on write.
 *
 * Everything here is pure, so the rules are testable without HTTP:
 *   normalizeBoard  — accept only a well-formed board, clamp it, drop dangling
 *                     cards (file gone) and edges (card gone);
 *   placeMissing    — give every file that has no card one, below the rest;
 *   defaultBoard    — what a project without a canvas starts from.
 */

export const CARD_W = 220;
export const CARD_H = 76;
const MAX_NODES = 400;
const MAX_EDGES = 800;
const LIMIT = 20_000; // canvas coordinates, either direction
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** JSON Canvas preset colours ("1"–"6"); Basalt maps them onto its ink hues. */
const COLORS = new Set(["1", "2", "3", "4", "5", "6"]);

export interface FileNode { id: string; type: "file"; file: string; x: number; y: number; width: number; height: number }
export interface GroupNode { id: string; type: "group"; label: string; x: number; y: number; width: number; height: number; color?: string }
export type BoardNode = FileNode | GroupNode;
export interface BoardEdge { id: string; fromNode: string; toNode: string; label?: string; basaltSuggested?: true }
export interface Board { nodes: BoardNode[]; edges: BoardEdge[] }

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : fallback;
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "");

/** The vault-relative path a file card points at: `04-Projects/<slug>/files/<name>`. */
export const fileRef = (slug: string, name: string) => `04-Projects/${slug}/files/${name}`;

/**
 * Accept a board, or throw. `files` is the set of names actually in the
 * project's files folder: a card for anything else is dropped, never trusted —
 * the board must not become a way to point at files outside the project.
 */
export function normalizeBoard(raw: unknown, slug: string, files: Set<string>): Board {
  if (!raw || typeof raw !== "object") throw new Error("board must be an object");
  const r = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) throw new Error("board needs nodes and edges arrays");
  if (r.nodes.length > MAX_NODES || r.edges.length > MAX_EDGES) throw new Error("board too large");

  const prefix = `04-Projects/${slug}/files/`;
  const nodes: BoardNode[] = [];
  const ids = new Set<string>();
  const seenFiles = new Set<string>();
  for (const n of r.nodes as Record<string, unknown>[]) {
    if (!n || typeof n !== "object" || typeof n["id"] !== "string" || !ID_RE.test(n["id"]) || ids.has(n["id"])) continue;
    const box = {
      x: num(n["x"], -LIMIT, LIMIT, 0),
      y: num(n["y"], -LIMIT, LIMIT, 0),
      width: num(n["width"], 80, 4000, CARD_W),
      height: num(n["height"], 40, 4000, CARD_H),
    };
    if (n["type"] === "file" && typeof n["file"] === "string") {
      const file = n["file"];
      const name = file.startsWith(prefix) ? file.slice(prefix.length) : "";
      // Inside this project's folder, and one that exists there. `files` comes
      // from listing that folder, so membership alone rules out any `/` or
      // `..` in the name. One card per file.
      if (!name || !files.has(name) || seenFiles.has(name)) continue;
      seenFiles.add(name);
      nodes.push({ id: n["id"], type: "file", file, ...box });
    } else if (n["type"] === "group") {
      const color = typeof n["color"] === "string" && COLORS.has(n["color"]) ? n["color"] : undefined;
      nodes.push({ id: n["id"], type: "group", label: text(n["label"], 60) || "Untitled", ...box, ...(color ? { color } : {}) });
    } else continue;
    ids.add(n["id"]);
  }

  const cards = new Set(nodes.filter((n) => n.type === "file").map((n) => n.id));
  const edges: BoardEdge[] = [];
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const e of r.edges as Record<string, unknown>[]) {
    if (!e || typeof e !== "object") continue;
    const { id, fromNode, toNode } = e as { id?: unknown; fromNode?: unknown; toNode?: unknown };
    if (typeof id !== "string" || !ID_RE.test(id) || edgeIds.has(id)) continue;
    if (typeof fromNode !== "string" || typeof toNode !== "string" || fromNode === toNode) continue;
    if (!cards.has(fromNode) || !cards.has(toNode)) continue; // links join cards, not boxes
    const pair = [fromNode, toNode].sort().join("|");
    if (pairs.has(pair)) continue;
    pairs.add(pair);
    edgeIds.add(id);
    const label = text(e["label"], 60);
    edges.push({ id, fromNode, toNode, ...(label ? { label } : {}), ...(e["basaltSuggested"] === true ? { basaltSuggested: true as const } : {}) });
  }
  return { nodes, edges };
}

/**
 * Give every file without a card one, in rows of four below everything already
 * on the board — a new upload appears, it is never lost off-screen. Stable ids
 * derive from the name so the same file keeps the same card across reads.
 */
export function placeMissing(board: Board, slug: string, files: string[]): Board {
  const present = new Set(board.nodes.filter((n): n is FileNode => n.type === "file").map((n) => n.file));
  const missing = files.filter((f) => !present.has(fileRef(slug, f))).sort((a, b) => a.localeCompare(b));
  if (missing.length === 0) return board;
  const bottom = board.nodes.reduce((m, n) => Math.max(m, n.y + n.height), 0);
  const top = board.nodes.length ? bottom + 60 : 40;
  const taken = new Set(board.nodes.map((n) => n.id));
  const nodes = [...board.nodes];
  missing.forEach((f, i) => {
    let id = "f-" + f.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30).toLowerCase();
    for (let k = 2; taken.has(id) || !ID_RE.test(id); k++) id = `f-${k}-${i}`;
    taken.add(id);
    nodes.push({ id, type: "file", file: fileRef(slug, f), x: 40 + (i % 4) * (CARD_W + 24), y: top + Math.floor(i / 4) * (CARD_H + 24), width: CARD_W, height: CARD_H });
  });
  return { nodes, edges: board.edges };
}

/** A project that never had a canvas: its files, laid out in rows, in one box. */
export function defaultBoard(slug: string, files: string[]): Board {
  const placed = placeMissing({ nodes: [], edges: [] }, slug, files);
  if (placed.nodes.length === 0) return placed;
  const rows = Math.ceil(placed.nodes.length / 4);
  const group: GroupNode = {
    id: "g-documents", type: "group", label: "Documents", color: "6",
    x: 20, y: 20, width: 4 * (CARD_W + 24) + 16, height: rows * (CARD_H + 24) + 36,
  };
  return { nodes: [group, ...placed.nodes], edges: [] };
}
