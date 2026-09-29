/**
 * Is this module the program being run, or was it imported?
 *
 * main.ts used to ask `path.resolve(argv[1]).includes("main.ts")`. A compiled
 * build runs `dist/main.js`, which never contains "main.ts", so the server
 * started and exited silently with code 0; and anything whose path merely
 * contains the string (`domain.ts`, `main.tsx`) counted as the entry. Compare
 * the real files instead — symlinks resolved on both sides.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isEntry(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(fileURLToPath(moduleUrl)) === real(argv1);
}
