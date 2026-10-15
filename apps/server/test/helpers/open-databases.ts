/**
 * Every test file closes every database it opens (audit OPS-003). Windows
 * cannot delete an open file: a handle left open made the folder's cleanup
 * fail with EBUSY, and the whole file failed there while macOS, which unlinks
 * open files, stayed green. This makes the leak fail here too.
 */
import Database from "better-sqlite3";
import { afterAll } from "vitest";

type Db = Database.Database;
const g = globalThis as { __orramaDbs?: Set<Db>; __orramaDbsHooked?: boolean };
g.__orramaDbs = new Set();
if (!g.__orramaDbsHooked) {
  g.__orramaDbsHooked = true;
  const proto = Database.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ["prepare", "pragma", "exec"]) {
    const orig = proto[m]!;
    proto[m] = function (this: Db, ...a: unknown[]) {
      g.__orramaDbs?.add(this);
      return orig.apply(this, a);
    };
  }
}

afterAll(() => {
  const left = [...(g.__orramaDbs ?? [])].filter((d) => d.open && !d.memory).map((d) => d.name);
  if (left.length) throw new Error(`left a database open (Windows cannot delete it: EBUSY): ${left.join(", ")}`);
});
