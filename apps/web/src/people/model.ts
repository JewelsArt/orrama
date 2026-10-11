/**
 * People's data, shaped for the page (structure.md §2.7): who is in each list, what the line
 * under a name says, how the A–Z runs are cut, and the companies people name that have no note
 * yet. Pure functions over what the server sends, so the page and its tests agree.
 */
import type { Company, Contact, PeopleContext } from "@basalt/schema/responses";

export type Entry = PeopleContext["entries"][number];
export type Brief = Entry["relations"][number]["to"][number];

/** `[[Kade Social]]`, `[[Contacts/Companies/Kade Social|Kade]]` → the words a person reads. */
export function linkText(s: string): string {
  return s.replace(/\[\[([^\][|#]*)(?:#[^\][|]*)?(?:\|([^\][]*))?\]\]/g, (_, target: string, alias?: string) => (alias ?? target.split("/").pop() ?? target).trim()).trim();
}

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** A note's slug: its file name, folded to lower-case words and dashes (§1.2). */
export function slugOf(path: string): string {
  const name = path.split("/").pop()!.replace(/\.md$/i, "");
  return fold(name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "note";
}

/** The note a slug names, first by path order when two files share a name. */
export function bySlug<T extends { path: string }>(list: T[], slug: string): T | undefined {
  return [...list].sort((a, b) => (a.path < b.path ? -1 : 1)).find((x) => slugOf(x.path) === slug);
}

/** The company note a contact's `company:` names: the same name, link or plain text, folded. */
export function companyFor(contact: Pick<Contact, "company">, companies: Company[]): Company | undefined {
  const name = fold(linkText(contact.company));
  if (!name) return undefined;
  return companies.find((c) => fold(c.name) === name);
}

/**
 * Everyone whose `company:` is this company, as "People you know here" always read it: the
 * name either way round inside the other ("AMSIB" and "AMSIB (HvA)"), links read as their text.
 */
export function peopleAt(company: Pick<Company, "name">, contacts: Contact[]): Contact[] {
  const needle = fold(company.name.trim());
  return contacts.filter((c) => {
    const at = fold(linkText(c.company));
    return at !== "" && (at === needle || at.includes(needle) || needle.includes(at));
  });
}

/**
 * Companies people work at that have no note: Orr's warning row, "No note yet: Pieter Bakker
 * works here". One per name, with whoever names it, sorted like the companies.
 */
export function companiesWithoutNote(contacts: Contact[], companies: Company[]): { name: string; people: Contact[] }[] {
  const out = new Map<string, { name: string; people: Contact[] }>();
  for (const c of contacts) {
    const name = linkText(c.company);
    if (!name) continue;
    const known = companies.some((co) => {
      const a = fold(co.name);
      const b = fold(name);
      return a === b || a.includes(b) || b.includes(a);
    });
    if (known) continue;
    const key = fold(name);
    const row = out.get(key) ?? out.set(key, { name, people: [] }).get(key)!;
    row.people.push(c);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** How a relation reads in a sentence. Unknown ones read as their id in words. */
const PHRASE: Record<string, string> = {
  involved_in: "in",
  company_involved_in: "in",
  supervises: "supervises",
  employs: "employs",
  discussed_in: "discussed in",
  works_at: "works at",
  involves: "involves",
  part_of: "part of",
  about: "about",
};
export const phraseOf = (relation: string): string => PHRASE[relation] ?? relation.replace(/_/g, " ");

/**
 * Which relation speaks for a row, most telling first. A person's company is already on the line
 * ("Role · Company"), so `works_at` never repeats it; a company's people are its `employs`.
 */
const PERSON_ORDER = ["supervises", "involved_in", "discussed_in"];
const COMPANY_ORDER = ["employs", "company_involved_in", "involved_in", "discussed_in"];
const SKIP = new Set(["works_at"]);

export interface KeyRelation {
  phrase: string;
  first: Brief;
  more: number;
}

export function keyRelation(entry: Entry | undefined, kind: "person" | "company"): KeyRelation | null {
  if (!entry) return null;
  const order = kind === "person" ? PERSON_ORDER : COMPANY_ORDER;
  const rank = (r: string) => {
    const i = order.indexOf(r);
    return i < 0 ? order.length : i;
  };
  const best = entry.relations.filter((r) => !SKIP.has(r.relation) && r.to.length > 0).sort((a, b) => rank(a.relation) - rank(b.relation) || (a.relation < b.relation ? -1 : 1))[0];
  if (!best) return null;
  return { phrase: phraseOf(best.relation), first: best.to[0]!, more: best.to.length - 1 };
}

/** The A–Z bucket of a name: its first letter, accents folded; anything else is "#". */
export function letterOf(name: string): string {
  const c = fold(name.trim()).charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

/**
 * The A–Z list cut into runs of letters ("A–B", "C–E"), each holding at least `min` names, so a
 * long list reads in a handful of groups and a short one in a few. "#" comes last.
 */
export function groupsOf<T>(items: T[], nameOf: (t: T) => string, min = Math.max(2, Math.ceil(items.length / 8))): { label: string; letters: string[]; items: T[] }[] {
  const runs: { letters: string[]; items: T[] }[] = [];
  for (const it of items) {
    const l = letterOf(nameOf(it));
    let cur = runs[runs.length - 1];
    if (!cur || (cur.items.length >= min && !cur.letters.includes(l))) runs.push((cur = { letters: [], items: [] }));
    if (!cur.letters.includes(l)) cur.letters.push(l);
    cur.items.push(it);
  }
  return runs.map((g) => ({ label: g.letters.length > 1 ? `${g.letters[0]}–${g.letters[g.letters.length - 1]}` : g.letters[0]!, letters: g.letters, items: g.items }));
}

/** A–Z by name, the way a phone sorts contacts: accents folded, "#" names last. */
export function byName<T>(items: T[], nameOf: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const la = letterOf(nameOf(a)) === "#" ? 1 : 0;
    const lb = letterOf(nameOf(b)) === "#" ? 1 : 0;
    return la - lb || fold(nameOf(a)).localeCompare(fold(nameOf(b)));
  });
}

/** Most recently mentioned first; never mentioned last, A–Z among themselves. */
export function byRecent<T>(items: T[], nameOf: (t: T) => string, at: (t: T) => string | undefined): T[] {
  return [...items].sort((a, b) => {
    const x = at(a) ?? "";
    const y = at(b) ?? "";
    if (x !== y) return x < y ? 1 : -1;
    return fold(nameOf(a)).localeCompare(fold(nameOf(b)));
  });
}

/** Does a search match this text? Every word somewhere in it, accents and case folded. */
export function matches(q: string, fields: string[]): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(fields.map(linkText).join(" "));
  return words.every((w) => hay.includes(w));
}

/** The sectors in use, as the select lists them: the notes' own spelling, A–Z, "Other" last. */
export function sectorsIn(lists: { sector: string }[][]): string[] {
  const seen = new Map<string, string>();
  for (const list of lists) for (const x of list) if (x.sector && !seen.has(fold(x.sector))) seen.set(fold(x.sector), x.sector);
  return [...seen.values()].sort((a, b) => (fold(a) === "other" ? 1 : fold(b) === "other" ? -1 : a.localeCompare(b)));
}
export const sameSector = (a: string, b: string): boolean => fold(a) === fold(b);
