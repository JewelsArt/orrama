/**
 * export.ts — everything Basalt holds that is not in the vault, in one folder.
 *
 *   pnpm --dir apps/server export [folder]
 *
 * The vault is Markdown and backs itself up (git, Obsidian, a copy of the
 * folder). What lives only in SQLite does not: accounts and team grants, task
 * descriptions and comments, assignees and planned dates, project overrides,
 * mail drafts, the AI settings and agent instructions, API tokens, webhooks,
 * calendar feeds, Touch ID devices, note history (audit B10: "there is no
 * export"). Writes `basalt-export-<time>/` holding:
 *
 *   basalt.db     an exact snapshot (SQLite's online backup, safe while the
 *                 server runs) — restoring it brings all of the above back
 *   export.json   the same data readable, minus every secret: no password or
 *                 passcode hashes, no token hashes, no webhook secrets or
 *                 webhook URLs (only their host), no feed tokens, nothing
 *                 encrypted
 *   README.txt    what is where and how to restore
 *
 * Owner-only (folder 0700, files 0600): the snapshot holds hashes and
 * encrypted secrets. Refuses to write inside the vault, which may be synced or
 * pushed somewhere. Defaults to <data dir>/exports, next to the database.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { tables } from "./db.js";
import { SCHEMA_VERSION } from "./db.js";
import { dbPath, env, vaultDir } from "./env.js";

/**
 * Where a webhook goes, without the part that lets anyone post to it: for
 * Slack, Discord, Zapier, Make or IFTTT the URL's path or query IS the
 * credential (audit STO-008). Its origin, and the last four characters of the
 * rest so two hooks to one host can be told apart.
 */
