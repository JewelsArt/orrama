/**
 * Schema upgrades fail loudly (audit REG-008).
 *
 * The additive ALTERs ran as `try { ALTER } catch {}` on every boot and the
 * database was stamped current whatever happened, so a failure other than
 * "duplicate column" surfaced later as "no such column" on some request. Now a
 * column is added only when its table lacks it, and any other failure stops
 * createDb with the statement and SQLite's words, the version unstamped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { addColumns, createDb, SCHEMA_VERSION } from "../src/db.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-upgrade-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** A database as an older build left it: made current, then `change`d and stamped `version`. */
function olderDb(change: string, version = 2): string {
  const file = path.join(tmp, `db-${n++}.db`);
  (createDb(file) as unknown as { $client: Database.Database }).$client.close();
  const raw = new Database(file);
  raw.exec(change);
  raw.pragma(`user_version = ${version}`);
  raw.close();
  return file;
}
const columns = (file: string, table: string) => {
  const raw = new Database(file, { readonly: true });
  try {
    return (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  } finally {
    raw.close();
  }
};
const version = (file: string) => {
  const raw = new Database(file, { readonly: true });
  try {
    return Number(raw.pragma("user_version", { simple: true }));
  } finally {
    raw.close();
  }
};

describe("schema upgrade", () => {
  it("adds the columns an older database lacks and stamps it current", () => {
    const file = olderDb("ALTER TABLE workspace DROP COLUMN ai_base_url; ALTER TABLE users DROP COLUMN passcode_locked_until");
    (createDb(file) as unknown as { $client: Database.Database }).$client.close();
    expect(columns(file, "workspace")).toContain("ai_base_url");
    expect(columns(file, "users")).toContain("passcode_locked_until");
    expect(version(file)).toBe(SCHEMA_VERSION);
  });

  it("stops on an ALTER that fails for another reason, names it, and leaves the version alone", () => {
    // `workspace` is a view here, so adding its columns fails: not "duplicate column".
    const file = olderDb("CREATE TABLE ws_old AS SELECT id, name FROM workspace; DROP TABLE workspace; CREATE VIEW workspace AS SELECT id, name FROM ws_old");
    expect(() => createDb(file)).toThrow(/Schema upgrade failed at `ALTER TABLE workspace ADD COLUMN ai_instructions TEXT`: .*view/i);
    expect(version(file)).toBe(2);
  });

  it("skips a column that is there, and reports a malformed one", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a TEXT)");
    expect(() => addColumns(db, [["t", "a", "TEXT"]])).not.toThrow();
    expect(() => addColumns(db, [["t", "b", "TEXT REFERENCES"]])).toThrow(/Schema upgrade failed at `ALTER TABLE t ADD COLUMN b TEXT REFERENCES`: /);
    db.close();
  });
});
