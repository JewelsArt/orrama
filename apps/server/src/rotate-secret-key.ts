/**
 * Re-encrypt every stored credential under a new ORRAMA_SECRET_KEY.
 *
 * `secrets.ts` derives its AES key from ORRAMA_SECRET_KEY, so changing that
 * variable does not invalidate the stored ciphertext — it makes it
 * UNDECRYPTABLE. The mail password and the AI key would still be sitting in
 * the database, unreadable, and the failure surfaces as a mail connection that
 * stops working rather than as anything that names the cause.
 *
 * So rotation is a migration, and this is it. Run it with the server stopped:
 *
 *   ORRAMA_OLD_SECRET_KEY=<the old one> \
 *   ORRAMA_SECRET_KEY=<the new one> \
 *   pnpm --dir apps/server rotate-secret-key --apply
 *
 * Without `--apply` it reports what it would do and changes nothing, which is
 * how you check the old key is the right one before touching anything.
 *
 * NOTE ON WHAT THIS DOES NOT DO: re-encrypting a credential that was protected
 * by a published key does not make that credential safe again. Anyone who held
 * a copy of the database could already read it. Rotate the credentials
 * themselves — the Gmail app password, the AI key — at the provider.
 */
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { isEntry } from "./entry.js";
import { dbPath } from "./env.js";

const keyFrom = (secret: string) => crypto.createHash("sha256").update(secret).digest();

function decrypt(stored: string, secret: string): string {
  const [ivB64, encB64, tagB64] = stored.split(".");
  const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(secret), Buffer.from(ivB64!, "base64"));
  d.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([d.update(Buffer.from(encB64!, "base64")), d.final()]).toString("utf8");
}

function encrypt(plain: string, secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv.toString("base64"), enc.toString("base64"), c.getAuthTag().toString("base64")].join(".");
}

/**
 * Every value encryptSecret() wrote. `where` narrows a key/value table to the
 * rows that hold one. The ChatGPT credentials (a long-lived refresh token)
 * were missing: a rotation left them undecryptable under the new key and
 * still readable under the old one — the one a rotation is meant to retire
 * (audit SEC-006). Anything new stored with encryptSecret() goes here too.
 */
export const COLUMNS: { table: string; id: string; column: string; where?: string }[] = [
  { table: "mail_accounts", id: "id", column: "password_encrypted" },
  { table: "workspace", id: "id", column: "ai_key_encrypted" },
  { table: "ics_feeds", id: "id", column: "url_encrypted" },
  { table: "meta", id: "key", column: "value", where: "key = 'chatgpt_credentials'" },
  // A row still in the clear (written before SEC-015, server not booted
  // since) is sealed under whatever key the next boot runs with.
  { table: "webhooks", id: "id", column: "secret", where: "substr(secret, 1, 6) <> 'whsec_'" },
];

export class RotateError extends Error {}

/**
 * Re-encrypt every stored credential from `oldKey` to `newKey`; with `apply`
 * false, only check that each one reads back. Decrypts EVERYTHING first —
 * a half-rotated database is worse than an unrotated one, so nothing is
 * written until every row has been read back under the old key. Returns
 * what it rotated (or would), as `table.column (id)`.
 */
export function rotateSecrets(db: Database.Database, oldKey: string, newKey: string, apply: boolean): string[] {
  const tables = new Set(
    (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name),
  );
  const staged: { table: string; id: string; column: string; idValue: string; plain: string }[] = [];
  for (const { table, id, column, where } of COLUMNS) {
    if (!tables.has(table)) continue;
    const rows = db
      .prepare(`select ${id} as rid, ${column} as val from ${table} where ${column} is not null and ${column} <> ''${where ? ` and ${where}` : ""}`)
      .all() as { rid: string; val: string }[];
    for (const row of rows) {
      try {
        staged.push({ table, id, column, idValue: row.rid, plain: decrypt(row.val, oldKey) });
      } catch {
        throw new RotateError(
          `FAILED to decrypt ${table}.${column} (${row.rid}) with the old key. Nothing written.\n` +
            "Either ORRAMA_OLD_SECRET_KEY is wrong, or this row was already rotated.",
        );
      }
    }
  }
  if (apply) {
    db.transaction(() => {
      for (const s of staged) {
        db.prepare(`update ${s.table} set ${s.column} = ? where ${s.id} = ?`).run(encrypt(s.plain, newKey), s.idValue);
      }
    })();
  }
  return staged.map((s) => `${s.table}.${s.column}  (${s.idValue})`);
}

function main(): void {
  const oldKey = process.env.ORRAMA_OLD_SECRET_KEY;
  const newKey = process.env.ORRAMA_SECRET_KEY;
  const apply = process.argv.includes("--apply");

  if (!oldKey || !newKey) {
    console.error("Set ORRAMA_OLD_SECRET_KEY and ORRAMA_SECRET_KEY. Nothing done.");
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error("Both keys are the same. Nothing to do.");
    process.exit(1);
  }

  let done: string[];
  try {
    done = rotateSecrets(new Database(dbPath()), oldKey, newKey, apply);
  } catch (err) {
    if (!(err instanceof RotateError)) throw err;
    console.error(err.message);
    process.exit(1);
  }

  if (done.length === 0) {
    console.log("No encrypted credentials found. Rotating the key is safe with no migration.");
    return;
  }

  for (const d of done) console.log(`${apply ? "rotated" : "would rotate"}  ${d}`);
  if (!apply) {
    console.log(`\n${done.length} credential(s) read back cleanly under the old key. Re-run with --apply.`);
    return;
  }
  console.log(`\nRotated ${done.length} credential(s). Set ORRAMA_SECRET_KEY to the new value wherever the server runs.`);
}

if (isEntry(import.meta.url, process.argv[1])) main();
