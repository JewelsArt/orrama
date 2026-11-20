/**
 * The Me page's pure rules (ME): what colour a thing takes, what the header says, who vouches,
 * which note a row's source is, and what a key names. The server reads the note (core
 * parsePersona); this only arranges it. The links between things are core's personaGraph.
 */
import type { Persona } from "@orrama/schema/responses";
import { monthOf, type Period } from "@orrama/core/persona-graph";

/** Colour means the lane, everywhere (Jules, 5 Nov: the grey version was "very black and white"). */
const LANE_COLOR: Record<string, string> = { Study: "var(--c1)", Work: "var(--c2)", Built: "var(--c4)" };
const SPARE = ["var(--c3)", "var(--c5)", "var(--c-other)"];

export function laneColor(lane: string, lanes: readonly string[] = []): string {
  if (LANE_COLOR[lane]) return LANE_COLOR[lane]!;
  const others = lanes.filter((l) => !LANE_COLOR[l]);
  const i = others.indexOf(lane);
  return SPARE[Math.min(i < 0 ? SPARE.length - 1 : i, SPARE.length - 1)]!;
}

export const thisMonth = (now = new Date()) => monthOf(now.getFullYear(), now.getMonth() + 1);

/** What a key (`project:…`, `exp:…`, …) names, for chips and the panel's title. */
export function nameOf(p: Persona, key: string): string {
  const [t, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (t === "project") return p.projects.find((x) => x.key === id)?.name ?? "";
  if (t === "exp") {
    const e = p.experience.find((x) => x.key === id);
    // The place and the role: three rows at one place must not read the same.
    return e ? [shortOrg(e.org), e.role].filter(Boolean).join(" · ") : "";
  }
  if (t === "skill") return p.skills.find((x) => x.key === id)?.name ?? "";
  if (t === "person") return p.people.find((x) => x.key === id)?.name ?? "";
  if (t === "proof") {
    const f = p.proof.find((x) => x.key === id);
    return f ? `${f.number} · ${f.what}` : "";
  }
  return "";
}

/**
 * What "Use in an email" says it is about, in words a model can use: a place with its role and
 * dates, a proof point with its number and where it comes from (review, 20 Nov: it used to send
 * "Scooperz" for all three Scooperz rows, and a proof point's project instead of the proof).
 */
export function aboutOf(p: Persona, key: string): string {
  const [t, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
  if (t === "exp") {
    const e = p.experience.find((x) => x.key === id);
    return e ? [e.role, e.org && `at ${e.org}`, e.period && `(${e.period})`].filter(Boolean).join(" ") : "";
  }
  if (t === "proof") {
    const f = p.proof.find((x) => x.key === id);
    if (!f) return "";
    const from = f.source ? nameOf(p, f.source) : "";
    return `the proof point "${f.number}: ${f.what}"${from ? `, from ${from}` : ""}`;
  }
  if (t === "project") {
    const pr = p.projects.find((x) => x.key === id);
    return pr ? `the project ${pr.name}${pr.period ? ` (${pr.period})` : ""}` : "";
  }
  return nameOf(p, key);
}

/** "MyUniBooks (HvA co-entrepreneurship)" → "MyUniBooks"; "Kasetsart University, Bangkok" → "Kasetsart University". */
export const shortOrg = (org: string) => org.replace(/\s*\(.*\)\s*$/, "").split(",")[0]!.trim();

/** A Now value as a header fact: asides in brackets taken out, cut at the first clause past 48 characters. */
export function factText(value: string): string {
  const v = value.replace(/\s*\([^)]*\)/g, "").replace(/\s+,/g, ",").trim();
  if (v.length <= 48) return v;
  const parts = v.split(", ");
  let out = parts[0]!;
  for (const part of parts.slice(1)) {
    if (`${out}, ${part}`.length > 48) break;
    out = `${out}, ${part}`;
  }
  return out;
}

const current = (w: Period | null, now: number) => !!w && w.start <= now && (w.end === null || w.end >= now);

export interface HeaderFact {
  text: string;
  /** The whole value, for its tooltip. */
  full: string;
  /** The place it is, when one row of Experience says so: the chip opens it. */
  key: string | null;
  lane: string | null;
}

/**
 * The header's meta line, from Now: the role and the study as chips in their lane's colour,
 * opening the place they name; where you are and your languages as plain words.
 */
export function headerFacts(p: Persona, now: number): HeaderFact[] {
  const out: HeaderFact[] = [];
  const find = (label: RegExp) => p.now.find((n) => label.test(n.label));
  const placeIn = (value: string, lane?: string) => {
    const v = value.toLowerCase();
    // By the place's name, or its first word ("AMSIB" of "AMSIB / HvA, Amsterdam").
    const word = (org: string) => shortOrg(org).split(/[\s/]+/)[0]!.toLowerCase();
    const named = p.experience.filter((e) => (!lane || e.lane === lane) && e.org && (v.includes(shortOrg(e.org).toLowerCase()) || (word(e.org).length >= 3 && new RegExp(`\\b${word(e.org).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(v))));
    return named.find((e) => current(e.when, now)) ?? named[named.length - 1] ?? null;
  };
  for (const [label, lane] of [
    [/^stud/i, "Study"],
    [/^(role|job|work)/i, "Work"],
  ] as const) {
    const row = find(label);
    if (!row) continue;
    const e = placeIn(row.value, lane) ?? placeIn(row.value);
    out.push({ text: factText(row.value), full: row.value, key: e ? `exp:${e.key}` : null, lane: e?.lane ?? lane });
  }
  const based = find(/^(based|lives?|location|city)/i);
  if (based) out.push({ text: factText(based.value), full: based.value, key: null, lane: null });
  const langs = find(/^languages?/i);
  if (langs) out.push({ text: languagesOf(langs.value), full: langs.value, key: null, lane: null });
  return out;
}

/** "French and English (both native), Dutch (beginner)" → "French · English · Dutch". */
export function languagesOf(value: string): string {
  return value
    .replace(/\s*\([^)]*\)/g, "")
    .split(/\s*(?:,|;|\band\b|&|\/)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" · ");
}

/** The Now rows the header doesn't show (a thesis, what you're looking for…), for the page. */
export function otherNow(p: Persona): { label: string; value: string }[] {
  return p.now.filter((n) => !/^(stud|role|job|work|based|lives?|location|city|languages?)/i.test(n.label));
}

/**
 * People, those who vouch first: the note calls them a reference, a coach or a supervisor, or
 * they briefed your work. Everyone is listed; the page shows who vouches and the
 * rest behind "Everyone".
 */
export function vouches(p: Persona): { vouch: Persona["people"]; rest: Persona["people"] } {
  const is = (x: Persona["people"][number]) => /referen|referee|vouch|supervis|coach|mentor|briefed|recommend/i.test(`${x.how} ${x.role}`);
  return { vouch: p.people.filter(is), rest: p.people.filter((x) => !is(x)) };
}

/** A person's relation in a few words: the first clause of how you work together, as written. */
export const relationOf = (how: string) => how.split(/[,.;]/)[0]!.trim();

/** The open questions, in the note's order. */
export const openQuestions = (p: Persona) => p.questions.filter((q) => !q.answer);
/** The questions answered, newest last as the note has them. */
export const answeredQuestions = (p: Persona) => p.questions.filter((q) => q.answer);

/** The note a row's Source names, by path (with or without .md) or by title. */
export function sourceNote<T extends { id: string; path: string; title: string }>(source: string | null, tree: readonly T[]): T | undefined {
  if (!source) return undefined;
  const s = source.trim().replace(/\.md$/i, "").toLowerCase();
  return tree.find((n) => n.path.replace(/\.md$/i, "").toLowerCase() === s) ?? tree.find((n) => n.title.toLowerCase() === s) ?? tree.find((n) => n.path.toLowerCase().endsWith(`/${s}.md`));
}

/** A person row's own page: the #contact note with that name. */
export function contactFor<T extends { name: string; path: string }>(name: string, contacts: readonly T[]): T | undefined {
  const n = name.normalize("NFC").trim().toLowerCase();
  return contacts.find((c) => c.name.normalize("NFC").trim().toLowerCase() === n);
}

/** Work's groups: each place a project was part of, its own time ("Built"), and the strongest. */
export function workGroups(p: Persona, expsOf: (projectKey: string) => string[]) {
  const groups = new Map<string, Set<string>>();
  const add = (g: string, k: string) => groups.set(g, (groups.get(g) ?? new Set()).add(k));
  for (const pr of p.projects) {
    const exps = expsOf(pr.key);
    if (exps.length === 0) add("Built", pr.key);
    for (const ek of exps) {
      const e = p.experience.find((x) => x.key === ek);
      // What you built on your own time is Built, whatever the row calls the place.
      if (e) add(e.lane === "Built" ? "Built" : shortOrg(e.org), pr.key);
    }
  }
  return [...groups.entries()].map(([name, keys]) => ({ name, keys }));
}

/**
 * Story, newest first: what is going on now first, newest start first (a thesis begun in August
 * before a study begun in 2022), then the rest by where they ended. A year written alone is not
 * a December: "2022–2027" is going on, not the newest thing.
 */
export function newestFirst(p: Persona, now: number) {
  const going = (w: Period | null) => !!w && w.start <= now && (w.end === null || w.end >= now);
  const end = (w: Period | null) => (w ? (w.end ?? Infinity) : -Infinity);
  return [...p.experience].sort((a, b) => {
    const ga = going(a.when);
    const gb = going(b.when);
    if (ga !== gb) return ga ? -1 : 1;
    if (ga) return (b.when!.start ?? 0) - (a.when!.start ?? 0);
    return end(b.when) - end(a.when) || (b.when?.start ?? 0) - (a.when?.start ?? 0);
  });
}

/** Languages the In short text has, English first. */
export function pitchLanguages(p: Persona): string[] {
  const all = new Set<string>();
  for (const l of Object.values(p.short)) for (const k of Object.keys(l)) all.add(k);
  return [...all].sort((a, b) => (a === "EN" ? -1 : b === "EN" ? 1 : a < b ? -1 : 1));
}
