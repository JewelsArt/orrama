/**
 * The Y.Doc cache is bounded. It was a Map that only grew: every note ever
 * opened or written stayed in memory for the life of the process. An evicted
 * note must come back from its log exactly — edits after eviction included.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-doccache-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
process.env.ORRAMA_DOC_CACHE = "2";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const { replay } = await import("../src/history.js");

const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("Y.Doc cache", () => {
  it("holds at most the configured number of docs, and an evicted note still edits and replays exactly", () => {
    const owner = b.db.select().from(tables.users).where(eq(tables.users.username, "jules")).get()!;
    const jules = b.store.aclUser(owner.id);
    const paths = [1, 2, 3, 4, 5].map((i) => `Shared/Cache ${i}.md`);
    for (const p of paths) b.store.write(jules, p, `# ${p}\n\nfirst\n`);
    for (const p of paths) b.store.write(jules, p, `${b.store.index.getByPath(p)!.content}second\n`);
    expect(b.store.cachedDocs).toBeLessThanOrEqual(2);

    // Cache 1 was evicted long ago; edit it again and check file, index and log agree.
    const first = b.store.index.getByPath(paths[0]!)!;
    b.store.write(jules, first.path, `${first.content}third\n`);
    const onDisk = fs.readFileSync(path.join(process.env.ORRAMA_VAULT_DIR!, first.path), "utf8");
    expect(onDisk).toMatch(/first\nsecond\nthird\n$/);
    const log = b.db.select().from(tables.ydocUpdates).where(eq(tables.ydocUpdates.noteId, first.id)).orderBy(asc(tables.ydocUpdates.id)).all();
    const texts: string[] = [];
    replay(log, (_r, text) => texts.push(text));
    expect(texts[texts.length - 1]).toBe(onDisk);
    // …and eviction cost memory, not history: the revisions from before it are still there.
    expect(texts.some((t) => t.endsWith("first\n"))).toBe(true);
    expect(texts.some((t) => t.endsWith("first\nsecond\n"))).toBe(true);
    expect(b.store.cachedDocs).toBeLessThanOrEqual(2);
  });
});
