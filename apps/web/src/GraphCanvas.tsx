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
import { useEffect, useRef } from "react";

export interface GraphData {
  nodes: { id: string; title: string; folder: string; links: number; tasks: number }[];
  edges: { from: string; to: string }[];
}

interface SimNode {
  id: string;
  title: string;
  color: string;
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

/** Layout + view persist across note open/close so the map never re-scatters. */
const savedPos = new Map<string, { x: number; y: number }>();
const savedView = { x: 0, y: 0, k: 1, inited: false };

/**
 * The map: a live force-directed graph, the way Obsidian does it. Nodes repel
 * and collide (so they never stack), links pull like springs, and you can grab
 * any node and drag it — the rest of the web reacts. Wheel to zoom, drag the
 * background to pan, hover to light up a node's neighbourhood, click to open.
 * Colour comes from the shared category palette, so a note is the same colour
 * here as in the file list. Canvas (not SVG/WebGL) because at hundreds of nodes
 * it stays smooth and the 2-D interaction model is exactly what this needs.
 */
export function GraphCanvas({
  graph,
  visibleIds,
  highlightIds,
  colorForId,
  onOpen,
}: {
  graph: GraphData | null;
  visibleIds: Set<string>;
  highlightIds: Set<string> | null;
  colorForId: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<string | null>(null);
  const highlightRef = useRef(highlightIds);
  highlightRef.current = highlightIds;
  const colorRef = useRef(colorForId);
  colorRef.current = colorForId;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const redrawRef = useRef<(() => void) | null>(null);
  const recolorRef = useRef<(() => void) | null>(null);

  // Rebuild the simulation only when the actual set of nodes/edges changes —
  // not on every unrelated re-render (colour/highlight updates just redraw).
  const graphKey = graph
    ? graph.nodes
        .filter((n) => visibleIds.has(n.id))
        .map((n) => n.id)
        .sort()
        .join(",") +
      "|" +
      graph.edges.length
    : "";

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !graph) return;
    const ctx = canvas.getContext("2d")!;
    const parent = canvas.parentElement!;

    const nodes: SimNode[] = graph.nodes
      .filter((n) => visibleIds.has(n.id))
      .map((n) => {
        const prev = savedPos.get(n.id);
        return {
          id: n.id,
          title: n.title,
          color: colorRef.current(n.id),
          r: Math.min(4 + n.links * 1.1, 12),
          x: prev?.x ?? (Math.random() - 0.5) * 600,
          y: prev?.y ?? (Math.random() - 0.5) * 600,
          vx: 0,
          vy: 0,
        };
      });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = graph.edges
      .filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
      .map((e) => ({ source: byId.get(e.from)!, target: byId.get(e.to)! }));

    let w = parent.clientWidth;
    let h = parent.clientHeight;

    const sim: Simulation<SimNode, SimLink> = forceSimulation(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((n) => n.id)
          .distance(38)
          .strength(0.3),
      )
      .force("charge", forceManyBody<SimNode>().strength(-115).distanceMax(420))
      .force("collide", forceCollide<SimNode>((n) => n.r + 4).strength(0.95))
      .force("center", forceCenter(0, 0).strength(0.08))
      .force("x", forceX(0).strength(0.09))
      .force("y", forceY(0).strength(0.09))
      .velocityDecay(0.4)
      .alphaDecay(0.025);

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
      const lineColor = styles.getPropertyValue("--text-faint").trim() || "#555";
      const labelColor = styles.getPropertyValue("--text-dim").trim() || "#999";
      const font = styles.getPropertyValue("--font-ui") || "sans-serif";
      const k = savedView.k;

      const hover = hoverRef.current;
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
        const hot = hover === l.source.id || hover === l.target.id;
        const faded = !lit(l.source.id) && !lit(l.target.id);
        ctx.strokeStyle = hot ? "#ffffff" : lineColor;
        ctx.globalAlpha = hot ? 0.6 : faded ? 0.04 : hover ? 0.08 : 0.14;
        ctx.lineWidth = hot ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }

      // nodes
      for (const n of nodes) {
        const p = project(n);
        const isHover = n.id === hover;
        const isNeighbor = neighbors.has(n.id);
        const isLit = lit(n.id);
        const dimmed = hover ? !isHover && !isNeighbor : !isLit;
        // Scale the node up by 30% when hovered
        const rr = Math.max(n.r * k * (isHover ? 1.3 : 1), 2);
        ctx.globalAlpha = isHover ? 1 : dimmed ? (isLit ? 0.3 : 0.12) : 0.95;
        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, rr, 0, Math.PI * 2);
        ctx.fill();
      }

      // labels — Obsidian style: nothing at a glance, the hovered node and its
      // neighbours always, and everything (lit) once you zoom in to read.
      const showAll = k >= 1.3;
      ctx.font = `500 11px ${font}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const isHover = n.id === hover;
        const isNeighbor = neighbors.has(n.id);
        const show = isHover || isNeighbor || (!hover && showAll && (highlight === null || highlight.has(n.id)));
        if (!show) continue;
        const p = project(n);
        // Emphasize the text slightly via opacity rather than color change
        ctx.globalAlpha = isHover ? 1 : 0.75;
        ctx.fillStyle = labelColor;
        const label = n.title.length > 26 ? n.title.slice(0, 25) + "…" : n.title;
        // Adjust the Y offset using the same hover scale factor
        const rr = Math.max(n.r * k * (isHover ? 1.3 : 1), 2);
        ctx.fillText(label, p.sx, p.sy + rr + 3);
      }
      ctx.globalAlpha = 1;
    };

    sim.on("tick", () => {
      for (const n of nodes) savedPos.set(n.id, { x: n.x, y: n.y });
      draw();
    });
    redrawRef.current = draw;
    recolorRef.current = () => {
      for (const n of nodes) n.color = colorRef.current(n.id);
      draw();
    };

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
        const rr = Math.max(n.r * savedView.k, 2) + 5;
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
        if (!moved) onOpenRef.current(dragNode.id);
        dragNode.fx = null;
        dragNode.fy = null;
        sim.alphaTarget(0);
        dragNode = null;
      } else if (panning) {
        panning = false;
        if (!moved) {
          const hit = hitTest(cx, cy);
          if (hit) onOpenRef.current(hit.id);
        }
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { cx, cy } = cssPos(e);
      
      // Smooth proportional zoom based on scroll magnitude. 
      // Math.exp gives a perfectly linear zoom feel regardless of current scale.
      const scaleMultiplier = Math.exp(-e.deltaY * 0.0015);
      const k2 = Math.max(0.2, Math.min(4, savedView.k * scaleMultiplier));
      
      const gx = (cx - savedView.x) / savedView.k;
      const gy = (cy - savedView.y) / savedView.k;
      savedView.k = k2;
      savedView.x = cx - gx * k2;
      savedView.y = cy - gy * k2;
      draw();
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(draw);
    ro.observe(parent);

    return () => {
      sim.stop();
      redrawRef.current = null;
      recolorRef.current = null;
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphKey]);

  // Category filter → repaint (fade); palette change → recolour. No sim rebuild.
  useEffect(() => {
    redrawRef.current?.();
  }, [highlightIds]);
  useEffect(() => {
    recolorRef.current?.();
  }, [colorForId]);

  return <canvas className="graph-canvas" ref={ref} />;
}
