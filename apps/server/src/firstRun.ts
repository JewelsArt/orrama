/**
 * First run without your vault (stage 1, 1A): where the notes are, the note that says what
 * things are, and the small example a new person can start from and remove.
 *
 * Nothing here runs at boot. "Nothing else is written into the vault at boot" holds
 * (`test/vault-untouched.test.ts`): every write below is a person's choice on the first-run
 * screen or in Settings → Notes, made through `VaultStore.write` like any other note.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { ONTOLOGY_TEMPLATE, type AclUser } from "@orrama/core";
import { writeFileAtomic } from "./atomicWrite.js";
import { parseCalendarRows, type CalendarNotes } from "./calendarNotes.js";
import { tables, type Db } from "./db.js";
import { env, NOTES_FOLDER_FILE, ownNotesFolder } from "./env.js";
import { HttpError, type VaultStore } from "./vaultStore.js";

// ---- the first-run flag ------------------------------------------------------

/**
 * Set when the first account is made, cleared once its notes folder is settled. While it is
 * set the web app shows the first-run chooser after sign-in, so closing the window before
 * choosing does not leave a person in an app with no idea of what things are. A database from
 * before this existed has no row, so an established install never sees the chooser.
 */
const PENDING = "first-run-pending";
export const markFirstRunPending = (db: Pick<Db, "insert">) =>
  db.insert(tables.meta).values({ key: PENDING, value: new Date().toISOString() }).onConflictDoNothing().run();
export const firstRunPending = (db: Db) => !!db.select().from(tables.meta).where(eq(tables.meta.key, PENDING)).get();
const finishFirstRun = (db: Db) => db.delete(tables.meta).where(eq(tables.meta.key, PENDING)).run();

// ---- the notes folder ----------------------------------------------------------

/** What a typed folder holds, said before anyone commits to it. */
export interface FolderLook {
  /** The folder as Orrama would use it, absolute. */
  abs: string;
  /** Why it can't be used, in words; null when it can. */
  problem: string | null;
  /** Notes in it (`.md` files, outside hidden folders), at most `NOTE_CAP`. */
  notes: number;
  /** More notes than were counted. */
  more: boolean;
  /** Of those, how many have no `id:` line yet: the one-time stamp adds one to each. */
  unstamped: number;
  /** It already has a note that says what things are. */
  ontology: boolean;
}

/** How far a look goes: a home folder typed by mistake must not read the whole disk. */
export const NOTE_CAP = 20_000;
const ENTRY_CAP = 200_000;

/**
 * `~` and `~/…` the way a person types them, else the path as typed. The home folder is
 * `os.homedir()`: Windows has no HOME (it has USERPROFILE), and `~/Notes` read as `Notes`
 * there was refused as "not the whole path".
 */
export function expandHome(typed: string, home = os.homedir()): string {
  const t = typed.trim();
  if (t === "~") return home;
  if (t.startsWith("~/")) return path.join(home, t.slice(2));
  return t;
}

const hasIdLine = (head: string) => {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  return !!m && /^id:\s*\S/m.test(m[1]!);
};

/**
 * Look at a folder before it becomes the notes folder: does it exist, can Orrama write in it,
 * how many notes, how many will get the id line, does it say what things are. Never writes.
 */
export function lookAtFolder(typed: string, dataDir = env.dataDir): FolderLook {
  const out: FolderLook = { abs: "", problem: null, notes: 0, more: false, unstamped: 0, ontology: false };
  const expanded = expandHome(typed);
  if (!expanded) return { ...out, problem: "Type the folder your notes are in." };
  if (!path.isAbsolute(expanded)) return { ...out, problem: "Type the whole path, starting with / or ~/." };
  const abs = path.resolve(expanded);
  out.abs = abs;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ...out, problem: "There is no folder there." };
  }
  if (!stat.isDirectory()) return { ...out, problem: "That is a file, not a folder." };
  const data = path.resolve(dataDir);
  const rel = path.relative(abs, data);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return { ...out, problem: "That folder holds Orrama's own data. Pick the folder your notes are in." };
  }
  // Inside the data folder is the other way round, and as bad: uninstalling the app may delete
  // that folder with everything in it. Orrama's own folder is there only outside the app.
  const inside = path.relative(data, abs);
  if (!inside.startsWith("..") && !path.isAbsolute(inside) && abs !== path.resolve(ownNotesFolder(dataDir))) {
    return { ...out, problem: "That folder is inside Orrama's own data, which uninstalling the app may delete. Pick a folder of your own." };
  }
  try {
    fs.accessSync(abs, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return { ...out, problem: "Orrama can't write in that folder." };
  }
  let entries = 0;
  const walk = (dir: string) => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a folder it can't read is that folder's loss, as at boot
    }
    for (const e of list) {
      if (out.more || ++entries > ENTRY_CAP) {
        out.more = true;
        return;
      }
      if (e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        if (out.notes >= NOTE_CAP) {
          out.more = true;
          return;
        }
        out.notes++;
        let head = "";
        try {
          const fd = fs.openSync(p, "r");
          try {
            const buf = Buffer.alloc(4096);
            head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          continue;
        }
        if (!hasIdLine(head)) out.unstamped++;
        if (/^\s*-\s*vault-ontology\s*$|#vault-ontology\b|tags:\s*\[?[^\n]*\bvault-ontology\b/m.test(head)) out.ontology = true;
      }
    }
  };
  walk(abs);
  return out;
}

