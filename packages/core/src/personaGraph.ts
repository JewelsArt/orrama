/**
 * The persona's links and timeline (ME): what each thing on the Me page connects to, and where
 * each place sits on the story. Pure, over a persona already read (persona.ts parsePersona), so
 * the web app imports this alone (`@orrama/core/persona-graph`) without the note parser.
 */
import type { Persona } from "./persona.js";

/** A month as one number, `year * 12 + (month - 1)`: comparable, and easy to lay out. */
export type Month = number;
export const monthOf = (year: number, month: number): Month => year * 12 + (month - 1);
export const yearOfMonth = (m: Month) => Math.floor(m / 12);

export interface Period {
  start: Month;
  /** The last month it covers; null while it goes on ("– now"). */
  end: Month | null;
}

const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[★*]/g, "").replace(/\s+/g, " ").trim();

/* ---- links --------------------------------------------------------------------------------- */

const overlaps = (a: Period | null, b: Period | null, now: Month) => !a || !b || (a.start <= (b.end ?? now) && b.start <= (a.end ?? now));

export interface PersonaGraph {
  /** The experiences a project was part of. */
  expsOfProject: (projectKey: string) => string[];
  projectsOfExp: (expKey: string) => string[];
  /** A project's skills: its own Skills column and every skill whose Proof names it. */
  skillsOfProject: (projectKey: string) => string[];
  projectsOfSkill: (skillKey: string) => string[];
  projectsOfPerson: (personKey: string) => string[];
  proofsOf: (key: string) => string[];
  /** Every key (`exp:…`, `project:…`, `skill:…`, `proof:…`, `person:…`) this one connects to, itself first. */
  related: (key: string) => string[];
  /** The lane a project or experience belongs to (a project takes its place's; one of its own is "Built"). */
  laneOf: (key: string) => string;
}

export function personaGraph(p: Persona, now: Month = monthOf(new Date().getFullYear(), new Date().getMonth() + 1)): PersonaGraph {
  const projByKey = new Map(p.projects.map((x) => [x.key, x]));
  const expByKey = new Map(p.experience.map((x) => [x.key, x]));
  const skillByName = new Map(p.skills.map((s) => [norm(s.name), s]));
  const personByName = new Map(p.people.map((s) => [norm(s.name), s]));
  const uniq = (a: string[]) => [...new Set(a)];

  const expsOfProject = (k: string): string[] => {
    const pr = projByKey.get(k);
    if (!pr) return [];
    return uniq(
      pr.partOf.flatMap((org) => {
        const same = p.experience.filter((e) => norm(e.org) === norm(org));
        const during = same.filter((e) => overlaps(e.when, pr.when, now) && e.when && pr.when);
        return (during.length ? during : same).map((e) => e.key);
      }),
    );
  };
  const projectsOfExp = (k: string) => p.projects.filter((pr) => expsOfProject(pr.key).includes(k)).map((pr) => pr.key);
  const skillsOfProject = (k: string) => {
    const pr = projByKey.get(k);
    if (!pr) return [];
    const own = pr.skills.map((n) => skillByName.get(norm(n))?.key).filter((x): x is string => !!x);
    const proving = p.skills.filter((s) => s.proof.some((n) => norm(n) === norm(pr.name))).map((s) => s.key);
    return uniq([...own, ...proving]);
  };
  const projectsOfSkill = (k: string) => p.projects.filter((pr) => skillsOfProject(pr.key).includes(k)).map((pr) => pr.key);
  const peopleOfProject = (k: string) =>
    (projByKey.get(k)?.people ?? []).map((n) => personByName.get(norm(n))?.key).filter((x): x is string => !!x);
  const projectsOfPerson = (k: string) => p.projects.filter((pr) => peopleOfProject(pr.key).includes(k)).map((pr) => pr.key);
  const proofsOf = (key: string) => p.proof.filter((f) => f.source === key).map((f) => f.key);

  const related = (key: string): string[] => {
    const [t, id = ""] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const out = [key];
    const add = (type: string, ids: string[]) => ids.forEach((i) => out.push(`${type}:${i}`));
    if (t === "project") {
      add("skill", skillsOfProject(id));
      add("person", peopleOfProject(id));
      add("proof", proofsOf(key));
      add("exp", expsOfProject(id));
    } else if (t === "exp") {
      const prs = projectsOfExp(id);
      add("project", prs);
      add("proof", proofsOf(key));
      for (const pr of prs) {
        add("skill", skillsOfProject(pr));
        add("person", peopleOfProject(pr));
        add("proof", proofsOf(`project:${pr}`));
      }
    } else if (t === "skill") {
      const prs = projectsOfSkill(id);
      add("project", prs);
      for (const pr of prs) {
        add("exp", expsOfProject(pr));
        add("proof", proofsOf(`project:${pr}`));
      }
    } else if (t === "proof") {
      const src = p.proof.find((f) => f.key === id)?.source;
      if (src) out.push(...related(src));
    } else if (t === "person") {
      const prs = projectsOfPerson(id);
      add("project", prs);
      for (const pr of prs) add("exp", expsOfProject(pr));
    }
    return uniq(out);
  };

  const laneOf = (key: string): string => {
    const [t, id = ""] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (t === "exp") return expByKey.get(id)?.lane ?? "Other";
    if (t === "project") {
      const e = expsOfProject(id)[0];
      return e ? (expByKey.get(e)?.lane ?? "Built") : "Built";
    }
    if (t === "proof") {
      const src = p.proof.find((f) => f.key === id)?.source;
      return src ? laneOf(src) : "Other";
    }
    if (t === "person") {
      const pr = projectsOfPerson(id)[0];
      return pr ? laneOf(`project:${pr}`) : "Other";
    }
    return "Other";
  };

  return { expsOfProject, projectsOfExp, skillsOfProject, projectsOfSkill, projectsOfPerson, proofsOf, related, laneOf };
}

