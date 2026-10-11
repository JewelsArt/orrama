/**
 * Uploads into the vault never replace a file (audit STO-006).
 *
 * Both upload routes wrote the name the browser sent with writeFileAtomic,
 * which renames over whatever is there: October's `payslip.pdf` destroyed
 * September's, a second `report.docx` on a project's board replaced the
 * first, and the answer was 200. These are real files in Jules's vault, with
 * no history and no other copy.
 *
 * Now: the same bytes already there (under any spelling the disk folds
 * together) is that file, unchanged. A different file with that name is kept
 * as `name (2).ext` — the next free one — and the caller is told the name it
 * was stored under. The write itself is exclusive, so a file that appears
 * between the look and the write is not replaced either.
 */
import fs from "node:fs";
import path from "node:path";
import { foldPath } from "@basalt/core";
import { writeFileAtomic } from "./atomicWrite.js";

export interface StoredUpload {
  /** The name the file is stored under — the one asked for, or `name (n).ext`. */
  name: string;
  /** The same bytes were already there under that name: nothing was written. */
  unchanged: boolean;
}

/** `name (n).ext` for n = 2, 3, … */
function numbered(name: string, n: number): string {
  const ext = path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

export function storeUpload(dir: string, name: string, data: Uint8Array): StoredUpload {
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 1; n < 1000; n++) {
    const want = n === 1 ? name : numbered(name, n);
    const held = fs.readdirSync(dir).find((e) => e === want) ?? fs.readdirSync(dir).find((e) => foldPath(e) === foldPath(want));
    if (held !== undefined) {
      const abs = path.join(dir, held);
      if (fs.statSync(abs).isFile() && Buffer.from(data).equals(fs.readFileSync(abs))) return { name: held, unchanged: true };
      continue;
    }
    try {
      writeFileAtomic(path.join(dir, want), data, { exclusive: true });
      return { name: want, unchanged: false };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`no free name for ${name}`);
}
