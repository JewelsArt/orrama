import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CalendarNotes } from "../calendarNotes.js";
import type { Db } from "../db.js";
import { env, ownNotesFolder, vaultDir } from "../env.js";
import { exampleNotes, lookAtFolder, removeExample, startHere, storeNotesFolder } from "../firstRun.js";
import { HttpError, type VaultStore } from "../vaultStore.js";
import { sessionOnly } from "./auth.js";

/** The server's own version, from its package.json (the twelve places agree; release.test.ts). */
const VERSION = (() => {
  try {
    return (JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
})();

/** A path under the home folder said as `~/…`, the way a person writes it. */
export function homePath(p: string, home = os.homedir()): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : p;
}

const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);

/**
 * Settings → Notes and first run (structure.md §3.2, §2.14): the folder the notes are read
 * from, how many it holds, the version; and choosing the folder. Owners only: it names a path
 * on the Mac. The folder is the launchd plist's `ORRAMA_VAULT_DIR` when that is set (Jules's
 * agent), shown as fixed; otherwise it is chosen here and kept in the data folder
 * (`storedNotesFolder`, env.ts).
 *
 * Changing it on a live server restarts the server in place (`restart`, main.ts): the vault
 * store's root is fixed when it is made, and the calendar index, the webhooks, the live-sync
 * bus and every route hold that store, so a fresh build of all of it is the clean way to read
 * another folder. The page waits for /api/health and carries on.
 */
export async function settingsRoutes(app: FastifyInstance, db: Db, store: VaultStore, calendar: CalendarNotes, restart?: () => void) {
  const owner = (userId: string) => {
    const user = store.aclUser(userId);
    if (!user.isOwner) throw new HttpError(403, "workspace owner required");
    return user;
  };
  /** Choosing where the notes are, and what is written into them, is a session's, never a token's. */
  const choosing = { preHandler: [app.authenticate], config: sessionOnly("the notes folder is chosen from a signed-in session, not with an API token") };

  app.get("/api/settings/server", { preHandler: [app.authenticate] }, async (req) => {
    owner(req.userId);
    return {
      notesFolder: homePath(vaultDir()),
      notes: store.index.all().length,
      version: VERSION,
      /** Set where Orrama starts (ORRAMA_VAULT_DIR): shown, not changed here. */
      fixed: env.vaultDir !== null,
      /** Orrama's own folder, where Start empty and the example go. */
      own: same(store.vaultRoot, ownNotesFolder()),
      /** The example's notes still here: what Remove the example takes away. */
      example: exampleNotes(db, store).length,
    };
  });

  /**
   * Look before you choose: whether a typed folder exists, how many notes it holds, how many
   * get the one-time id line, whether it already says what things are. `folder: null` is
   * Orrama's own folder. Writes nothing.
   */
  app.post("/api/settings/notes-folder/look", choosing, async (req) => {
    owner(req.userId);
    const { folder } = z.object({ folder: z.string().max(1024).nullable() }).parse(req.body);
    // Orrama's own folder may not be made yet: then it is simply empty.
    const own = ownNotesFolder();
    const look = folder !== null ? lookAtFolder(folder) : fs.existsSync(own) ? lookAtFolder(own) : { abs: own, problem: null, notes: 0, more: false, unstamped: 0, ontology: false };
    return {
      folder: look.abs ? homePath(look.abs) : "",
      problem: look.problem,
      notes: look.notes,
      more: look.more,
      unstamped: look.unstamped,
      ontology: look.ontology,
      current: !!look.abs && same(look.abs, store.vaultRoot),
    };
  });

  /**
   * Choose the folder (`null`: Orrama's own). Answers `restart: true` when it is not the one
   * being read now: the server restarts to read it, right after this answer.
   */
  app.put("/api/settings/notes-folder", choosing, async (req, reply) => {
    owner(req.userId);
    if (env.vaultDir !== null) throw new HttpError(409, "The notes folder is set where Orrama starts, so it can't be changed here.");
    const { folder } = z.object({ folder: z.string().max(1024).nullable() }).parse(req.body);
    const target = folder === null ? ownNotesFolder() : lookAtFolder(folder);
    let abs: string;
    if (typeof target === "string") {
      fs.mkdirSync(target, { recursive: true });
      abs = target;
    } else {
      if (target.problem) throw new HttpError(400, target.problem);
      abs = target.abs;
    }
    storeNotesFolder(folder === null ? null : abs);
    const moving = !same(abs, store.vaultRoot);
    if (moving && restart) reply.raw.once("finish", () => setImmediate(restart));
    return { folder: homePath(abs), restart: moving };
  });

  /**
   * Start in the folder being read now: the note that says what things are when none does,
   * and the example when asked. Ends first run (firstRun.ts `startHere`).
   */
  app.post("/api/settings/start", choosing, async (req) => {
    const user = owner(req.userId);
    const { example } = z.object({ example: z.boolean() }).parse(req.body);
    return startHere(db, store, calendar, user, { example });
  });

  /** Remove the example: its notes and its event, nothing else. */
  app.delete("/api/settings/example", choosing, async (req) => {
    const user = owner(req.userId);
    return { removed: await removeExample(db, store, calendar, user) };
  });
}
