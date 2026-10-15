/**
 * localStorage that never takes the app down (WEB-025).
 *
 * Everything the app keeps in the browser is a convenience: the theme, a remembered tab, the
 * last address that signed in, and the session token. Storage can refuse all of it: iOS Safari
 * with "Block All Cookies" makes the very getter throw SecurityError, a full quota makes setItem
 * throw, a private window may hand back nothing. None of that is worth a blank page, so every
 * read and write here is guarded, and a value storage refused is kept in memory for the rest of
 * the session instead.
 *
 * New code reads and writes through these. Older screens still call localStorage directly;
 * `guardStorage` (run first thing in main.tsx) keeps those working too, until each screen moves
 * over in its wave.
 */

/** Values storage refused, by key. A key here is answered from memory, not from storage. */
const refused = new Map<string, string | null>();

// globalThis, not window: the same object in a browser, and the one a Node test stubs. Touching
// it can throw, so every caller below does so inside a try.
const store = (): Storage | null => globalThis.localStorage ?? null;

export function readKey(key: string): string | null {
  if (refused.has(key)) return refused.get(key)!;
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeKey(key: string, value: string): void {
  try {
    const s = store();
    if (!s) throw new Error("no storage");
    s.setItem(key, value);
    refused.delete(key);
  } catch {
    // Full or refused: memory stands in until the tab closes, and a stale stored copy (the
    // write that failed was meant to replace it) is never read back.
    refused.set(key, value);
  }
}

export function removeKey(key: string): void {
  try {
    const s = store();
    if (!s) throw new Error("no storage");
    s.removeItem(key);
    refused.delete(key);
  } catch {
    refused.set(key, null);
  }
}

/** A JSON value, or `fallback` when it is missing, unreadable or not valid JSON. */
export function readJson<T>(key: string, fallback: T): T {
  const raw = readKey(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Web Storage over a Map: what the page gets when the browser refuses it the real thing. */
class MemoryStorage implements Storage {
  #items = new Map<string, string>();
  [name: string]: unknown;
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.get(String(key)) ?? null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(String(key));
  }
  setItem(key: string, value: string) {
    this.#items.set(String(key), String(value));
  }
}

/**
 * If merely touching `window.localStorage` throws, give the page an in-memory one, so that code
 * still calling it directly reads and writes instead of throwing during render. Returns true
 * when it had to.
 */
export function guardStorage(win: Window = globalThis as unknown as Window): boolean {
  try {
    void win.localStorage;
    return false;
  } catch {
    Object.defineProperty(win, "localStorage", { value: new MemoryStorage(), configurable: true });
    return true;
  }
}

/**
 * The keys were `basalt-…` until the rename to Orrama (R13): the session token, the theme, every
 * remembered tab, unsaved drafts (`basalt-draft:<id>`). Run first thing in main.tsx, before any
 * screen reads a key, this moves each one to its `orrama-…` name, so the first load of the
 * renamed app keeps you signed in and keeps everything this browser remembered. A move, not a
 * copy: nothing is left under the old name to come back later (a draft discarded under the new
 * name must stay discarded). If the new name already holds a value it wins, and the old one is
 * dropped. A key that cannot be written stays under its old name and is tried again next load.
 */
export function migrateLegacyKeys(): number {
  let moved = 0;
  try {
    const s = store();
    if (!s) return 0;
    const old: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (key?.startsWith("basalt-")) old.push(key);
    }
    for (const key of old) {
      try {
        const value = s.getItem(key);
        const renamed = `orrama-${key.slice("basalt-".length)}`;
        if (value !== null && s.getItem(renamed) === null) s.setItem(renamed, value);
        s.removeItem(key);
        moved++;
      } catch {
        // Full: this one stays where it is, and is tried again on the next load.
      }
    }
  } catch {
    // Storage refused outright: there is nothing to move.
  }
  return moved;
}
