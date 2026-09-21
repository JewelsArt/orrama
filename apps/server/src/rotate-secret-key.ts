/**
 * Re-encrypt every stored credential under a new BASALT_SECRET_KEY.
 *
 * `secrets.ts` derives its AES key from BASALT_SECRET_KEY, so changing that
 * variable does not invalidate the stored ciphertext — it makes it
 * UNDECRYPTABLE. The mail password and the AI key would still be sitting in
 * the database, unreadable, and the failure surfaces as a mail connection that
 * stops working rather than as anything that names the cause.
 *
 * So rotation is a migration, and this is it. Run it with the server stopped:
 *
 *   BASALT_OLD_SECRET_KEY=<the old one> \
 *   BASALT_SECRET_KEY=<the new one> \
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

/** Every column holding something encryptSecret() wrote. */
const COLUMNS: { table: string; id: string; column: string }[] = [
  { table: "mail_accounts", id: "id", column: "password_encrypted" },
  { table: "workspace", id: "id", column: "ai_key_encrypted" },
  { table: "ics_feeds", id: "id", column: "url_encrypted" },
];

function main(): void {
  const oldKey = process.env.BASALT_OLD_SECRET_KEY;
  const newKey = process.env.BASALT_SECRET_KEY;
  const apply = process.argv.includes("--apply");

  if (!oldKey || !newKey) {
    console.error("Set BASALT_OLD_SECRET_KEY and BASALT_SECRET_KEY. Nothing done.");
    process.exit(1);
  }
  if (oldKey === newKey) {
    console.error("Both keys are the same. Nothing to do.");
    process.exit(1);
  }

  const db = new Database(dbPath());
  const tables = new Set(
    (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name),
  );

  // Decrypt EVERYTHING first. A half-rotated database is worse than an
  // unrotated one, so nothing is written until every row has been read back
  // successfully under the old key.
  const staged: { table: string; id: string; column: string; idValue: string; plain: string }[] = [];
  for (const { table, id, column } of COLUMNS) {
    if (!tables.has(table)) continue;
    const rows = db.prepare(`select ${id} as rid, ${column} as val from ${table} where ${column} is not null and ${column} <> ''`).all() as { rid: string; val: string }[];
    for (const row of rows) {
      try {
        staged.push({ table, id, column, idValue: row.rid, plain: decrypt(row.val, oldKey) });
      } catch {
        console.error(`FAILED to decrypt ${table}.${column} (${row.rid}) with the old key. Nothing written.`);
        console.error("Either BASALT_OLD_SECRET_KEY is wrong, or this row was already rotated.");
        process.exit(1);
      }
    }
  }

  if (staged.length === 0) {
    console.log("No encrypted credentials found. Rotating the key is safe with no migration.");
    return;
  }

  for (const s of staged) console.log(`${apply ? "rotating" : "would rotate"}  ${s.table}.${s.column}  (${s.idValue})`);
  if (!apply) {
    console.log(`\n${staged.length} credential(s) read back cleanly under the old key. Re-run with --apply.`);
    return;
  }

  const write = db.transaction(() => {
    for (const s of staged) {
      db.prepare(`update ${s.table} set ${s.column} = ? where ${s.id} = ?`).run(encrypt(s.plain, newKey), s.idValue);
    }
  });
  write();
  console.log(`\nRotated ${staged.length} credential(s). Set BASALT_SECRET_KEY to the new value wherever the server runs.`);
}

main();
