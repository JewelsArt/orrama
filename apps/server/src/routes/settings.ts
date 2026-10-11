import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { vaultDir } from "../env.js";
import { HttpError, type VaultStore } from "../vaultStore.js";

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

/**
 * What Settings → Notes says about this server (structure.md §3.2: "Notes folder · This
 * server · new endpoint"): the folder the notes are read from, how many it holds, and the
 * version. The folder is set in the launchd plist (`BASALT_VAULT_DIR`), so it is shown, not
 * changed here. Owners only: it names a path on the Mac.
 */
export async function settingsRoutes(app: FastifyInstance, store: VaultStore) {
  app.get("/api/settings/server", { preHandler: [app.authenticate] }, async (req) => {
    if (!store.aclUser(req.userId).isOwner) throw new HttpError(403, "workspace owner required");
    return { notesFolder: homePath(vaultDir()), notes: store.index.all().length, version: VERSION };
  });
}
