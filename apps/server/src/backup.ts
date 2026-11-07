/**
 * Back up now, and Restore (stage 2, 2F): everything Orrama holds, in one .zip a person can
 * keep, and that .zip taken back in, on this computer or a new one.
 *
 * A backup is `Orrama backup <date>.zip`:
 *
 *   README.txt         what is in it and how to restore it, in plain words
 *   backup.json        what Restore reads first: the format, when, which version, counts
 *   basalt.db          the database, a consistent snapshot (export.ts: SQLite's backup API on a
 *                      read-only connection, safe while the server writes)
 *   export.json        the same, readable, every secret left out (export.ts)
 *   notes-folder.json  where the notes were read from, when the app chose it
 *   notes/…            the notes folder's files, as they are on disk
 *
 * **The secret key is never in it** (Jules, 7 Nov 2026, D13). The mail password, the AI key,
 * the ChatGPT sign-in, calendar feed addresses and webhook secrets are stored encrypted with
 * the app's secret key, which stays in the app's own store (the Credential Manager, or a file
 * only the person can read). A lost zip opens none of them. Restored on the same computer they
 * still open; on another one they can't, and restoring leaves them out so the app asks for
 * them again (`clearUnreadable`).
 *
 * A restore is staged, then applied while no database is open: the zip's notes go into the
 * folder the person chose (never over one with files in it without their yes), its database
 * is checked and upgraded in `<data>/restore-pending/`, and the server restarts (main.ts's
 * restart, the one choosing a notes folder uses). `applyPendingRestore`, first thing in
 * `buildServer`, swaps it in: the database it replaces is kept in `<data>/backups/`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { writeFileAtomic } from "./atomicWrite.js";
import { VERSION } from "./build.js";
import { createDb, SCHEMA_VERSION, tables } from "./db.js";
import { dbPath, env, NOTES_FOLDER_FILE, ownNotesFolder, vaultDir } from "./env.js";
import { exportOrrama } from "./exportData.js";
import { expandHome } from "./firstRun.js";
import { COLUMNS } from "./encryptedColumns.js";
import { openSession } from "./sessions.js";
import { safeEntryPath, ZipReader, ZipReadError, ZipWriter } from "./backupZip.js";

export const BACKUP_FORMAT = { name: "orrama-backup", version: 1 } as const;
export const MANIFEST = "backup.json";
const NOTES = "notes/";
/** Never copied: a git folder can be most of a vault's size, and it is its own backup. */
const SKIPPED = new Set([".git", ".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Where a restore waits for the restart (`applyPendingRestore`), and the uploaded zip. */
export const pendingDir = (dataDir = env.dataDir) => path.join(dataDir, "restore-pending");
export const uploadDir = (dataDir = env.dataDir) => path.join(dataDir, "restore");
export const uploadedZip = (dataDir = env.dataDir) => path.join(uploadDir(dataDir), "upload.zip");

const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** "~/Orrama" for a path under the home folder, the way a person reads it. */
function homeWords(p: string, home = os.homedir()): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : p;
}

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const spoken = (d: Date) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** `Orrama backup 2026-11-07.zip`, or `… (2).zip` when that name is taken in `dir`. */
export function backupFileName(dir: string, now = new Date()): string {
  const base = `Orrama backup ${day(now)}`;
  let name = `${base}.zip`;
  for (let i = 2; fs.existsSync(path.join(dir, name)) || fs.existsSync(path.join(dir, `${name}.partial`)); i++) name = `${base} (${i}).zip`;
  return name;
}

/** Every file of the notes folder to copy, relative, with `/`: no links followed, no git folder. */
function notesFiles(root: string, skipUnder: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let list: fs.Dirent[];
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (SKIPPED.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (skipUnder.some((s) => inside(abs, s))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push(r);
      // A link (to a synced folder, say) is not copied: its files live elsewhere and are backed up there.
    }
  };
  walk(root, "");
  return out;
}

const isNote = (rel: string) => rel.toLowerCase().endsWith(".md") && !rel.split("/").some((p) => p.startsWith("."));

export interface BackupResult {
  file: string;
  name: string;
  bytes: number;
  notes: number;
  files: number;
  ms: number;
}

/**
 * Write a backup into `into` (a folder). The zip is written as `<name>.partial` and renamed
 * once whole, so a backup cut short never looks like one. Refuses to write inside the notes
 * folder: the zip holds password hashes, and notes folders get synced and shared.
 */
export async function makeBackup(opts: { into: string; db?: string; vault?: string; dataDir?: string; now?: Date }): Promise<BackupResult> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const dataDir = path.resolve(opts.dataDir ?? env.dataDir);
  const vault = path.resolve(opts.vault ?? vaultDir());
  const into = path.resolve(opts.into);
  if (inside(into, vault)) throw new BackupError("That folder is inside your notes folder. Pick one outside it: a backup holds your account too.");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(into);
  } catch {
    throw new BackupError("There is no folder there.");
  }
  if (!stat.isDirectory()) throw new BackupError("That is a file, not a folder.");

  const staging = fs.mkdtempSync(path.join(dataDir, ".backup-"));
  const name = backupFileName(into, now);
  const file = path.join(into, name);
  const partial = `${file}.partial`;
  let zip: ZipWriter | null = null;
  try {
    const { dir } = await exportOrrama({ into: staging, db: opts.db, vault, now });
    // Orrama's own folders are never copied into the notes: the data folder when it sits inside
    // the notes folder (from a checkout the notes are inside the data folder, the other way round).
    const files = notesFiles(vault, [dataDir, into].filter((d) => !inside(vault, d)));
    const notes = files.filter(isNote).length;
    const manifest = {
      format: BACKUP_FORMAT.name,
      formatVersion: BACKUP_FORMAT.version,
      createdAt: now.toISOString(),
      orramaVersion: VERSION || null,
      schemaVersion: SCHEMA_VERSION,
      notesFolder: homeWords(vault),
      notes,
      files: files.length,
    };
    zip = ZipWriter.open(partial);
    zip.addBuffer("README.txt", backupReadme(now, manifest.notesFolder, notes, files.length), now);
    zip.addBuffer(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, now);
    await zip.addFile("basalt.db", path.join(dir, "basalt.db"));
    await zip.addFile("export.json", path.join(dir, "export.json"));
    if (fs.existsSync(path.join(dir, NOTES_FOLDER_FILE))) await zip.addFile(NOTES_FOLDER_FILE, path.join(dir, NOTES_FOLDER_FILE));
    for (const rel of files) {
      try {
        await zip.addFile(`${NOTES}${rel}`, path.join(vault, ...rel.split("/")));
      } catch (err) {
        // A note deleted while the backup ran is simply not in it; anything else stops it.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    zip.close();
    zip = null;
    fs.renameSync(partial, file);
    return { file, name, bytes: fs.statSync(file).size, notes, files: files.length, ms: Date.now() - t0 };
  } catch (err) {
    zip?.abandon();
    fs.rmSync(partial, { force: true });
    throw err;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** A refusal said to the person as it is (the route answers 400 with it). */
export class BackupError extends Error {}

function backupReadme(now: Date, folder: string, notes: number, files: number): string {
  return `Orrama backup, ${spoken(now)}

What is in it
  notes/          Your notes folder (${folder}): ${notes} ${notes === 1 ? "note" : "notes"}, ${files} ${files === 1 ? "file" : "files"} in all.
                  They are plain Markdown files: unzip this and any editor opens them.
  basalt.db       Orrama's own records: your account, settings, task comments,
                  each note's history, mail drafts.
  export.json     The same records, readable, with every password and key left out.
  backup.json     What Orrama reads to restore this backup.

How to restore it
  Open Orrama. On a new computer, choose "I have a backup" on the first screen.
  On a computer where Orrama is already set up, go to Settings, then Notes,
  then "Restore from a backup". Pick this file and where the notes go.
  You sign in with the same email and password as before.

On another computer
  Mail and Orr's AI ask to be connected again. The key that unlocks their
  passwords stays on the computer that made this backup, so a lost copy of
  this file opens neither.

Keep this file somewhere private: it holds your notes and your account.
`;
}

// ---- reading a backup ------------------------------------------------------------------------

export interface BackupLook {
  createdAt: string;
  version: string | null;
  notes: number;
  files: number;
  /** The account it signs in as: the workspace's owner. */
  account: { name: string; email: string };
  /** Whether its stored passwords open here: null when it stores none. */
  keyOpens: boolean | null;
}

/** What `decrypt` would say, without the server's key module (a test passes another key). */
function opens(stored: string, secret: string): boolean {
  try {
    const [iv, enc, tag] = stored.split(".");
    const key = crypto.createHash("sha256").update(secret).digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64"));
    d.setAuthTag(Buffer.from(tag!, "base64"));
    Buffer.concat([d.update(Buffer.from(enc!, "base64")), d.final()]);
    return true;
  } catch {
    return false;
  }
}

/** Every encrypted value in a database, and whether each opens with `secret` (rotate-secret-key's list). */
function encrypted(sqlite: Database.Database, secret: string): { table: string; id: string; idValue: string; opens: boolean }[] {
  const have = new Set((sqlite.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name));
  const out: { table: string; id: string; idValue: string; opens: boolean }[] = [];
  for (const { table, id, column, where } of COLUMNS) {
    if (!have.has(table)) continue;
    const rows = sqlite
      .prepare(`select ${id} as rid, ${column} as val from ${table} where ${column} is not null and ${column} <> ''${where ? ` and ${where}` : ""}`)
      .all() as { rid: string; val: string }[];
    for (const r of rows) out.push({ table, id, idValue: r.rid, opens: opens(r.val, secret) });
  }
  return out;
}

/**
 * Read an uploaded zip as a backup and say what it holds, or why it can't be used. Takes its
 * database out into `<data>/restore/backup.db` for the restore that follows.
 */
export async function lookAtBackup(zipFile: string, opts: { dataDir?: string; secretKey?: string } = {}): Promise<BackupLook> {
  const dataDir = opts.dataDir ?? env.dataDir;
  const secret = opts.secretKey ?? env.secretKey;
  let zip: ZipReader;
  try {
    zip = ZipReader.open(zipFile);
  } catch {
    throw new BackupError("That file isn't a .zip. Pick the Orrama backup file.");
  }
  try {
    const m = zip.get(MANIFEST);
    const db = zip.get("basalt.db");
    if (!m || !db) throw new BackupError("That .zip isn't an Orrama backup. Pick a file made with Back up now.");
    let manifest: { format?: unknown; formatVersion?: unknown; createdAt?: unknown; orramaVersion?: unknown; notes?: unknown; files?: unknown; schemaVersion?: unknown };
    try {
      manifest = JSON.parse((await zip.read(m, 64 * 1024)).toString("utf8"));
    } catch {
      throw new BackupError("That backup is damaged: Orrama couldn't read it.");
    }
    if (manifest.format !== BACKUP_FORMAT.name) throw new BackupError("That .zip isn't an Orrama backup. Pick a file made with Back up now.");
    if (typeof manifest.formatVersion !== "number" || manifest.formatVersion > BACKUP_FORMAT.version) {
      throw new BackupError("That backup was made by a newer Orrama. Update Orrama, then restore it.");
    }
    for (const item of zip.items) {
      if (item.name.startsWith(NOTES) && !safeEntryPath(item.name.slice(NOTES.length))) throw new BackupError("That backup holds a file Orrama won't write. It wasn't restored.");
    }
    const staged = path.join(uploadDir(dataDir), "backup.db");
    fs.rmSync(staged, { force: true });
    try {
      await zip.extractTo(db, staged);
    } catch (err) {
      if (err instanceof ZipReadError) throw new BackupError("That backup is damaged: Orrama couldn't read it.");
      throw err;
    }
    const sqlite = new Database(staged, { readonly: true, fileMustExist: true });
    try {
      if (sqlite.pragma("quick_check", { simple: true }) !== "ok") throw new BackupError("That backup is damaged: Orrama couldn't read it.");
      const schema = Number(sqlite.pragma("user_version", { simple: true }));
      if (schema > SCHEMA_VERSION) throw new BackupError("That backup was made by a newer Orrama. Update Orrama, then restore it.");
      const owner = sqlite.prepare("select display_name as name, email from users where is_owner = 1 order by created_at limit 1").get() as { name: string; email: string } | undefined;
      if (!owner) throw new BackupError("That backup has no account in it, so there is nothing to sign in to.");
      const secrets = encrypted(sqlite, secret);
      return {
        createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : "",
        version: typeof manifest.orramaVersion === "string" ? manifest.orramaVersion : null,
        notes: typeof manifest.notes === "number" ? manifest.notes : zip.items.filter((i) => i.name.startsWith(NOTES) && isNote(i.name.slice(NOTES.length))).length,
        files: zip.items.filter((i) => i.name.startsWith(NOTES)).length,
        account: { name: owner.name, email: owner.email },
        keyOpens: secrets.length === 0 ? null : secrets.every((s) => s.opens),
      };
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError("That backup is damaged: Orrama couldn't read it.");
    } finally {
      sqlite.close();
    }
  } finally {
    zip.close();
  }
}

// ---- where the notes go ----------------------------------------------------------------------

export interface TargetLook {
  abs: string;
  problem: string | null;
  /** Files already in it: restoring there needs the person's yes. */
  files: number;
}

/** The folder a backup's notes would go to, looked at: never inside Orrama's own data. */
export function lookAtTarget(typed: string, dataDir = env.dataDir): TargetLook {
  const expanded = expandHome(typed);
  if (!expanded || !path.isAbsolute(expanded)) return { abs: "", problem: "Type the whole path, starting with / or ~/.", files: 0 };
  const abs = path.resolve(expanded);
  const data = path.resolve(dataDir);
  // Orrama's own folder sits in the data folder only outside the app (env.ts, ownNotesFolder).
  if (inside(abs, data) && abs !== path.resolve(ownNotesFolder(dataDir))) return { abs, problem: "That folder is inside Orrama's own folder, which uninstalling the app may delete. Pick a folder of your own.", files: 0 };
  if (inside(data, abs)) return { abs, problem: "That folder holds Orrama's own files. Pick another one.", files: 0 };
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    // Not there yet: it is made. Its parent must be.
    const parent = path.dirname(abs);
    if (!fs.existsSync(parent)) return { abs, problem: `There is no folder ${homeWords(parent)} to put it in.`, files: 0 };
    return { abs, problem: null, files: 0 };
  }
  if (!stat.isDirectory()) return { abs, problem: "That is a file, not a folder.", files: 0 };
  let files = 0;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) if (!SKIPPED.has(e.name)) files++;
  return { abs, problem: null, files };
}

// ---- restoring -------------------------------------------------------------------------------

/** What a restore had to leave out because this computer's key doesn't open it. */
export type Dropped = "mail" | "ai" | "chatgpt" | "calendars" | "webhooks";
const DROPPED_BY_TABLE: Record<string, Dropped> = { mail_accounts: "mail", workspace: "ai", meta: "chatgpt", ics_feeds: "calendars", webhooks: "webhooks" };

/**
 * Take out what this computer's key can't open, so the app asks for it again rather than
 * failing on it: a mail account goes (connect it again), the AI key is cleared, the ChatGPT
 * sign-in goes, a subscribed calendar and a webhook go.
 */
function clearUnreadable(sqlite: Database.Database, secret: string): Dropped[] {
  const dropped = new Set<Dropped>();
  for (const s of encrypted(sqlite, secret)) {
    if (s.opens) continue;
    if (s.table === "workspace") sqlite.prepare(`update workspace set ai_key_encrypted = null where ${s.id} = ?`).run(s.idValue);
    else sqlite.prepare(`delete from ${s.table} where ${s.id} = ?`).run(s.idValue);
    dropped.add(DROPPED_BY_TABLE[s.table]!);
  }
  return [...dropped];
}

export class NeedsYes extends Error {
  constructor(readonly files: number) {
    super(`that folder has ${files} ${files === 1 ? "file" : "files"} in it`);
  }
}

export interface Staged {
  userId: string;
  sessionId: string;
  folder: string;
  dropped: Dropped[];
}

/**
 * Put the uploaded backup in place for the restart: its notes into `folder` (made when
 * missing; a folder with files in it only with `replace`, and then a file of the same name is
 * replaced and the others stay), its database ready in `<data>/restore-pending/`, upgraded to
 * this version, with every earlier sign-in ended, what this key can't open left out, and one
 * new session for its owner, the person restoring it.
 */
export async function stageRestore(opts: { folder: string; replace: boolean; userAgent?: string; dataDir?: string; secretKey?: string }): Promise<Staged> {
  const dataDir = opts.dataDir ?? env.dataDir;
  const secret = opts.secretKey ?? env.secretKey;
  const zipFile = uploadedZip(dataDir);
  const look = lookAtTarget(opts.folder, dataDir);
  if (look.problem) throw new BackupError(look.problem);
  if (look.files > 0 && !opts.replace) throw new NeedsYes(look.files);
  if (!fs.existsSync(zipFile)) throw new BackupError("Pick the backup file again: Orrama no longer has it.");
  // Read it again: it is the file the person picked, but looked at in another request.
  await lookAtBackup(zipFile, { dataDir, secretKey: secret });

  const pending = pendingDir(dataDir);
  fs.rmSync(pending, { recursive: true, force: true });
  fs.mkdirSync(pending, { recursive: true, mode: 0o700 });
  const stagedDb = path.join(pending, "basalt.db");
  fs.renameSync(path.join(uploadDir(dataDir), "backup.db"), stagedDb);

  // The database first: if it can't be made ready, no note has been written anywhere.
  let staged: Omit<Staged, "folder">;
  const db = createDb(stagedDb);
  const sqlite = (db as unknown as { $client: Database.Database }).$client;
  try {
    staged = sqlite.transaction(() => {
      const dropped = clearUnreadable(sqlite, secret);
      sqlite.prepare("delete from sessions").run();
      sqlite.prepare("delete from meta where key = 'first-run-pending'").run();
      const owner = db.select().from(tables.users).where(eq(tables.users.isOwner, true)).orderBy(tables.users.createdAt).limit(1).get();
      if (!owner) throw new BackupError("That backup has no account in it, so there is nothing to sign in to.");
      return { userId: owner.id, sessionId: openSession(db, owner.id, opts.userAgent), dropped };
    })();
  } finally {
    sqlite.close();
  }

  // Then the notes. A new or empty folder is filled beside it and moved in whole.
  const zip = ZipReader.open(zipFile);
  try {
    const items = zip.items.filter((i) => i.name.startsWith(NOTES) && !i.name.endsWith("/"));
    const whole = look.files === 0;
    const into = whole ? `${look.abs}.restoring-${crypto.randomBytes(4).toString("hex")}` : look.abs;
    try {
      fs.mkdirSync(into, { recursive: true });
      for (const item of items) {
        const parts = safeEntryPath(item.name.slice(NOTES.length))!;
        const dest = path.join(into, ...parts);
        if (whole) await zip.extractTo(item, dest, 0o644);
        else {
          const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.restoring`);
          await zip.extractTo(item, tmp, 0o644);
          fs.renameSync(tmp, dest);
        }
      }
      if (whole) {
        if (fs.existsSync(look.abs)) fs.rmdirSync(look.abs); // empty: lookAtTarget counted it
        fs.renameSync(into, look.abs);
      }
    } catch (err) {
      if (whole) fs.rmSync(into, { recursive: true, force: true });
      fs.rmSync(pending, { recursive: true, force: true });
      throw err instanceof ZipReadError ? new BackupError("That backup is damaged: Orrama couldn't read it.") : err;
    }
  } finally {
    zip.close();
  }

  fs.writeFileSync(path.join(pending, NOTES_FOLDER_FILE), `${JSON.stringify({ folder: look.abs }, null, 2)}\n`, { mode: 0o600 });
  // Last: the mark that says the rest is whole.
  fs.writeFileSync(path.join(pending, "ready"), new Date().toISOString(), { mode: 0o600 });
  return { ...staged, folder: look.abs };
}

/**
 * Before the database opens (buildServer): a staged restore replaces it. The one replaced is
 * kept as `backups/basalt-before-restore-<time>.db`. A staging that never finished (no `ready`)
 * is thrown away and the database stays as it was.
 */
export function applyPendingRestore(dataDir = env.dataDir, file = path.join(dataDir, path.basename(dbPath()))): { replaced: string | null } | null {
  const pending = pendingDir(dataDir);
  if (!fs.existsSync(pending)) return null;
  if (!fs.existsSync(path.join(pending, "ready"))) {
    fs.rmSync(pending, { recursive: true, force: true });
    console.error("[restore] an unfinished restore was thrown away; the database is unchanged");
    return null;
  }
  let replaced: string | null = null;
  if (fs.existsSync(file)) {
    const dir = path.join(dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "").replace("T", "-");
    replaced = path.join(dir, `basalt-before-restore-${stamp}.db`);
    fs.renameSync(file, replaced);
    for (const side of ["-wal", "-shm"]) if (fs.existsSync(file + side)) fs.renameSync(file + side, replaced + side);
  }
  fs.renameSync(path.join(pending, "basalt.db"), file);
  writeFileAtomic(path.join(dataDir, NOTES_FOLDER_FILE), fs.readFileSync(path.join(pending, NOTES_FOLDER_FILE), "utf8"));
  fs.rmSync(pending, { recursive: true, force: true });
  fs.rmSync(uploadDir(dataDir), { recursive: true, force: true });
  console.log(`[restore] a backup was restored${replaced ? `; the database it replaced is ${replaced}` : ""}`);
  return { replaced };
}
