/**
 * The database schema: bootstrap SQL (apps/server/src/db.ts) and the Drizzle
 * tables every query goes through (packages/schema/src/db.ts) are written by
 * hand, twice. CLAUDE.md says to keep them in lockstep; this is what checks.
 * Plus the two pragmas the database opens with.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, SCHEMA_VERSION, tables } from "../src/db.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-schema-"));
// Every handle closed first: Windows cannot delete an open database (EBUSY, OPS-003).
const opened: { close(): void }[] = [];
afterAll(() => {
  for (const h of opened) h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
  const file = path.join(dir, "fresh.db");
  opened.push((createDb(file) as unknown as { $client: { close(): void } }).$client);
  const raw = new Database(file, { readonly: true });
  opened.push(raw);

  it("every Drizzle table exists with exactly its columns", () => {
    const drizzleTables = (Object.values(tables) as unknown[]).filter((t): t is SQLiteTable => t instanceof SQLiteTable);
    expect(drizzleTables.length).toBeGreaterThan(15);
    for (const t of drizzleTables) {
      const cfg = getTableConfig(t);
      const onDisk = (raw.prepare(`PRAGMA table_info(${cfg.name})`).all() as { name: string }[]).map((c) => c.name).sort();
      expect(onDisk, `table ${cfg.name} is missing from the bootstrap SQL`).not.toEqual([]);
      expect(onDisk, `table ${cfg.name}`).toEqual(cfg.columns.map((c) => c.name).sort());
    }
  });

  it("every table the bootstrap makes has a Drizzle definition", () => {
    const known = new Set((Object.values(tables) as unknown[]).filter((t): t is SQLiteTable => t instanceof SQLiteTable).map((t) => getTableConfig(t).name));
    const made = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
    expect(made.filter((n) => !known.has(n))).toEqual([]);
  });

  it("opens with a lock timeout and stamps the schema version", () => {
    const db = createDb(path.join(dir, "pragmas.db"));
    const sqlite = (db as unknown as { $client: Database.Database }).$client;
    opened.push(sqlite);
    expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(sqlite.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("refuses a database written by a newer Orrama", () => {
    const newer = path.join(dir, "newer.db");
    const d = new Database(newer);
    d.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    d.close();
    expect(() => createDb(newer)).toThrow(/newer Orrama/);
  });
});
