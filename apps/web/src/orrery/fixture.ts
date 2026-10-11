/**
 * A small fictional vault in the shapes the server sends (/api/vault/graph, /api/vault/tree,
 * /api/projects), for the Orrery's tests. The names are the mockups' fictional ones.
 */
import type { GraphData, TreeNote } from "@basalt/schema/responses";
import type { ProjectRow } from "./model.js";

type GNode = GraphData["nodes"][number];
type GEdge = GraphData["edges"][number];

export interface Fixture {
  graph: GraphData;
  tree: TreeNote[];
  projects: ProjectRow[];
}

const DAY = 86_400_000;
export const NOW = Date.UTC(2026, 9, 11, 12);

export function fixture(opts: { extraNotes?: number; extraLinks?: number } = {}): Fixture {
  const nodes: GNode[] = [];
  const tree: TreeNote[] = [];
  const add = (id: string, path: string, title: string, category: string, o: { tags?: string[]; kind?: "note" | "conversation"; description?: string; days?: number } = {}) => {
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    nodes.push({ id, title, folder, sector: null, tags: o.tags ?? [], links: 0, tasks: 0, kind: o.kind ?? "note", description: o.description ?? "" });
    tree.push({ id, path, folder, title, hash: id, mtimeMs: NOW - (o.days ?? 3) * DAY, tags: o.tags ?? [], openTasks: 0, category });
  };
  add("p-kade", "04-Projects/kade-social-report.md", "Kade Social report", "work", { tags: ["project", "project/kade-social-report"], description: "The monthly social report for Kade." });
  add("p-thesis", "04-Projects/graduation-thesis.md", "Graduation thesis", "school", { tags: ["project", "project/graduation-thesis"] });
  add("ines", "Contacts/Ines Vermaat.md", "Ines Vermaat", "work", { tags: ["contact"] });
  add("thijs", "Contacts/Thijs Brouwer.md", "Thijs Brouwer", "school", { tags: ["contact"] });
  add("kade", "Contacts/Companies/Kade Social.md", "Kade Social", "work", { tags: ["company"] });
  add("n-brief", "Work/Kade Social/Campaign brief.md", "Campaign brief", "work", { tags: ["project/kade-social-report"] });
  add("n-kpi", "Work/Kade Social/Reports/KPI review.md", "KPI review", "work", { tags: ["project/kade-social-report"] });
  add("n-call", "Work/Kade Social/Weekly call.md", "Weekly call", "work");
  add("n-arima", "03-Knowledge/Forecasting/ARIMA vs ETS.md", "ARIMA vs ETS", "knowledge");
  add("n-mase", "03-Knowledge/Forecasting/MASE vs MAPE.md", "MASE vs MAPE", "knowledge");
  add("n-long", "Life/Running/Long run.md", "Long run", "personal", { days: 40 });
  add("n-loose", "Welcome.md", "Welcome", "nowhere");
  add("c-kpi", "Conversations/Checking the KPI review.md", "Checking the KPI review", "tools", { kind: "conversation" });
  add("r-week", "Reviews/Weekly review 2026-W40.md", "Weekly review 2026-W40", "personal");
  add("t-meet", "Templates/Template- meeting.md", "Template: meeting", "tools");
  add("t-tag", "Work/Notes on templates.md", "Notes on templates", "work", { tags: ["template"] });
  const edges: GEdge[] = [
    { from: "ines", to: "kade", relation: "works_at", implied: true },
    { from: "p-kade", to: "ines", relation: "involves" },
    { from: "p-kade", to: "kade", relation: "involves" },
    { from: "n-brief", to: "p-kade", relation: "part_of", implied: true },
    { from: "n-kpi", to: "p-kade", relation: "part_of", implied: true },
    { from: "n-brief", to: "n-kpi" },
    { from: "n-kpi", to: "n-brief" }, // the same pair again, the other way: one edge
    { from: "n-call", to: "ines" },
    { from: "ines", to: "n-call", relation: "attends" }, // a relation the ontology adds later
    { from: "c-kpi", to: "p-kade", relation: "about", implied: true },
    { from: "thijs", to: "p-thesis", relation: "supervises", implied: true },
    { from: "n-arima", to: "n-mase" },
    { from: "r-week", to: "p-kade" },
    { from: "n-call", to: "n-call" }, // a self-link: dropped
  ];
  for (let k = 0; k < (opts.extraNotes ?? 0); k++) add(`x${k}`, `03-Knowledge/Forecasting/Extra ${k}.md`, `Extra ${k}`, "knowledge");
  for (let k = 0; k < (opts.extraLinks ?? 0); k++) {
    const n = opts.extraNotes ?? 0;
    if (n < 2) break;
    edges.push({ from: `x${k % n}`, to: `x${(k + 1 + Math.floor(k / n)) % n}` });
  }
  const projects: ProjectRow[] = [
    { slug: "kade-social-report", noteId: "p-kade", status: "on-track", done: 3, total: 8 },
    { slug: "graduation-thesis", noteId: "p-thesis", status: "paused", done: 0, total: 0 },
    { slug: "gone", noteId: null, status: null, done: 0, total: 0 },
  ];
  return { graph: { nodes, edges }, tree, projects };
}
