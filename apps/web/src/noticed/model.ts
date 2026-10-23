/**
 * Orr noticed's words (structure.md §2.15): each graph warning said as a sentence about the
 * note it is about, with one fix. Pure, so the page and its tests agree. Nothing changes until
 * a fix is clicked; a fix the server has no safe write for opens the note instead.
 */
import type { GraphWarnings } from "@orrama/schema/responses";

export type Warning = GraphWarnings["warnings"][number];
export type NoteRef = Warning["note"];

/** A sentence in pieces: plain words, and names that open their thing (§1.7 #1). */
export type Part = string | { name: string; note: { id: string; title: string; type: string; path?: string } };

export type Fix =
  /**
   * A company note by this name (People's New company, prefilled). `person` names it by a path
   * (`[[Clients/Acme]]`): once made, their `company:` is pointed at the new note.
   */
  | { kind: "create-company"; label: string; name: string; person?: string }
  /** Where this person works, picked from the companies (the works-at picker). */
  | { kind: "works-at"; label: string }
  /** A project note carrying this tag's key (`project/pitch-deck` → 04-Projects/pitch-deck.md). */
  | { kind: "create-project"; label: string; slug: string }
  /** Write this status to the project's `status:` (the ontology's id). */
  | { kind: "status"; label: string; value: string }
  /** Pick one of the seven (the status menu). */
  | { kind: "pick-status"; label: string }
  /** Open the note to change it by hand. */
  | { kind: "open"; label: string };

export interface Item {
  key: string;
  code: string;
  note: NoteRef;
  parts: Part[];
  fixes: Fix[];
}

/** The ontology's status ids as words: `at-risk` → "at risk". */
export const statusWord = (id: string) => id.replace(/[-_]+/g, " ");

/** How a relation reads after a name: "Ines Vermaat supervises …", "… is about …". */
const VERB: Record<string, string> = {
  works_at: "works at",
  involves: "involves",
  part_of: "is part of",
  about: "is about",
  supervises: "supervises",
};
const verb = (relation: string | undefined) => (relation ? (VERB[relation] ?? relation.replace(/_/g, " ")) : "points at");

/** "a company", "an area": the ontology's type with its article. */
const kind = (type: string) => `${/^[aeiou]/i.test(type) ? "an" : "a"} ${type}`;

/**
 * "Create the note" for a company named by a link that has no note: named as the link's last
 * part (`Contacts/Companies/Acme.md` → "Acme", never the path), and when the link named a
 * folder, the person is pointed at the note once it exists, since a new note elsewhere would
 * not answer to that path.
 */
function createCompany(target: string, person: string): Fix {
  const name = target.split("/").pop()!.replace(/\.md$/i, "").trim() || target;
  return { kind: "create-company", label: "Create the note", name, ...(target.includes("/") ? { person } : {}) };
}

/** The words after `project/`, as a name: `project/pitch-deck` → "pitch-deck". */
const tagKey = (tag: string) => tag.replace(/^project\//, "");

/**
 * One item per problem, in the server's order. A person whose company is a name with no note
 * has two warnings (the name is not a note, so they work nowhere): that is one problem, said
 * once, with the fix that cures both.
 */
export function itemsOf(warnings: Warning[]): Item[] {
  const unresolvedWork = new Set(warnings.filter((w) => w.code === "unresolved-object" && w.relation === "works_at").map((w) => w.note.id));
  const out: Item[] = [];
  const name = (n: { id: string; title: string; type: string; path?: string }): Part => ({ name: n.title, note: n });
  for (const w of warnings) {
    const who = name(w.note);
    const key = `${w.code}:${w.note.id}:${w.relation ?? ""}:${w.target ?? w.tag ?? ""}`;
    const open: Fix = { kind: "open", label: "Open the note" };
    let parts: Part[];
    let fixes: Fix[];
    switch (w.code) {
      case "unresolved-object":
        parts = [who, ` ${verb(w.relation)} ${w.target ?? "something"}, which has no note.`];
        fixes = w.relation === "works_at" && w.target ? [createCompany(w.target, w.note.id)] : [open];
        break;
      case "person-without-company":
        if (unresolvedWork.has(w.note.id)) continue; // said by its unresolved-object row
        parts = [who, " has no company."];
        fixes = [{ kind: "works-at", label: "Add where they work" }];
        break;
      case "conversation-without-about":
        parts = [who, " isn't about anything yet."];
        fixes = [{ kind: "open", label: "Say what it's about" }];
        break;
      case "project-without-status":
        parts = [who, " has no status."];
        fixes = [{ kind: "pick-status", label: "Set a status" }];
        break;
      case "project-status-conflict": {
        const tags = (w.tags ?? []).filter((t) => t !== w.field);
        if (w.field && tags.length === 1) {
          // Writing the tag's word to the field makes the two agree; dropping a tag is a hand edit.
          parts = [who, ` is tagged ${statusWord(tags[0]!)} but its status says ${statusWord(w.field)}.`];
          fixes = [{ kind: "status", label: `Use ${statusWord(tags[0]!)}`, value: tags[0]! }, { kind: "open", label: "Open the note" }];
        } else {
          const words = (w.tags ?? []).map(statusWord);
          parts = [who, w.field ? ` says ${statusWord(w.field)} but is tagged ${words.join(" and ")}.` : ` is tagged both ${words.join(" and ")}.`];
          fixes = [open];
        }
        break;
      }
      case "range-mismatch":
        parts = w.object
          ? [who, ` ${verb(w.relation)} `, name(w.object), `, which is ${kind(w.found ?? w.object.type)}.`]
          : [who, ` ${verb(w.relation)} a note of the wrong kind.`];
        fixes = [open];
        break;
      case "document-orphan":
        parts = [who, ` is tagged ${w.tag ?? "for a project"}, but there's no project note for it.`];
        fixes = w.tag ? [{ kind: "create-project", label: "Create the project", slug: tagKey(w.tag) }] : [open];
        break;
      default:
        parts = [who, `: ${w.message}`];
        fixes = [open];
    }
    out.push({ key, code: w.code, note: w.note, parts, fixes });
  }
  return out;
}

/** The first item as Today says it: its sentence, and how many more there are. */
export function firstOf(items: Item[]): { item: Item; more: number } | null {
  return items[0] ? { item: items[0], more: items.length - 1 } : null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 people", "1 project": a type's count in words, for the glance. */
export function typeCount(id: string, n: number): string {
  const many: Record<string, string> = { person: "people", company: "companies", conversation: "conversations", project: "projects", document: "documents", area: "areas", note: "other notes" };
  return plural(n, id === "note" ? "other note" : id, many[id] ?? `${id}s`);
}