/* ---- the timeline -------------------------------------------------------------------------- */

export interface StoryYear {
  year: number;
  /** Where the year starts and how wide it is, in % of the track. */
  left: number;
  width: number;
}

export interface StoryBar {
  key: string;
  label: string;
  /** The place alone, for a bar too short for its whole label. */
  short: string;
  lane: string;
  row: number;
  left: number;
  width: number;
  /** It goes on past now ("– now"): drawn open at its right end. */
  open: boolean;
  /** Now falls inside it. */
  now: boolean;
}

export interface Story {
  years: StoryYear[];
  lanes: { lane: string; rows: number }[];
  bars: StoryBar[];
  /** Where now is, in %. */
  now: number;
}

/** The order lanes are drawn in: Study, Work, Built, then the rest as the note first names them. */
export const LANE_ORDER = ["Study", "Work", "Built"];

/**
 * The Experience rows on a timeline from their first year to now (or the last end, if later),
 * years given room by how much happened in them (each is labelled, so the scale is honest), one
 * lane per Lane, bars packed into as few rows as don't overlap.
 */
export function storyOf(p: Persona, now: Month): Story | null {
  const dated = p.experience.filter((e) => e.when);
  if (dated.length === 0) return null;
  const first = Math.min(...dated.map((e) => e.when!.start));
  const last = Math.max(now, ...dated.map((e) => e.when!.end ?? now));
  const y0 = yearOfMonth(first);
  const y1 = yearOfMonth(last);
  const span = (y: number) => (y === y1 ? (last % 12) + 1 : 12);
  // A year's weight: a floor, plus every month something was going on in it.
  // Places and projects both count: a year of many projects is a busy year.
  const periods = [...dated.map((e) => e.when!), ...p.projects.map((x) => x.when).filter((w): w is Period => !!w)];
  const weights: number[] = [];
  for (let y = y0; y <= y1; y++) {
    let busy = 0;
    for (const w of periods) {
      const s = Math.max(w.start, monthOf(y, 1));
      const t = Math.min(w.end ?? now, monthOf(y, 12));
      if (t >= s) busy += t - s + 1;
    }
    weights.push((6 + busy / 3) * (span(y) / 12));
  }
  const total = weights.reduce((a, b) => a + b, 0);
  const years: StoryYear[] = [];
  let acc = 0;
  weights.forEach((w, i) => {
    years.push({ year: y0 + i, left: (acc / total) * 100, width: (w / total) * 100 });
    acc += w;
  });
  /** The left edge of month m, in %. */
  const x = (m: Month) => {
    const y = years[Math.min(years.length - 1, Math.max(0, yearOfMonth(m) - y0))]!;
    return y.left + (((m % 12) / span(y.year)) * y.width);
  };
  const lanes = [...new Set(dated.map((e) => e.lane))].sort((a, b) => {
    const ia = LANE_ORDER.indexOf(a);
    const ib = LANE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const bars: StoryBar[] = [];
  const out: { lane: string; rows: number }[] = [];
  for (const lane of lanes) {
    const rows: Month[] = []; // each row's last end
    const items = dated.filter((e) => e.lane === lane).sort((a, b) => a.when!.start - b.when!.start);
    for (const e of items) {
      const end = e.when!.end ?? last;
      let row = rows.findIndex((r) => r < e.when!.start);
      if (row < 0) row = rows.push(end) - 1;
      else rows[row] = end;
      const left = x(e.when!.start);
      const right = e.when!.end === null || e.when!.end >= last ? 100 : x(e.when!.end + 1);
      const org = e.org.replace(/\s*\(.*\)\s*$/, "").split(",")[0]!.trim();
      bars.push({
        key: `exp:${e.key}`,
        label: org && e.role ? `${org} · ${e.role}` : org || e.role,
        short: org || e.role,
        lane,
        row,
        left,
        width: Math.max(0.6, right - left),
        open: e.when!.end === null,
        now: e.when!.start <= now && (e.when!.end === null || e.when!.end >= now),
      });
    }
    out.push({ lane, rows: rows.length });
  }
  return { years, lanes: out, bars, now: Math.min(100, x(now) + years[years.length - 1]!.width / (span(y1) * 2)) };
}
