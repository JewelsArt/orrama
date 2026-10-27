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
import { addColumns, backupsDir, createDb, SCHEMA_VERSION } from "../src/db.js";

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

/**
 * A copy before a schema upgrade (2E). An update reaches every install, and the build it
 * brings may migrate the database; the old one is copied to `<data dir>/backups` first,
 * the newest three kept. A newer database still refuses, and says where the copies are.
 */
describe("the copy before a schema upgrade", () => {
  /** A data folder of its own: the copies land beside the database. */
  function dataFolder(): string {
    return fs.mkdtempSync(path.join(tmp, "data-"));
  }
  function older(dir: string, version: number): string {
    const file = path.join(dir, "basalt.db");
    (createDb(file) as unknown as { $client: Database.Database }).$client.close();
    const raw = new Database(file);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('kept', 'yes')").run();
    raw.pragma(`user_version = ${version}`);
    raw.close();
    return file;
  }
  const open = (file: string) => (createDb(file) as unknown as { $client: Database.Database }).$client.close();
  const copies = (dir: string) => (fs.existsSync(path.join(dir, "backups")) ? fs.readdirSync(path.join(dir, "backups")).sort() : []);

  it("copies an older database before upgrading it, as it was", () => {
    const dir = dataFolder();
    const file = older(dir, 4);
    open(file);
    const made = copies(dir);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/^basalt-schema-4-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    const copy = path.join(backupsDir(file), made[0]!);
    expect(version(copy)).toBe(4);
    expect(version(file)).toBe(SCHEMA_VERSION);
    const raw = new Database(copy, { readonly: true });
    expect(raw.prepare("SELECT value FROM meta WHERE key = 'kept'").get()).toEqual({ value: "yes" });
    raw.close();
    if (process.platform !== "win32") expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
  });

  it("makes no copy of a new database or of a current one", () => {
    const dir = dataFolder();
    const file = path.join(dir, "basalt.db");
    open(file);
    open(file);
    expect(copies(dir)).toEqual([]);
  });

  it("keeps the newest three copies", () => {
    const dir = dataFolder();
    const file = older(dir, 3);
    fs.mkdirSync(backupsDir(file));
    const day = 24 * 3600 * 1000;
    ["basalt-schema-1-2026-01-01-000000.db", "basalt-schema-2-2026-02-01-000000.db", "basalt-schema-3-2026-03-01-000000.db", "keep-me.db"].forEach((n, i) => {
      const f = path.join(backupsDir(file), n);
      fs.writeFileSync(f, "");
      fs.utimesSync(f, new Date(Date.now() - (5 - i) * day), new Date(Date.now() - (5 - i) * day));
    });
    open(file);
    const left = copies(dir);
    expect(left).toHaveLength(4);
    expect(left).toContain("keep-me.db");
    expect(left).toContain("basalt-schema-2-2026-02-01-000000.db");
    expect(left).toContain("basalt-schema-3-2026-03-01-000000.db");
    expect(left.filter((n) => n.startsWith("basalt-schema-3-") && n !== "basalt-schema-3-2026-03-01-000000.db")).toHaveLength(1);
  });

  it("upgrades nothing when the copy can't be made", () => {
    const dir = dataFolder();
    const file = older(dir, 4);
    fs.writeFileSync(path.join(dir, "backups"), "a file where the folder goes");
    expect(() => createDb(file)).toThrow(/was not upgraded: the copy before the upgrade couldn't be made in .*backups/);
    expect(version(file)).toBe(4);
  });

  it("refuses a newer database and names the folder of copies", () => {
    const dir = dataFolder();
    const file = older(dir, SCHEMA_VERSION + 1);
    expect(() => createDb(file)).toThrow(new RegExp(`newer Orrama.*restore a backup from ${backupsDir(file).replace(/[\\.]/g, "\\$&")}`));
    expect(copies(dir)).toEqual([]);
  });
});