/**
 * Keep the chosen folder in the data folder, read at boot when ORRAMA_VAULT_DIR is not set
 * (`storedNotesFolder`, env.ts). Orrama's own folder is the default, so choosing it removes
 * the file.
 */
export function storeNotesFolder(abs: string | null, dataDir = env.dataDir): void {
  const file = path.join(dataDir, NOTES_FOLDER_FILE);
  if (abs === null || path.resolve(abs) === path.resolve(ownNotesFolder(dataDir))) {
    fs.rmSync(file, { force: true });
    return;
  }
  writeFileAtomic(file, `${JSON.stringify({ folder: path.resolve(abs) }, null, 2)}\n`);
}

// ---- what things are -----------------------------------------------------------

/** Where the note goes: one quiet folder of Orrama's own, out of the way of a person's notes. */
export const ONTOLOGY_PATH = "Orrama/What things are.md";

/**
 * Core's ONTOLOGY_TEMPLATE, said for anyone. Its types match where the app writes: people in
 * `Contacts/` (tag `contact`), companies in `Contacts/Companies/` (tag `company`), projects in
 * `04-Projects/` (tag `project/<slug>`). A `folder:` match is that folder only, never its
 * subfolders, so a company is never read as a person.
 */
export function starterOntology(): string {
  const swaps: [string, string][] = [
    ["# Vault ontology", "# What things are"],
    [
      "What the notes in this vault are and how they connect. Orrama reads these tables\n(`#vault-ontology`); edit them here.",
      "What your notes are and how they connect: who someone is, where they work, who is in\nwhich project. Orrama reads these tables; you can edit them here.",
    ],
    ["| person | tag:contact, folder:01-Me/Contacts | someone Jules knows |", "| person | tag:contact, folder:Contacts | someone you know |"],
    ["| conversation | kind:conversation | a saved Claude conversation |", "| conversation | kind:conversation | a saved conversation with an AI |"],
  ];
  let text = ONTOLOGY_TEMPLATE;
  for (const [from, to] of swaps) {
    if (!text.includes(from)) throw new Error(`ONTOLOGY_TEMPLATE changed: "${from.split("\n")[0]}" is gone (firstRun.ts)`);
    text = text.replace(from, to);
  }
  return text;
}

/** Does any note in the folder say what things are (tagged `vault-ontology`)? The index, all of it. */
const hasOntology = (store: VaultStore) => store.index.all().some((n) => n.tags.some((t) => t.tag === "vault-ontology"));

// ---- the example ------------------------------------------------------------------

/** What the example wrote, so Remove takes exactly those notes and that event away. */
interface ExampleRecord {
  folder: string;
  notes: string[];
  event: string | null;
}
const EXAMPLE = "first-run-example";
const readExample = (db: Db): ExampleRecord | null => {
  const raw = db.select().from(tables.meta).where(eq(tables.meta.key, EXAMPLE)).get()?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ExampleRecord;
  } catch {
    return null;
  }
};
const writeExample = (db: Db, rec: ExampleRecord | null) => {
  if (!rec) return db.delete(tables.meta).where(eq(tables.meta.key, EXAMPLE)).run();
  const value = JSON.stringify(rec);
  return db.insert(tables.meta).values({ key: EXAMPLE, value }).onConflictDoUpdate({ target: tables.meta.key, set: { value } }).run();
};

/** The example's notes still in this folder: what Remove would take away. */
export function exampleNotes(db: Db, store: VaultStore) {
  const rec = readExample(db);
  if (!rec || path.resolve(rec.folder) !== path.resolve(store.vaultRoot)) return [];
  return rec.notes.map((id) => store.index.get(id)).filter((n) => !!n);
}

/** A day as the notes write it, in the server's own time zone. */
const dayOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12);

/**
 * The example, fictional and in English: one project with a status, a start date and three
 * steps (one due this week, one key deadline), one person who works at one company and is in
 * the project, and one event this week. Dated from `today`.
 */
