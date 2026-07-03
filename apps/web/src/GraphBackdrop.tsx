import { useEffect, useRef } from "react";

export interface GraphData {
  nodes: { id: string; title: string; folder: string; links: number; tasks: number }[];
  edges: { from: string; to: string }[];
}

/**
 * The vault's link graph as a quiet constellation behind the file list. Notes
 * cluster by folder; linked notes pull toward each other; the open note glows.
 * Deterministic (seeded by ids) so the sky doesn't reshuffle on every render,
 * and static — no drifting particles, no parallax. It's a map, not a screensaver.
 */
export function GraphBackdrop({
  graph,
  visibleIds,
  activeId,
}: {
  graph: GraphData | null;
  visibleIds: Set<string>;
  activeId: string | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !graph) return;

    const draw = () => {
      const parent = canvas.parentElement!;
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const styles = getComputedStyle(document.documentElement);
      const accent = styles.getPropertyValue("--accent").trim() || "#22d3ee";
      const faint = styles.getPropertyValue("--text-faint").trim() || "#5c6470";

      const nodes = graph.nodes.filter((n) => visibleIds.has(n.id));
      if (nodes.length === 0) return;

      // Folder → cluster anchor; node position = anchor + seeded scatter,
      // then a few relaxation passes pulling linked nodes together.
      const folders = [...new Set(nodes.map((n) => n.folder))].sort();
      const anchor = new Map<string, { x: number; y: number }>();
      folders.forEach((f, i) => {
        const gx = (i % 2) * 0.5 + 0.28;
        const gy = (Math.floor(i / 2) + 0.5) / (Math.ceil(folders.length / 2) + 0.2);
        anchor.set(f, { x: gx * w, y: gy * h });
      });
      const seeded = (s: string, salt: number) => {
        let x = salt;
        for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 233280;
        return x / 233280;
      };
      const pos = new Map<string, { x: number; y: number }>();
      for (const n of nodes) {
        const a = anchor.get(n.folder)!;
        pos.set(n.id, {
          x: a.x + (seeded(n.id, 7) - 0.5) * w * 0.34,
          y: a.y + (seeded(n.id, 13) - 0.5) * h * 0.22,
        });
      }
      const shown = new Set(nodes.map((n) => n.id));
      const edges = graph.edges.filter((e) => shown.has(e.from) && shown.has(e.to));
      for (let pass = 0; pass < 3; pass++) {
        for (const e of edges) {
          const a = pos.get(e.from)!;
          const b = pos.get(e.to)!;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          a.x += (mx - a.x) * 0.18;
          a.y += (my - a.y) * 0.18;
          b.x += (mx - b.x) * 0.18;
          b.y += (my - b.y) * 0.18;
        }
      }
      const pad = 24;
      for (const p of pos.values()) {
        p.x = Math.max(pad, Math.min(w - pad, p.x));
        p.y = Math.max(pad, Math.min(h - pad, p.y));
      }

      ctx.lineWidth = 1;
      for (const e of edges) {
        const a = pos.get(e.from)!;
        const b = pos.get(e.to)!;
        const active = e.from === activeId || e.to === activeId;
        ctx.strokeStyle = active ? accent : faint;
        ctx.globalAlpha = active ? 0.35 : 0.12;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        const p = pos.get(n.id)!;
        const active = n.id === activeId;
        const r = Math.min(2 + n.links * 0.6, 5) + (active ? 1.5 : 0);
        ctx.globalAlpha = active ? 0.9 : 0.28;
        ctx.fillStyle = active ? accent : faint;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas.parentElement!);
    return () => ro.disconnect();
  }, [graph, visibleIds, activeId]);

  return <canvas className="graph-backdrop" ref={ref} aria-hidden />;
}
