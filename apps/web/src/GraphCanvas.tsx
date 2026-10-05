import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphData } from "@basalt/schema/responses";
export type { GraphData };

const TAG_PREFIX = "tag:";

interface SimNode {
  id: string;
  title: string;
  folder: string;
  description: string;
  /** Degree — how many edges touch this node. Drives radius, Obsidian-style. */
  deg: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx?: number | null;
  fy?: number | null;
}
interface SimLink {
  source: SimNode;
  target: SimNode;
}

export interface GraphSettings {
  /** Force controls, the four that actually change how a graph reads. */
  linkDistance: number;
  repel: number;
  center: number;
  nodeScale: number;
  /** Local mode: only the open note's neighbourhood, `depth` hops out. */
  local: boolean;
  depth: number;
  /** Draw #tags as their own nodes, the way Obsidian's graph does. */
  tags: boolean;
  /** Show saved chats (notes of kind "conversation"). Off: they are most of the vault, and noise on a map. */
  conversations: boolean;
}

const DEFAULTS: GraphSettings = { linkDistance: 38, repel: 115, center: 0.09, nodeScale: 1, local: false, depth: 1, tags: false, conversations: false };

const loadSettings = (): GraphSettings => {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem("basalt-graph") ?? "{}") as Partial<GraphSettings>) };
  } catch {
    return { ...DEFAULTS };
  }
};

/** Layout + view persist across note open/close so the map never re-scatters. */
const savedPos = new Map<string, { x: number; y: number }>();
const savedView = { x: 0, y: 0, k: 1, inited: false };

