import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BackupError, lookAtBackup, lookAtTarget, makeBackup, NeedsYes, stageRestore, uploadDir, uploadedZip } from "../backup.js";
import { tables, type Db } from "../db.js";
import { env, ownNotesFolder } from "../env.js";
import { expandHome } from "../firstRun.js";
import { SESSION_DAYS } from "../sessions.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { fromOwnSite, overHttps, sessionCookie, sessionOnly } from "./auth.js";
import { homePath } from "./settings.js";

/** What a browser downloads: only names Back up now makes. */
const BACKUP_NAME = /^Orrama backup \d{4}-\d{2}-\d{2}( \(\d+\))?\.zip$/;
/** The largest backup a restore takes in: a zip without ZIP64 stops at 4 GB (backupZip.ts). */
const MAX_UPLOAD = 0xffffffff;

/** Where a backup waits for a browser to download it: the app's data folder, never the notes. */
export const downloadsDir = (dataDir = env.dataDir) => path.join(dataDir, "backups-out");

const FIXED = "Restoring isn't available here: the notes folder is set where Orrama starts.";

/**
 * Where a restore's notes go unless the person picks another folder: Orrama's own (`~/Orrama`),
 * or, when that already has files (the notes in use now, an earlier install's), a new folder
 * beside it, `Orrama (restored 2026-11-07)`, so nothing is written over without a yes.
 */
export function suggestedFolder(now = new Date()) {
  const own = ownNotesFolder();
  const first = lookAtTarget(own);
  if (first.problem || first.files === 0) return first;
  const p = (n: number) => String(n).padStart(2, "0");
  const base = `${own} (restored ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())})`;
  for (let i = 1; ; i++) {
    const look = lookAtTarget(i === 1 ? base : `${base.slice(0, -1)} ${i})`);
    if (look.problem || look.files === 0) return look;
  }
}

/**
 * Settings → Notes → Back up now, and Restore (Settings, and first run's "I have a backup").
 * backup.ts does the work; this says who may ask and in what words.
 *
 * Backing up is the owner's, from a session (the zip holds every account's password hash).
 * In the app the page picks a folder with the system's chooser and the zip is written there; in
 * a browser it is made in the data folder and downloaded once (`/api/backup/download/<name>`),
 * then deleted.
 *
 * Restoring replaces the database, so it is the owner's too, from a session; or, on an install
 * where nobody has made an account yet (first run), anyone at this computer, from one of our own
 * pages (the same rule as making the first account, with the CSRF check `authenticate` would
 * otherwise do). The zip is uploaded as the request's body (`application/zip`), looked at, and
 * the folder for its notes looked at, before anything is written. The restore answers with a
 * session for the backup's owner (its cookie), then the server restarts and reads it.
 */
