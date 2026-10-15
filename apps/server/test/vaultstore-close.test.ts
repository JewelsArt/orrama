/**
 * Once the vault store closes, nothing it scheduled reaches the database.
 * server.test.ts loads its store again (the re-index tests), and each load()
 * started a new chokidar watcher over the old one, which stayed open with its
 * listeners. close() closed only the newest. When afterAll then deleted the
 * vault, the old watchers reported the unlinks, a 300 ms settle timer was set,
 * and it fired into the database app.close() had just closed: "The database
 * connection is not open", thrown from a timer, an uncaught error that fails
 * a Vitest run with every test green (seen three times on 14 Oct 2026).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-store-close-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const vault = process.env.ORRAMA_VAULT_DIR;
fs.mkdirSync(vault, { recursive: true });
const { createDb } = await import("../src/db.js");
const { closeDb } = await import("./helpers/db.js");
const { VaultStore } = await import("../src/vaultStore.js");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true }));

type Watcher = {
  closed: boolean;
  close(): Promise<void>;
  emit(event: string, ...args: unknown[]): boolean;
  listenerCount(event: string): number;
};
const watcherOf = (store: InstanceType<typeof VaultStore>) => (store as unknown as { watcher: Watcher }).watcher;

/** A loaded store over a vault holding `name`.md, and a folder `dir` with a note the store has not seen. */
async function storeWith(name: string, dir: string) {
  fs.writeFileSync(path.join(vault, `${name}.md`), `# ${name}\n`);
  const db = createDb();
  const store = new VaultStore(db);
  store.load();
  await store.watching;
  const unlinkAndNewFolder = (w: Watcher) => {
    fs.rmSync(path.join(vault, `${name}.md`));
    w.emit("all", "unlink", path.join(vault, `${name}.md`));
    fs.mkdirSync(path.join(vault, dir));
    fs.writeFileSync(path.join(vault, dir, "New.md"), "# New\n");
    w.emit("all", "addDir", path.join(vault, dir));
  };
  return { db, store, unlinkAndNewFolder };
}

/** What ran after close: a throw from a timer, or a database error handleExternalChange caught and logged. */
function runTimersAfterClose() {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  // Past the 300 ms settle and the new folder's 1 s second look.
  expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
  expect(logged).not.toHaveBeenCalled();
}

it("an event delivered while the store closes sets no timer into the closed database", async () => {
  const { db, store, unlinkAndNewFolder } = await storeWith("During", "DuringDir");
  const watcher = watcherOf(store);
  const realClose = watcher.close.bind(watcher);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  watcher.close = () => held.then(realClose);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const closing = store.close();
  unlinkAndNewFolder(watcher);
  release();
  await closing;
  closeDb(db);
  runTimersAfterClose();
});

it("a watcher still delivering after close schedules nothing", async () => {
  const { db, store, unlinkAndNewFolder } = await storeWith("After", "AfterDir");
  const watcher = watcherOf(store);
  const realClose = watcher.close.bind(watcher);
  watcher.close = async () => {}; // as a watcher close() never reached: it keeps its listeners
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await store.close();
  closeDb(db);
  unlinkAndNewFolder(watcher);
  try {
    runTimersAfterClose();
  } finally {
    await realClose();
  }
});

it("loading again closes the watcher it replaces", async () => {
  const { db, store } = await storeWith("Reload", "ReloadDir");
  const first = watcherOf(store);
  store.load();
  await store.watching;
  try {
    expect(watcherOf(store)).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(first.listenerCount("all")).toBe(0);
  } finally {
    await store.close();
    closeDb(db);
  }
});
