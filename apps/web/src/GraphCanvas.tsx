import { useEffect, useRef } from "react";

export interface GraphData {
  nodes: { id: string; title: string; folder: string; links: number; tasks: number }[];
  edges: { from: string; to: string }[];
}

/* Folder group colors — the same language as Jules's Obsidian graph. */
const GROUP_COLORS = ["#4a9eff", "#e5383b", "#f5a623", "#a855f7", "#2dd4bf", "#8888aa"];

interface LaidNode {
  id: string;
  title: string;
  folder: string;
  x: number;
  y: number;
  r: number;
  color: string;
}

/**
 * The map. Full-canvas link graph in the style of the owner's Obsidian graph:
 * near-black ground, muted nodes colored by top-level folder, quiet labels,
 * white highlight on hover, click to open. Static seeded layout — a map,
 * not a simulation.
 */
export function GraphCanvas({
  graph,
  visibleIds,
  onOpen,
}: {
  graph: GraphData | null;
  visibleIds: Set<string>;
  onOpen: (id: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<LaidNode[]>([]);
  const hoverRef = useRef<string | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !graph) return;
    const ctx = canvas.getContext("2d")!;

    const layout = (): void => {
      const parent = canvas.parentElement!;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const nodes = graph.nodes.filter((n) => visibleIds.has(n.id));
      const groups = [...new Set(nodes.map((n) => topFolder(n.folder)))].sort();
      const groupColor = new Map(groups.map((g, i) => [g, GROUP_COLORS[i % GROUP_COLORS.length]!]));

      // Cluster anchors on a loose ring, then seeded scatter + link relaxation.
      const anchor = new Map<string, { x: number; y: number }>();
      groups.forEach((g, i) => {
        const a = (i / Math.max(groups.length, 1)) * Math.PI * 2 - Math.PI / 2;
        anchor.set(g, { x: w / 2 + Math.cos(a) * w * 0.24, y: h / 2 + Math.sin(a) * h * 0.24 });
      });
      const pos = new Map<string, { x: number; y: number }>();
      for (const n of nodes) {
        const a = anchor.get(topFolder(n.folder))!;
        pos.set(n.id, {
          x: a.x + (seeded(n.id, 7) - 0.5) * w * 0.3,
          y: a.y + (seeded(n.id, 13) - 0.5) * h * 0.3,
        });
      }
      const shown = new Set(nodes.map((n) => n.id));
      const edges = graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
      for (let pass = 0; pass < 4; pass++) {
        for (const e of edges) {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          a.x += (mx - a.x) * 0.16;
          a.y += (my - a.y) * 0.16;
          b.x += (mx - b.x) * 0.16;
          b.y += (my - b.y) * 0.16;
        }
        // gentle repulsion so relaxed nodes don't stack
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = pos.get(nodes[i]!.id)!;
            const b = pos.get(nodes[j]!.id)!;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 3600 && d2 > 0) {
              const d = Math.sqrt(d2);
              const push = (60 - d) / d / 2;
              a.x -= dx * push;
              a.y -= dy * push;
              b.x += dx * push;
              b.y += dy * push;
            }
          }
        }
      }
      const pad = 50;
      nodesRef.current = nodes.map((n) => {
        const p = pos.get(n.id)!;
        return {
          id: n.id,
          title: n.title,
          folder: n.folder,
          x: Math.max(pad, Math.min(w - pad, p.x)),
          y: Math.max(pad, Math.min(h - pad, p.y)),
          r: Math.min(4 + n.links * 1.1, 11),
          color: groupColor.get(topFolder(n.folder))!,
        };
      });
    };

    const draw = (): void => {
      const parent = canvas.parentElement!;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const styles = getComputedStyle(document.documentElement);
      const labelColor = styles.getPropertyValue("--text-dim").trim();
      const lineColor = styles.getPropertyValue("--text-faint").trim();

      const nodes = nodesRef.current;
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const hover = hoverRef.current;
      const neighbors = new Set<string>();
      if (hover && graph) {
        for (const e of graph.edges) {
          if (e.from === hover) neighbors.add(e.to);
          if (e.to === hover) neighbors.add(e.from);
        }
      }

      for (const e of graph!.edges) {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) continue;
        const hot = hover === e.from || hover === e.to;
        ctx.strokeStyle = hot ? "#ffffff" : lineColor;
        ctx.globalAlpha = hot ? 0.7 : 0.18;
        ctx.lineWidth = hot ? 1.2 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        const isHover = n.id === hover;
        const isNeighbor = neighbors.has(n.id);
        const dimmed = hover !== null && !isHover && !isNeighbor;
        ctx.globalAlpha = dimmed ? 0.25 : 0.95;
        ctx.fillStyle = isHover ? "#ffffff" : n.color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + (isHover ? 2 : 0), 0, Math.PI * 2);
        ctx.fill();

        // Labels: always for hover+neighbors and well-linked notes, quiet otherwise.
        if (isHover || isNeighbor || n.r >= 6) {
          ctx.globalAlpha = dimmed ? 0.2 : isHover ? 1 : 0.75;
          ctx.fillStyle = isHover ? "#ffffff" : labelColor;
          ctx.font = `${isHover ? 600 : 400} 11px ${styles.getPropertyValue("--font-ui")}`;
          ctx.textAlign = "center";
          ctx.fillText(n.title, n.x, n.y + n.r + 14);
        }
      }
      ctx.globalAlpha = 1;
    };

    const relayout = () => {
      layout();
      draw();
    };
    relayout();

    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      let hit: string | null = null;
      for (const n of nodesRef.current) {
        const dx = n.x - mx;
        const dy = n.y - my;
        if (dx * dx + dy * dy <= (n.r + 6) * (n.r + 6)) {
          hit = n.id;
          break;
        }
      }
      if (hit !== hoverRef.current) {
        hoverRef.current = hit;
        canvas.style.cursor = hit ? "pointer" : "default";
        draw();
      }
    };
    const onClick = () => {
      if (hoverRef.current) onOpen(hoverRef.current);
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    const ro = new ResizeObserver(relayout);
    ro.observe(canvas.parentElement!);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
      ro.disconnect();
    };
  }, [graph, visibleIds, onOpen]);

  return <canvas className="graph-canvas" ref={ref} />;
}

function topFolder(folder: string): string {
  return folder.split("/")[0] || "(root)";
}

function seeded(s: string, salt: number): number {
  let x = salt;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 233280;
  return x / 233280;
}