export async function backupRoutes(app: FastifyInstance, db: Db, store: VaultStore, restart?: () => void) {
  const owner = (userId: string) => {
    if (!store.aclUser(userId).isOwner) throw new HttpError(403, "workspace owner required");
  };
  const ownerSession = { preHandler: [app.authenticate], config: sessionOnly("backups are made and restored from a signed-in session, not with an API token") };
  const nobodyYet = () => db.select({ id: tables.users.id }).from(tables.users).limit(1).all().length === 0;

  /** The owner from a session, or anyone on an install with no account yet. */
  const mayRestore = async (req: FastifyRequest, reply: FastifyReply) => {
    if (nobodyYet()) {
      if (!fromOwnSite(req.headers, env.publicOrigins)) return reply.code(403).send({ error: "this request came from another site" });
      return;
    }
    await app.authenticate(req, reply);
    if (reply.sent) return reply;
    owner(req.userId);
  };
  const restoring = { preHandler: [mayRestore], config: sessionOnly("backups are made and restored from a signed-in session, not with an API token") };

  const refusal = (err: unknown): never => {
    if (err instanceof BackupError) throw new HttpError(400, err.message);
    throw err;
  };

  app.post("/api/backup", ownerSession, async (req) => {
    owner(req.userId);
    const { folder } = z.object({ folder: z.string().max(1024).nullable() }).parse(req.body);
    let into: string;
    if (folder === null) {
      into = downloadsDir();
      // One waiting at a time: an earlier one nobody downloaded goes.
      fs.rmSync(into, { recursive: true, force: true });
      fs.mkdirSync(into, { recursive: true, mode: 0o700 });
    } else {
      into = expandHome(folder);
      if (!path.isAbsolute(into)) throw new HttpError(400, "Pick the folder the backup goes in.");
    }
    const made = await makeBackup({ into }).catch(refusal);
    req.log.info(`backup: ${made.files} files, ${made.bytes} bytes in ${made.ms} ms`);
    return {
      name: made.name,
      folder: folder === null ? null : homePath(path.dirname(made.file)),
      bytes: made.bytes,
      notes: made.notes,
      files: made.files,
      ms: made.ms,
      download: folder === null ? `/api/backup/download/${encodeURIComponent(made.name)}` : null,
    };
  });

  app.get("/api/backup/download/:name", ownerSession, async (req, reply) => {
    owner(req.userId);
    const { name } = z.object({ name: z.string().regex(BACKUP_NAME) }).parse(req.params);
    const file = path.join(downloadsDir(), name);
    if (!fs.existsSync(file)) throw new HttpError(404, "That backup is gone. Make it again.");
    const ascii = name.replace(/[^\x20-\x7e]/g, "_");
    reply.header("content-type", "application/zip");
    reply.header("content-length", String(fs.statSync(file).size));
    reply.header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("cache-control", "no-store");
    // Downloaded once: the copy in the data folder goes when it has been sent.
    reply.raw.once("finish", () => fs.rmSync(file, { force: true }));
    return reply.send(fs.createReadStream(file));
  });

  await app.register(async (zipped) => {
    // The backup itself is the body: streamed to a file, never held in memory.
    zipped.addContentTypeParser(["application/zip", "application/octet-stream", "application/x-zip-compressed"], (_req, payload, done) => done(null, payload));

    /** Take the uploaded zip in, say what it holds and where its notes would go. */
    zipped.post("/api/backup/restore/look", restoring, async (req) => {
      if (env.vaultDir !== null) throw new HttpError(409, FIXED);
      const body = req.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== "function") throw new HttpError(415, "send the backup as application/zip");
      fs.rmSync(uploadDir(), { recursive: true, force: true });
      fs.mkdirSync(uploadDir(), { recursive: true, mode: 0o700 });
      let bytes = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          bytes += chunk.length;
          if (bytes > MAX_UPLOAD) return done(new HttpError(413, "That file is larger than a backup can be."));
          done(null, chunk);
        },
      });
      await pipeline(body, cap, fs.createWriteStream(uploadedZip(), { mode: 0o600 }));
      const look = await lookAtBackup(uploadedZip()).catch(refusal);
      const suggested = suggestedFolder();
      return {
        createdAt: look.createdAt,
        version: look.version,
        notes: look.notes,
        files: look.files,
        account: look.account,
        keyOpens: look.keyOpens,
        folder: homePath(suggested.abs),
        folderFiles: suggested.files,
      };
    });
  });

  /** Where the notes would go: there or not, how many files already in it. Writes nothing. */
  app.post("/api/backup/restore/folder", restoring, async (req) => {
    const { folder } = z.object({ folder: z.string().max(1024) }).parse(req.body);
    const look = lookAtTarget(folder);
    return { folder: look.abs ? homePath(look.abs) : "", problem: look.problem, files: look.files };
  });

  /**
   * Restore the uploaded backup: its notes into `folder` (one with files in it only with
   * `replace: true`), its database in place at the restart that follows this answer, and this
   * browser signed in as its owner.
   */
  app.post("/api/backup/restore", restoring, async (req, reply) => {
    if (env.vaultDir !== null) throw new HttpError(409, FIXED);
    const { folder, replace } = z.object({ folder: z.string().max(1024), replace: z.boolean() }).parse(req.body);
    let staged;
    try {
      staged = await stageRestore({ folder, replace, userAgent: req.headers["user-agent"] });
    } catch (err) {
      if (err instanceof NeedsYes) {
        return reply.code(409).send({ error: `That folder already has ${err.files} ${err.files === 1 ? "file" : "files"} in it.`, files: err.files });
      }
      return refusal(err);
    }
    const seconds = SESSION_DAYS * 86_400;
    const token = app.jwt.sign({ sub: staged.userId, sid: staged.sessionId }, { expiresIn: seconds });
    reply.header("set-cookie", sessionCookie(token, seconds, overHttps(req)));
    if (restart) reply.raw.once("finish", () => setImmediate(restart));
    return { folder: homePath(staged.folder), dropped: staged.dropped, restart: !!restart };
  });
}