/** Nodes within `depth` hops of `from`, over undirected edges. */
function neighbourhood(edges: { from: string; to: string }[], from: string, depth: number): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    (adj.get(e.to) ?? adj.set(e.to, []).get(e.to)!).push(e.from);
  }
  const seen = new Set([from]);
  let frontier = [from];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adj.get(id) ?? []) {
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowRight: { x: 1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The keyboard's next node: the nearest one that lies in `dir` from `from`,
 * with sideways distance counting double, so ArrowRight prefers the node
 * straight across over a closer one far above. Null when nothing lies that way.
 */
export function nearestInDirection<N extends { id: string; x: number; y: number }>(
  from: N,
  nodes: N[],
  dir: { x: number; y: number },
): N | null {
  let best: N | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    const vx = n.x - from.x;
    const vy = n.y - from.y;
    const along = vx * dir.x + vy * dir.y;
    if (along <= 0) continue; // behind, beside, or `from` itself
    const across = Math.abs(vx * dir.y - vy * dir.x);
    const score = along + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
}

/**
 * The map: a live force-directed graph, the way Obsidian does it. Nodes repel
 * and collide (so they never stack), links pull like springs, and you can grab
 * any node and drag it — the rest of the web reacts. Wheel to zoom, drag the
 * background to pan, hover to light up a node's neighbourhood, click to open.
 * The keyboard does the same: Tab to the map, arrows move between notes (drawn
 * and announced like a hover), Enter opens, + and − zoom, Esc lets go.
 *
 * Deliberately monochrome: a node's *size* carries its degree and nothing else
 * competes for attention, so the shape of the vault is what you see. Colour
 * still lives in the file list and the category filter, where it labels things.
 * Canvas (not SVG/WebGL) because at hundreds of nodes it stays smooth and the
 * 2-D interaction model is exactly what this needs.
 */
export function GraphCanvas({
  graph,
  visibleIds,
  highlightIds,
  focusId,
  spotlight,
  onShown,
  onOpen,
}: {
  graph: GraphData | null;
  visibleIds: Set<string>;
  highlightIds: Set<string> | null;
  /** The open note: highlighted, and the anchor for local mode. */
  focusId?: string | null;
  /**
   * Nodes to pick out of the crowd — what the file tree is pointing at. Behaves
   * like a hover you did not have to aim: those nodes go accent, everything else
   * fades, and the readout names the file or folder.
   */
  spotlight?: { ids: Set<string>; label: string } | null;
  /** Reports what is actually on screen, so the caller's hint can tell the truth. */
  onShown?: (info: { count: number; local: boolean; depth: number; hidden: number }) => void;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<string | null>(null);
  const highlightRef = useRef(highlightIds);
  highlightRef.current = highlightIds;
  const focusRef = useRef(focusId ?? null);
  focusRef.current = focusId ?? null;
  const spotRef = useRef(spotlight ?? null);
  spotRef.current = spotlight ?? null;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const redrawRef = useRef<(() => void) | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);

  const [hovered, setHovered] = useState<{ title: string; folder: string; description: string } | null>(null);
  const [settings, setSettings] = useState<GraphSettings>(loadSettings);
  const [panelOpen, setPanelOpen] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const set = <K extends keyof GraphSettings>(k: K, v: GraphSettings[K]) =>
    setSettings((s) => {
      const next = { ...s, [k]: v };
      localStorage.setItem("basalt-graph", JSON.stringify(next));
      return next;
    });

  /**
   * With the tag layer on, every #tag becomes a node and every note carrying it
   * gets an edge to it — which is what makes an Obsidian graph look so much
   * denser than a note-links-only one. Built here rather than server-side: the
   * tags already ride along with each node.
   */
  // Conversations leave the map unless asked for — and take their tags with them.
  const hiddenIds = useMemo(
    () => new Set(settings.conversations || !graph ? [] : graph.nodes.filter((n) => n.kind === "conversation").map((n) => n.id)),
    [graph, settings.conversations],
  );

  const tagged = useMemo(() => {
    if (!graph || !settings.tags) return graph;
    const used = new Map<string, number>();
    for (const n of graph.nodes) if (!hiddenIds.has(n.id)) for (const t of new Set(n.tags ?? [])) used.set(t, (used.get(t) ?? 0) + 1);
    const nodes = [...graph.nodes];
    const edges = [...graph.edges];
    for (const [tag, count] of used) {
      nodes.push({
        id: TAG_PREFIX + tag,
        title: `#${tag}`,
        folder: "",
        sector: null,
        tags: [],
        kind: "note",
        links: count,
        tasks: 0,
        description: `${count} note${count === 1 ? "" : "s"} tagged #${tag}`,
      });
    }
    for (const n of graph.nodes) if (!hiddenIds.has(n.id)) for (const t of new Set(n.tags ?? [])) edges.push({ from: n.id, to: TAG_PREFIX + t });
    return { nodes, edges };
  }, [graph, settings.tags, hiddenIds]);

  // In local mode the node set itself shrinks to the open note's neighbourhood.
  const shownIds = useMemo(() => {
    const tagIds = settings.tags && tagged ? tagged.nodes.filter((n) => n.id.startsWith(TAG_PREFIX)).map((n) => n.id) : [];
    const ids = [...visibleIds].filter((id) => !hiddenIds.has(id)).concat(tagIds);
    if (!tagged || !settings.local || !focusId) return new Set(ids);
    const near = neighbourhood(tagged.edges, focusId, settings.depth);
    return new Set(ids.filter((id) => near.has(id)));
  }, [tagged, visibleIds, hiddenIds, settings.local, settings.depth, settings.tags, focusId]);

  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useEffect(() => {
    // Notes only (tag nodes are not notes), and how many conversations the map leaves out.
    const notes = [...shownIds].filter((id) => !id.startsWith(TAG_PREFIX)).length;
    onShownRef.current?.({ count: notes, local: settings.local && !!focusId, depth: settings.depth, hidden: hiddenIds.size });
  }, [shownIds, hiddenIds, settings.local, settings.depth, focusId]);

  // Rebuild the simulation only when the actual set of nodes/edges changes —
  // not on every unrelated re-render (highlight/force tweaks just redraw).
  const graphKey = tagged
    ? tagged.nodes
        .filter((n) => shownIds.has(n.id))
        .map((n) => n.id)
        .sort()
        .join(",") +
      "|" +
      tagged.edges.length
    : "";

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !tagged) return;
    const ctx = canvas.getContext("2d")!;
    const parent = canvas.parentElement!;

    const shown = tagged.nodes.filter((n) => shownIds.has(n.id));
    const ids = new Set(shown.map((n) => n.id));
    const edges = tagged.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }

    const nodes: SimNode[] = shown.map((n) => {
      const prev = savedPos.get(n.id);
      const deg = degree.get(n.id) ?? 0;
      return {
        id: n.id,
        title: n.title,
        folder: n.folder,
        description: n.description ?? "",
        deg,
        // sqrt so a hub reads as bigger without swallowing the screen
        r: 3 + Math.sqrt(deg) * 1.9,
        x: prev?.x ?? (Math.random() - 0.5) * 600,
        y: prev?.y ?? (Math.random() - 0.5) * 600,
        vx: 0,
        vy: 0,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = edges.map((e) => ({ source: byId.get(e.from)!, target: byId.get(e.to)! }));

    let w = parent.clientWidth;
    let h = parent.clientHeight;

    const sim: Simulation<SimNode, SimLink> = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((n) => n.id)
          .distance(settings.linkDistance)
          .strength(0.3),
      )
      .force("charge", forceManyBody<SimNode>().strength(-settings.repel).distanceMax(420))
      .force("collide", forceCollide<SimNode>((n) => n.r + 4).strength(0.95))
      .force("center", forceCenter(0, 0).strength(0.08))
      .force("x", forceX(0).strength(settings.center))
      .force("y", forceY(0).strength(settings.center))
      .velocityDecay(0.4)
      .alphaDecay(0.025);
    simRef.current = sim;

    if (!savedView.inited) {
      savedView.x = w / 2;
      savedView.y = h / 2;
      savedView.inited = true;
    }

    const project = (n: { x: number; y: number }) => ({
      sx: n.x * savedView.k + savedView.x,
      sy: n.y * savedView.k + savedView.y,
    });
    const toGraph = (cx: number, cy: number) => ({
      x: (cx - savedView.x) / savedView.k,
      y: (cy - savedView.y) / savedView.k,
    });

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      w = parent.clientWidth;
      h = parent.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const styles = getComputedStyle(document.documentElement);
      const lineColor = styles.getPropertyValue("--text-faint").trim() || "#888";
      const nodeColor = styles.getPropertyValue("--text-dim").trim() || "#888";
      const labelColor = styles.getPropertyValue("--text-dim").trim() || "#999";
      const accent = styles.getPropertyValue("--accent").trim() || "#5b51dd";
      const textColor = styles.getPropertyValue("--text").trim() || "#111";
      const font = styles.getPropertyValue("--font-ui") || "sans-serif";
      const k = savedView.k;
      const scale = settings.nodeScale;

      const hover = hoverRef.current;
      const focus = focusRef.current;
      const spot = spotRef.current;
      const spotted = (id: string) => spot !== null && spot.ids.has(id);
      const highlight = highlightRef.current;
      const lit = (id: string) => highlight === null || highlight.has(id);
      const neighbors = new Set<string>();
      if (hover) {
        for (const l of links) {
          if (l.source.id === hover) neighbors.add(l.target.id);
          if (l.target.id === hover) neighbors.add(l.source.id);
        }
      }

      // edges
      for (const l of links) {
        const a = project(l.source);
        const b = project(l.target);
        const inSpot = spotted(l.source.id) || spotted(l.target.id);
        const hot = hover === l.source.id || hover === l.target.id || inSpot;
        const faded = !lit(l.source.id) && !lit(l.target.id);
        ctx.strokeStyle = hot ? accent : lineColor;
        ctx.globalAlpha = hot ? 0.55 : faded ? 0.05 : hover || spot ? 0.07 : 0.18;
        ctx.lineWidth = hot ? 1.3 : 1;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }

      // nodes — one ink, size is the only signal
      for (const n of nodes) {
        const p = project(n);
        const isHover = n.id === hover;
        const isFocus = n.id === focus;
        const isNeighbor = neighbors.has(n.id);
        const isLit = lit(n.id);
        const isSpot = spotted(n.id);
        const dimmed = spot ? !isSpot : hover ? !isHover && !isNeighbor : !isLit;
        const rr = Math.max(n.r * scale * k * (isHover || isSpot ? 1.3 : 1), 1.6);
        ctx.globalAlpha = isHover || isFocus || isSpot ? 1 : dimmed ? (isLit ? 0.22 : 0.08) : 0.8;
        ctx.fillStyle = isHover || isFocus || isSpot ? accent : nodeColor;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, rr, 0, Math.PI * 2);
        ctx.fill();
      }

      // labels — nothing at a glance, the hovered node and its neighbours
      // always, and everything (lit) once you zoom in to read.
      const showAll = k >= 1.6;
      ctx.font = `500 11px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const isHover = n.id === hover;
        const isFocus = n.id === focus;
        const isNeighbor = neighbors.has(n.id);
        // Only what you are pointing at gets a label — a neighbourhood of labels
        // is the thing that made this unreadable. Zoom in for the rest.
        const show = isHover || isFocus || (!hover && showAll && lit(n.id));
        if (!show) continue;
        const p = project(n);
        ctx.globalAlpha = isHover || isFocus ? 1 : 0.7;
        ctx.fillStyle = isHover || isFocus ? textColor : labelColor;
        const label = n.title.length > 26 ? n.title.slice(0, 25) + "…" : n.title;
        const rr = Math.max(n.r * scale * k * (isHover ? 1.3 : 1), 1.6);
        ctx.fillText(label, p.sx, p.sy + rr + 3);
      }
      ctx.globalAlpha = 1;
    };

    sim.on("tick", () => {
      for (const n of nodes) savedPos.set(n.id, { x: n.x, y: n.y });
      draw();
    });
    redrawRef.current = draw;

    // ---- interaction ----
    let dragNode: SimNode | null = null;
    let panning = false;
    let moved = false;
    let downX = 0;
    let downY = 0;
    let startView = { x: 0, y: 0 };

    const cssPos = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
    };
    const hitTest = (cx: number, cy: number): SimNode | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!;
        const p = project(n);
        const rr = Math.max(n.r * settings.nodeScale * savedView.k, 2) + 5;
        if ((p.sx - cx) ** 2 + (p.sy - cy) ** 2 <= rr * rr) return n;
      }
      return null;
    };

    const onDown = (e: PointerEvent) => {
      const { cx, cy } = cssPos(e);
      downX = cx;
      downY = cy;
      moved = false;
      const hit = hitTest(cx, cy);
      canvas.setPointerCapture(e.pointerId);
      if (hit) {
        dragNode = hit;
        const g = toGraph(cx, cy);
        dragNode.fx = g.x;
        dragNode.fy = g.y;
        sim.alphaTarget(0.3).restart();
      } else {
        panning = true;
        startView = { x: savedView.x, y: savedView.y };
      }
    };
    const onMove = (e: PointerEvent) => {
      const { cx, cy } = cssPos(e);
      if (!dragNode && !panning) {
        const hit = hitTest(cx, cy);
        const id = hit?.id ?? null;
        if (id !== hoverRef.current) {
          hoverRef.current = id;
          canvas.style.cursor = id ? "pointer" : "grab";
          setHovered(hit ? { title: hit.title, folder: hit.folder, description: hit.description } : null);
          draw();
        }
        return;
      }
      if ((cx - downX) ** 2 + (cy - downY) ** 2 > 16) moved = true;
      if (dragNode) {
        const g = toGraph(cx, cy);
        dragNode.fx = g.x;
        dragNode.fy = g.y;
      } else if (panning) {
        savedView.x = startView.x + (cx - downX);
        savedView.y = startView.y + (cy - downY);
        draw();
      }
    };
    const onUp = (e: PointerEvent) => {
      const { cx, cy } = cssPos(e);
      if (dragNode) {
        if (!moved && !dragNode.id.startsWith(TAG_PREFIX)) onOpenRef.current(dragNode.id);
        dragNode.fx = null;
        dragNode.fy = null;
        sim.alphaTarget(0);
        dragNode = null;
      } else if (panning) {
        panning = false;
        if (!moved) {
          const hit = hitTest(cx, cy);
          if (hit && !hit.id.startsWith(TAG_PREFIX)) onOpenRef.current(hit.id);
        }
      }
    };
    /** Zoom by `factor`, keeping the point under (cx, cy) where it is. */
    const zoomAt = (cx: number, cy: number, factor: number) => {
      const k2 = Math.max(0.2, Math.min(4, savedView.k * factor));
      const gx = (cx - savedView.x) / savedView.k;
      const gy = (cy - savedView.y) / savedView.k;
      savedView.k = k2;
      savedView.x = cx - gx * k2;
      savedView.y = cy - gy * k2;
      draw();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { cx, cy } = cssPos(e);
      // Smooth proportional zoom based on scroll magnitude.
      // Math.exp gives a perfectly linear zoom feel regardless of current scale.
      zoomAt(cx, cy, Math.exp(-e.deltaY * 0.0015));
    };

    // ---- keyboard: the cursor is the hover, moved by arrows ----
    const point = (n: SimNode | null) => {
      hoverRef.current = n?.id ?? null;
      setHovered(n ? { title: n.title, folder: n.folder, description: n.description } : null);
      if (n) {
        // Keep it on screen: pan just enough to bring it inside a margin.
        const { sx, sy } = project(n);
        const m = 48;
        if (sx < m) savedView.x += m - sx;
        else if (sx > w - m) savedView.x -= sx - (w - m);
        if (sy < m) savedView.y += m - sy;
        else if (sy > h - m) savedView.y -= sy - (h - m);
      }
      draw();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const current = hoverRef.current ? (byId.get(hoverRef.current) ?? null) : null;
      const dir = ARROWS[e.key];
      if (dir) {
        e.preventDefault();
        if (!current) {
          // Start from the open note, else the one nearest the middle of the view.
          const centre = toGraph(w / 2, h / 2);
          const start =
            (focusRef.current ? byId.get(focusRef.current) : undefined) ??
            nodes.reduce<SimNode | null>(
              (best, n) =>
                !best || (n.x - centre.x) ** 2 + (n.y - centre.y) ** 2 < (best.x - centre.x) ** 2 + (best.y - centre.y) ** 2 ? n : best,
              null,
            );
          point(start);
        } else {
          point(nearestInDirection(current, nodes, dir) ?? current);
        }
      } else if ((e.key === "Enter" || e.key === " ") && current) {
        e.preventDefault();
        if (!current.id.startsWith(TAG_PREFIX)) onOpenRef.current(current.id);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAt(w / 2, h / 2, 1.25);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAt(w / 2, h / 2, 1 / 1.25);
      } else if (e.key === "Escape" && current) {
        // Let go of the cursor; a second Esc reaches the page (closes the note).
        e.stopPropagation();
        point(null);
      }
    };
    const onBlur = () => {
      setKeyboard(false);
      if (hoverRef.current) point(null);
    };
    // Only for keyboard focus: a click focuses the canvas too, and needs no hint.
    const onFocus = () => setKeyboard(canvas.matches(":focus-visible"));

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKeyDown);
    canvas.addEventListener("focus", onFocus);
    canvas.addEventListener("blur", onBlur);
    const ro = new ResizeObserver(draw);
    ro.observe(parent);

    return () => {
      sim.stop();
      simRef.current = null;
      redrawRef.current = null;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("focus", onFocus);
      canvas.removeEventListener("blur", onBlur);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  // Force tweaks retune the running simulation instead of rebuilding it, so the
  // layout breathes into its new shape rather than scattering.
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    (sim.force("link") as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined)?.distance(settings.linkDistance);
    (sim.force("charge") as ReturnType<typeof forceManyBody<SimNode>> | undefined)?.strength(-settings.repel);
    (sim.force("x") as ReturnType<typeof forceX<SimNode>> | undefined)?.strength(settings.center);
    (sim.force("y") as ReturnType<typeof forceY<SimNode>> | undefined)?.strength(settings.center);
    sim.alpha(0.5).restart();
  }, [settings.linkDistance, settings.repel, settings.center]);

  // Filter fade and node-size changes are pure repaints.
  useEffect(() => {
    redrawRef.current?.();
  }, [highlightIds, focusId, spotlight, settings.nodeScale]);

  // A one-file spotlight reads like a hover: folder and gist, not a count.
  const spotOne =
    spotlight && spotlight.ids.size === 1
      ? tagged?.nodes.find((n) => spotlight.ids.has(n.id))
      : undefined;

  return (
    <>
      <canvas
        className="graph-canvas"
        ref={ref}
        tabIndex={0}
        role="application"
        aria-roledescription="note map"
        aria-label="Note map. Arrow keys move between notes, Enter opens one, plus and minus zoom, Escape lets go."
      />
      {spotlight && !hovered ? (
        <div className="graph-readout" aria-live="polite">
          <b>{spotlight.label}</b>
          <code>
            {spotOne ? spotOne.folder || "/" : `${spotlight.ids.size} notes on the map`}
          </code>
          {spotOne?.description && <p>{spotOne.description}</p>}
        </div>
      ) : (
        hovered ? (
          <div className="graph-readout" aria-live="polite">
            <b>{hovered.title}</b>
            {hovered.folder && <code>{hovered.folder}</code>}
            {hovered.description && <p>{hovered.description}</p>}
          </div>
        ) : (
          keyboard && (
            <div className="graph-readout">
              <b>Keyboard</b>
              <p>Arrows move between notes · Enter opens · + − zoom · Esc lets go</p>
            </div>
          )
        )
      )}
      <div className={`graph-ui ${panelOpen ? "open" : ""}`}>
        <button className="graph-gear" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen} aria-label="Graph settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
        </button>
        {panelOpen && (
          <div className="graph-panel">
            <label className="graph-row switch">
              <span>Local graph</span>
              <input
                type="checkbox"
                checked={settings.local}
                disabled={!focusId}
                onChange={(e) => set("local", e.target.checked)}
              />
            </label>
            {!focusId && <p className="graph-note">Open a note to use the local graph.</p>}
            {settings.local && focusId && (
              <label className="graph-row">
                <span>Depth</span>
                <input type="range" min={1} max={4} step={1} value={settings.depth} onChange={(e) => set("depth", +e.target.value)} />
                <b>{settings.depth}</b>
              </label>
            )}
            <label className="graph-row switch">
              <span>Tags as nodes</span>
              <input type="checkbox" checked={settings.tags} onChange={(e) => set("tags", e.target.checked)} />
            </label>
            <label className="graph-row switch">
              <span>Conversations</span>
              <input type="checkbox" checked={settings.conversations} onChange={(e) => set("conversations", e.target.checked)} />
            </label>
            <hr />
            <label className="graph-row">
              <span>Link distance</span>
              <input type="range" min={15} max={120} value={settings.linkDistance} onChange={(e) => set("linkDistance", +e.target.value)} />
              <b>{settings.linkDistance}</b>
            </label>
            <label className="graph-row">
              <span>Repel force</span>
              <input type="range" min={20} max={400} value={settings.repel} onChange={(e) => set("repel", +e.target.value)} />
              <b>{settings.repel}</b>
            </label>
            <label className="graph-row">
              <span>Center pull</span>
              <input type="range" min={0} max={40} value={Math.round(settings.center * 100)} onChange={(e) => set("center", +e.target.value / 100)} />
              <b>{settings.center.toFixed(2)}</b>
            </label>
            <label className="graph-row">
              <span>Node size</span>
              <input type="range" min={50} max={250} value={Math.round(settings.nodeScale * 100)} onChange={(e) => set("nodeScale", +e.target.value / 100)} />
              <b>{settings.nodeScale.toFixed(1)}×</b>
            </label>
            <button
              className="graph-reset"
              onClick={() => {
                localStorage.setItem("basalt-graph", JSON.stringify(DEFAULTS));
                setSettings({ ...DEFAULTS });
              }}
            >
              Reset
            </button>
          </div>
        )}
      </div>
    </>
  );
}
