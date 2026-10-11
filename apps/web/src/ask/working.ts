/**
 * "How I found this" (structure.md §2.11): each tool Orr called becomes one sentence in his
 * words, with what it found as names that open their things. "Asked the graph for projects that
 * are at risk → Graduation thesis, Move to Oost." The old panel showed `✓ find_entities`.
 *
 * Pure: a tool's name, its input and its output in, a sentence and its finds out. What a name
 * opens is decided later, against the vault the panel has loaded (targets.ts). The server's
 * tools are in apps/server/src/routes/ai.ts; their results carry ids and titles.
 */
import { dateLabel, minutesLabel } from "../ui/dates.js";

/** Something a step found, and where it leads. */
export type Target =
  /** A note: its project, person, company or the note itself, whichever it is. */
  | { kind: "note"; id: string }
  /** A project, when only its tag is known (`project/<slug>`). */
  | { kind: "project"; slug: string }
  /** A message in Mail. */
  | { kind: "mail"; uid: number }
  /** Orr's drafts, waiting in Mail. */
  | { kind: "waiting" }
  /** A day in Planning. */
  | { kind: "day"; date: string };

export interface Found {
  /** The name shown; a note's title when its id alone came back is filled in by the panel. */
  label: string;
  to: Target;
}

export type StepState = "running" | "done" | "failed";

export interface Step {
  text: string;
  found: Found[];
  /** Finds not shown, said as "and 4 more". */
  more: number;
  state: StepState;
}

/** At most this many names under a step; the rest are counted. */
export const FOUND_MAX = 6;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const quote = (s: string) => `“${s.length > 60 ? `${s.slice(0, 59)}…` : s}”`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A note's name from a path: "Contacts/Thijs Brouwer.md" → "Thijs Brouwer". */
const nameOf = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

/** Notes in a result ({id, title}), as finds. */
const notes = (rows: Obj[]): Found[] =>
  rows.flatMap((r) => {
    const id = str(r.id);
    return id ? [{ label: str(r.title) ?? (str(r.path) ? nameOf(str(r.path)!) : id), to: { kind: "note" as const, id } }] : [];
  });

/** A type from the ontology, said in the plural: "person" → "people". */
const KINDS: Record<string, string> = { person: "people", company: "companies", project: "projects", document: "documents", area: "areas", conversation: "conversations", note: "notes" };
const kinds = (type?: string) => (type ? (KINDS[type.toLowerCase()] ?? `${type} notes`) : "notes");
const STATUS: Record<string, string> = { "on-track": "on track", "at-risk": "at risk" };
/** A relation id in words: works_at → "work at". */
const REL: Record<string, string> = {
  works_at: "work at",
  employs: "employ",
  involves: "involve",
  involved_in: "are involved in",
  part_of: "are part of",
  has_part: "include",
  about: "are about",
  discussed_in: "are discussed in",
  supervises: "supervise",
  supervised_by: "are supervised by",
  involves_company: "involve",
};

const TASK_STATUS: Record<string, string> = { todo: "to do", "in-progress": "in progress", blocked: "blocked", done: "done" };

/** A date and a time of day in the app's words: "Fri 16 Oct at 15:00". */
const when = (date?: string, startMin?: number) => [date ? dateLabel(date) : "", startMin !== undefined ? `at ${minutesLabel(startMin)}` : ""].filter(Boolean).join(" ");

/** What a refused write said, without the server's reasons (those are for the model). */
const failedOf = (out: Obj) => out.success === false || typeof out.error === "string";

/**
 * One tool call as a step. `state` is the part's: input still streaming or waiting for its
 * output is running, an error (thrown, or a tool that answered `success: false` or `error`)
 * failed.
 */