export function exampleFiles(today: Date): { path: string; content: string }[] {
  // This week runs Monday to Sunday: a due day and the event inside it, never before today.
  const toSunday = (7 - today.getDay()) % 7;
  const dueDay = plusDays(today, Math.min(2, toSunday));
  return [
    {
      path: "04-Projects/garden-studio.md",
      content: [
        "---",
        "title: Garden studio",
        "tags:",
        "  - project",
        "  - project/garden-studio",
        "status: on-track",
        `start: ${dayOf(plusDays(today, -7))}`,
        "---",
        "",
        "# Garden studio",
        "",
        "A small studio at the end of the garden, somewhere to work that isn't the kitchen table.",
        "This is the example: remove it in Settings, under Notes, once you have your own.",
        "",
        "## Steps",
        "",
        `- [ ] Order the timber due:${dayOf(dueDay)}`,
        `- [ ] Send the planning application #deadline due:${dayOf(plusDays(today, 12))}`,
        "- [ ] Choose the windows",
        "",
        "## People",
        "",
        "- [[Contacts/Sam Rivera|Sam Rivera]]",
        "",
      ].join("\n"),
    },
    {
      path: "Contacts/Sam Rivera.md",
      content: [
        "---",
        'title: "Sam Rivera"',
        "tags: [contact]",
        'sector: "Engineering"',
        'role: "Builder"',
        'company: "Oakline Builders"',
        'email: ""',
        'phone: ""',
        'linkedin: ""',
        "---",
        "# Sam Rivera",
        "",
        "Builds the studio. Prefers a call to an email.",
        "",
      ].join("\n"),
    },
    {
      path: "Contacts/Companies/Oakline Builders.md",
      content: [
        "---",
        'title: "Oakline Builders"',
        "tags: [company]",
        'sector: "Engineering"',
        'description: "A small building firm: extensions, studios, repairs."',
        'linkedin: ""',
        'website: ""',
        'careers: ""',
        'location: ""',
        "positions: []",
        "---",
        "# Oakline Builders",
        "",
      ].join("\n"),
    },
  ];
}

/** The example's event: a site visit, this week, at 10:00 for an hour. */
export function exampleEvent(today: Date) {
  const toSunday = (7 - today.getDay()) % 7;
  return { title: "Site visit with Sam", date: dayOf(plusDays(today, Math.min(1, toSunday))), startMin: 10 * 60, durationMin: 60 };
}

// ---- starting -----------------------------------------------------------------------

export interface StartResult {
  /** The note that says what things are: written now, or already there. */
  ontology: "written" | "there";
  /** The example's notes in this folder now (0 when none was asked for). */
  example: number;
}

/**
 * Settle the notes folder the server is reading now: write the note that says what things
 * are when no note does, and the example when asked (once per folder: asking again adds
 * nothing). Ends first run. Every note is made create-only, so nothing a person already has
 * is ever replaced; a path that is taken is left as it is.
 */
export function startHere(db: Db, store: VaultStore, calendar: CalendarNotes, user: AclUser, opts: { example: boolean; today?: Date }): StartResult {
  if (!user.isOwner) throw new HttpError(403, "workspace owner required");
  const today = opts.today ?? new Date();
  const create = (p: string, content: string) => {
    try {
      return store.write(user, p, content, undefined, undefined, { create: true });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) return null; // a note is already there
      throw err;
    }
  };
  let ontology: StartResult["ontology"] = "there";
  if (!hasOntology(store) && create(ONTOLOGY_PATH, starterOntology())) ontology = "written";

  if (opts.example && exampleNotes(db, store).length === 0) {
    const before = new Set(store.index.all().map((n) => n.id));
    for (const f of exampleFiles(today)) create(f.path, f.content);
    const ev = exampleEvent(today);
    const event = `ev-example-${today.getTime().toString(36)}`;
    calendar.put(user, { id: event, task: null, ...ev });
    // Every note that is new now is the example's: the three above and, when this month had
    // none, the calendar note the event made.
    const made = store.index.all().filter((n) => !before.has(n.id)).map((n) => n.id);
    writeExample(db, { folder: store.vaultRoot, notes: made, event });
  }
  finishFirstRun(db);
  return { ontology, example: exampleNotes(db, store).length };
}

/**
 * Take the example away: its event, and exactly the notes it wrote, wherever they are now and
 * whatever was added to them since (the Confirm says so). The notes go to the trash, as any
 * note put there does (restorable until Empty trash). A calendar note the example made keeps
 * living when it holds rows of the person's own.
 */
export function removeExample(db: Db, store: VaultStore, calendar: CalendarNotes, user: AclUser): number {
  if (!user.isOwner) throw new HttpError(403, "workspace owner required");
  const rec = readExample(db);
  const notes = exampleNotes(db, store);
  if (!rec || notes.length === 0) {
    if (rec && path.resolve(rec.folder) === path.resolve(store.vaultRoot)) writeExample(db, null);
    return 0;
  }
  if (rec.event) {
    try {
      calendar.remove(user, rec.event);
    } catch (err) {
      if (!(err instanceof HttpError && err.statusCode === 404)) throw err; // already gone
    }
  }
  let gone = 0;
  for (const id of rec.notes) {
    const note = store.requireEditable(user, id);
    const keeps = note.path.split("/").includes("Calendar") && parseCalendarRows(user.username, note.content).length > 0;
    if (keeps) continue;
    store.trashNote(user, note.path);
    gone += 1;
  }
  writeExample(db, null);
  return gone;
}