export function webhookHint(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`.replace(/^\/$/, "");
    return rest ? `${u.origin}/…${rest.slice(-4)}` : u.origin;
  } catch {
    return "(unreadable URL)";
  }
}
import { isEntry } from "./entry.js";

export const EXPORT_FORMAT = { name: "basalt-export", version: 1 } as const;

/** Local time, as the person running it reads a clock: 20261001-1429. */
const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const inside = (child: string, parent: string) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export interface ExportResult {
  dir: string;
  counts: Record<string, number>;
}

export async function exportBasalt(opts: { into?: string; db?: string; vault?: string; now?: Date } = {}): Promise<ExportResult> {
  const source = opts.db ?? dbPath();
  if (!fs.existsSync(source)) throw new Error(`no database at ${source}`);
  const parent = path.resolve(opts.into ?? path.join(env.dataDir, "exports"));
  const vault = opts.vault ?? vaultDir();
  if (inside(parent, vault)) throw new Error(`refusing to export into the vault (${vault}): the snapshot holds hashes and encrypted secrets`);

  const now = opts.now ?? new Date();
  const dir = path.join(parent, `basalt-export-${stamp(now)}`);
  if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 1. The snapshot. A read-only connection: an export must never write to
  //    the live database, and the backup API copies a consistent state even
  //    while the server is writing.
  const snapshot = path.join(dir, "basalt.db");
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await live.backup(snapshot);
  } finally {
    live.close();
  }
  // The copy keeps the live database's WAL mode, and opening a WAL database
  // leaves -wal and -shm files beside it. A plain rollback journal makes the
  // snapshot one self-contained file; the server turns WAL back on when it
  // opens a restored copy (db.ts).
  const own = new Database(snapshot);
  try {
    own.pragma("journal_mode = DELETE");
  } finally {
    own.close();
  }
  fs.chmodSync(snapshot, 0o600);

  // 2. The readable copy, from the snapshot — so the two always agree.
  const sqlite = new Database(snapshot, { readonly: true });
  try {
    const db = drizzle(sqlite, { schema: tables });
    const users = db.select().from(tables.users).all();
    const who = new Map(users.map((u) => [u.id, u.username]));
    const notePath = new Map(db.select({ id: tables.notes.id, path: tables.notes.path }).from(tables.notes).all().map((n) => [n.id, n.path]));
    const teams = db.select().from(tables.teams).all();
    const teamSlug = new Map(teams.map((t) => [t.id, t.slug]));
    const comments = db.select().from(tables.taskComments).all();
    const ws = db.select().from(tables.workspace).all()[0];
    const mail = db.select().from(tables.mailAccounts).all();

    const data = {
      format: EXPORT_FORMAT.name,
      formatVersion: EXPORT_FORMAT.version,
      exportedAt: now.toISOString(),
      basaltVersion: readVersion(),
      schemaVersion: Number(sqlite.pragma("user_version", { simple: true })) || SCHEMA_VERSION,
      workspace: {
        name: ws?.name ?? null,
        ai: { provider: ws?.aiProvider ?? null, model: ws?.aiModel ?? null, baseUrl: ws?.aiBaseUrl ?? null, keyStored: !!ws?.aiKeyEncrypted, instructions: ws?.aiInstructions ?? "" },
      },
      accounts: users.map((u) => ({
        username: u.username,
        email: u.email,
        displayName: u.displayName,
        isOwner: u.isOwner,
        avatar: u.avatar,
        appearance: u.appearance ? (JSON.parse(u.appearance) as unknown) : null,
        quickUnlock: !!u.passcodeHash,
        calendarFeedPublished: !!u.icsToken,
        createdAt: u.createdAt,
      })),
      teams: teams.map((t) => ({ slug: t.slug, name: t.name, color: t.color, icon: t.icon })),
      memberships: db.select().from(tables.memberships).all().map((m) => ({ user: who.get(m.userId) ?? m.userId, team: teamSlug.get(m.teamId) ?? m.teamId })),
      folderGrants: db.select().from(tables.folderGrants).all().map((g) => ({ team: teamSlug.get(g.teamId) ?? g.teamId, folder: g.folder, role: g.role })),
      projects: db.select().from(tables.projects).all().map((p) => ({ kind: p.kind, key: p.key, name: p.name, domain: p.domain, hidden: !!p.hidden, team: p.teamId ? (teamSlug.get(p.teamId) ?? p.teamId) : null })),
      tasks: db.select().from(tables.taskObjects).all().map((t) => ({
        note: notePath.get(t.noteId) ?? t.noteId,
        blockId: t.blockId,
        status: t.status,
        assignee: t.assigneeId ? (who.get(t.assigneeId) ?? t.assigneeId) : null,
        due: t.due,
        plannedDate: t.plannedDate,
        description: t.description,
        comments: comments.filter((c) => c.taskId === t.id).sort((a, b) => a.createdAt - b.createdAt).map((c) => ({ author: who.get(c.authorId) ?? c.authorId, body: c.body, createdAt: c.createdAt })),
      })),
      mailAccounts: mail.map((m) => ({ user: who.get(m.userId) ?? m.userId, email: m.email, imap: `${m.imapHost}:${m.imapPort}`, smtp: `${m.smtpHost}:${m.smtpPort}`, passwordStored: true })),
      mailDrafts: db.select().from(tables.mailDrafts).all().map((d) => ({ user: who.get(d.userId) ?? d.userId, to: d.to, subject: d.subject, body: d.body, inReplyTo: d.inReplyTo, createdBy: d.createdBy, createdAt: d.createdAt })),
      calendarFeeds: db.select().from(tables.icsFeeds).all().map((f) => ({ owner: who.get(f.ownerId) ?? f.ownerId, label: f.label, createdAt: f.createdAt })),
      apiTokens: db.select().from(tables.apiTokens).all().map((t) => ({ user: who.get(t.userId) ?? t.userId, label: t.label, prefix: t.prefix, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
      webhooks: db.select().from(tables.webhooks).all().map((h) => ({ owner: who.get(h.ownerId) ?? h.ownerId, destination: webhookHint(h.url), events: JSON.parse(h.events) as string[], active: h.active })),
      touchIdDevices: db.select().from(tables.webauthnCredentials).all().map((c) => ({ user: who.get(c.userId) ?? c.userId, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
      history: { revisions: db.select({ id: tables.ydocUpdates.id }).from(tables.ydocUpdates).all().length },
    };
    const json = path.join(dir, "export.json");
    fs.writeFileSync(json, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "README.txt"), readme(data.exportedAt, source, vault), { mode: 0o600 });

    return {
      dir,
      counts: {
        accounts: data.accounts.length,
        tasks: data.tasks.length,
        comments: comments.length,
        projects: data.projects.length,
        mailDrafts: data.mailDrafts.length,
        apiTokens: data.apiTokens.length,
        webhooks: data.webhooks.length,
        calendarFeeds: data.calendarFeeds.length,
        historyRevisions: data.history.revisions,
      },
    };
  } finally {
    sqlite.close();
  }
}

function readVersion(): string | null {
  try {
    const pkg = path.resolve(import.meta.dirname, "../../../package.json");
    return (JSON.parse(fs.readFileSync(pkg, "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

function readme(at: string, source: string, vault: string): string {
  return `Basalt export — ${at}

What is here
  basalt.db     An exact copy of Basalt's database at that moment: accounts,
                team grants, task descriptions and comments, assignees and
                planned dates, project settings, mail drafts, AI settings and
                instructions, API tokens, webhooks, calendar feeds, Touch ID
                devices, note history.
  export.json   The same, readable. Every secret is left out: password and
                passcode hashes, token hashes, webhook secrets, webhook URLs
                (a Slack or Discord hook's URL is its password: only the host
                and the last four characters are shown), calendar-feed tokens,
                and everything stored encrypted (mail password, AI key, feed
                URLs) — those exist only inside basalt.db.

What is not here
  Your notes. They are the Markdown files in ${vault}, and are backed up with
  that folder. Calendar blocks and events, task status and everything else
  written in the notes come back from the files themselves.

Restoring
  1. Stop Basalt (launchd: launchctl bootout gui/$(id -u)/dev.basalt.server).
  2. Copy basalt.db over ${source}
     and delete basalt.db-wal and basalt.db-shm beside it if they exist.
  3. Start Basalt again. It re-reads the vault on boot.
  The encrypted values (mail password, AI key, feed URLs) only decrypt with
  the same BASALT_SECRET_KEY this server was running with.

Keep this folder private: basalt.db holds password hashes and encrypted secrets.
`;
}

if (isEntry(import.meta.url, process.argv[1])) {
  try {
    const { dir, counts } = await exportBasalt({ into: process.argv[2] });
    console.log(`Exported to ${dir}`);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(18)} ${v}`);
  } catch (err) {
    console.error(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