export function stepOf(tool: string, partState: string, input: unknown, output: unknown): Step {
  const a = obj(input);
  const out = obj(output);
  const running = partState === "input-streaming" || partState === "input-available";
  const errored = partState === "output-error" || partState === "output-denied" || (!running && failedOf(out));
  let text: string;
  let found: Found[] = [];

  switch (tool) {
    case "search_vault": {
      text = str(a.query) ? `Searched your notes for ${quote(str(a.query)!)}` : "Searched your notes";
      found = notes(list(output));
      if (!running && !errored && found.length === 0) text += ": nothing came up";
      break;
    }
    case "read_note": {
      text = "Read one note";
      found = notes(str(out.id) ? [out] : []);
      if (errored) text = str(a.note) ? `Couldn't read ${quote(str(a.note)!)}` : "Couldn't read a note";
      break;
    }
    case "vault_schema": {
      text = "Looked at how your notes are organised";
      break;
    }
    case "find_entities": {
      const status = str(a.status) ? `${STATUS[str(a.status)!] ?? str(a.status)} ` : "";
      const rel = str(a.relation) && str(a.to) ? ` that ${REL[str(a.relation)!.toLowerCase()] ?? str(a.relation)!.replace(/_/g, " ")} ${str(a.to)}` : "";
      const words = str(a.text) ? ` matching ${quote(str(a.text)!)}` : "";
      text = `Asked the graph for ${status}${kinds(str(a.type))}${rel}${words}`;
      found = notes(list(out.entities));
      const total = num(out.total);
      if (!running && !errored && found.length === 0) text += ": none";
      return finish(text, found, running, errored, total);
    }
    case "get_relations": {
      const e = obj(out.entity);
      text = `Looked up everything connected to ${str(e.title) ?? str(a.entity) ?? "a note"}`;
      found = notes(list(out.relations).flatMap((r) => list(r.to)));
      // The same note can be related twice (works at, and involved in): name it once.
      found = found.filter((f, i) => found.findIndex((g) => g.to.kind === "note" && f.to.kind === "note" && g.to.id === f.to.id) === i);
      break;
    }
    case "find_path": {
      text = `Looked for how ${str(a.from) ?? "one note"} and ${str(a.to) ?? "another"} are connected`;
      const first = list(out.paths)[0] as unknown;
      const steps = Array.isArray(first) ? first.map(obj) : [];
      found = notes(steps.length ? [obj(steps[0]!.from), ...steps.map((s) => obj(s.to))] : []);
      if (!running && !errored && out.found === false) text += ": they aren't";
      break;
    }
    case "list_summaries": {
      text = `Scanned the summaries of ${kinds(str(a.type))}${str(a.about) ? ` about ${str(a.about)}` : ""}`;
      found = notes(list(out.items));
      break;
    }
    case "write_note": {
      const path = str(out.path) ?? str(a.path);
      text = path ? `Wrote the note ${nameOf(path)}` : "Wrote a note";
      if (errored) text = path ? `Tried to write ${nameOf(path)}; it wasn't changed` : "Tried to write a note; nothing was changed";
      found = str(out.id) ? [{ label: path ? nameOf(path) : "the note", to: { kind: "note", id: str(out.id)! } }] : [];
      break;
    }
    case "append_to_note":
    case "replace_section": {
      const path = str(out.path);
      const name = path ? nameOf(path) : (str(a.note) ?? "a note");
      const section = str(a.section);
      text = tool === "append_to_note" ? `Added to ${name}${section ? ` under ${quote(section)}` : ""}` : `Rewrote ${section ? quote(section) : "a section"} in ${name}`;
      if (errored) text = `Tried to change ${name}; it wasn't changed`;
      found = str(out.id) ? [{ label: name, to: { kind: "note", id: str(out.id)! } }] : [];
      break;
    }
    case "create_project": {
      const name = str(a.name) ?? "a project";
      text = errored ? `Tried to make the project ${name}; ${str(out.error) === "a project with that name already exists" ? "one with that name exists" : "it wasn't made"}` : `Made the project ${name}`;
      const slug = str(out.key)?.replace(/^project\//, "");
      found = slug ? [{ label: name, to: { kind: "project", slug } }] : [];
      break;
    }
    case "create_task": {
      const task = str(a.text) ? quote(str(a.text)!) : "a step";
      text = `Added ${task}${str(a.due) ? `, due ${dateLabel(str(a.due)!)}` : ""}`;
      if (errored) text = `Tried to add ${task}; it wasn't added`;
      found = str(out.noteId) ?? str(a.noteId) ? [{ label: "", to: { kind: "note", id: (str(out.noteId) ?? str(a.noteId))! } }] : [];
      break;
    }
    case "set_task_status": {
      const task = str(a.text) ? quote(str(a.text)!) : "a step";
      text = `Marked ${task} ${TASK_STATUS[str(a.status) ?? ""] ?? str(a.status) ?? ""}`.trim();
      if (errored) text = `Tried to mark ${task}; it wasn't changed`;
      found = str(a.noteId) ? [{ label: "", to: { kind: "note", id: str(a.noteId)! } }] : [];
      break;
    }
    case "set_task_dates": {
      const task = str(a.text) ? quote(str(a.text)!) : "a step";
      const due = a.due === null ? "no due date" : str(a.due) ? `due ${dateLabel(str(a.due)!)}` : "";
      const start = a.start === null ? "no start date" : str(a.start) ? `starting ${dateLabel(str(a.start)!)}` : "";
      text = `Gave ${task} ${[due, start].filter(Boolean).join(" and ") || "new dates"}`;
      if (errored) text = `Tried to change the dates of ${task}; they weren't changed`;
      found = str(a.noteId) ? [{ label: "", to: { kind: "note", id: str(a.noteId)! } }] : [];
      break;
    }
    case "schedule_block": {
      const date = str(a.date);
      const minutes = num(a.durationMin) ?? 120;
      const length = minutes % 60 === 0 ? plural(minutes / 60, "hour") : `${minutes} minutes`;
      const task = str(a.text) ? ` for ${quote(str(a.text)!)}` : "";
      text = `Booked ${length}${task} on ${when(date, num(a.startMin) ?? 540)}`;
      if (errored) text = `Tried to book time${task}; nothing was booked`;
      found = date && !errored ? [{ label: dateLabel(date), to: { kind: "day", date } }] : [];
      break;
    }
    case "create_event": {
      const date = str(a.date);
      text = `Put ${str(a.title) ? quote(str(a.title)!) : "an event"} on ${when(date, num(a.startMin))}`;
      if (errored) text = `Tried to put ${str(a.title) ? quote(str(a.title)!) : "an event"} on your calendar; it wasn't added`;
      found = date && !errored ? [{ label: dateLabel(date), to: { kind: "day", date } }] : [];
      break;
    }
    case "list_email": {
      const messages = list(out.messages);
      text = errored ? "Couldn't read your inbox" : "Read your inbox";
      found = messages.flatMap((m) => (num(m.uid) !== undefined ? [{ label: str(m.subject) ?? str(m.from) ?? "a message", to: { kind: "mail" as const, uid: num(m.uid)! } }] : []));
      break;
    }
    case "read_email": {
      text = errored ? "Couldn't read a mail" : `Read a mail${str(out.fromName) ?? str(out.from) ? ` from ${str(out.fromName) ?? str(out.from)}` : ""}`;
      const uid = num(a.uid);
      found = uid !== undefined && !errored ? [{ label: str(out.subject) ?? "the message", to: { kind: "mail", uid } }] : [];
      break;
    }
    case "draft_email": {
      const to = str(out.to) ?? str(a.to);
      text = errored ? "Tried to draft a mail; it wasn't saved" : `Drafted a mail${to ? ` to ${to}` : ""}. It waits for you in Mail; I never send`;
      found = errored ? [] : [{ label: str(out.subject) ?? str(a.subject) ?? "the draft", to: { kind: "waiting" } }];
      break;
    }
    default:
      text = `Used ${tool.replace(/_/g, " ")}`;
  }
  return finish(text, found, running, errored);
}

/** While a tool runs its sentence is said as it happens: "Searching your notes for …". */
const DOING: Record<string, string> = {
  Searched: "Searching",
  Read: "Reading",
  Looked: "Looking",
  Asked: "Asking",
  Scanned: "Scanning",
  Wrote: "Writing",
  Added: "Adding",
  Rewrote: "Rewriting",
  Made: "Making",
  Marked: "Marking",
  Gave: "Giving",
  Booked: "Booking",
  Put: "Putting",
  Drafted: "Drafting",
  Used: "Using",
};

function finish(text: string, found: Found[], running: boolean, errored: boolean, total?: number): Step {
  if (running) {
    const [verb, ...rest] = text.split(" ");
    text = [DOING[verb!] ?? verb, ...rest].join(" ").replace(/\. It waits for you in Mail; I never send$/, "");
  }
  const shown = found.slice(0, FOUND_MAX);
  const all = Math.max(found.length, total ?? 0);
  return { text, found: shown, more: all - shown.length, state: running ? "running" : errored ? "failed" : "done" };
}
