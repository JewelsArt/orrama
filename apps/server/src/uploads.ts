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
export function numbered(name: string, n: number): string {
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

/**
 * The Content-Disposition for serving a vault file under its own name (audit
 * INP-001). Node refuses any header byte above U+00FF, and on a streamed reply
 * that refusal is thrown outside every handler: opening `Jules’s CV.pdf`, a
 * macOS screenshot (U+202F before "PM") or `Rapport – v2.pdf` killed the
 * server. RFC 6266: an ASCII fallback for old clients, and the real name in
 * `filename*` as UTF-8, percent-encoded (RFC 5987).
 */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Characters no filename of ours may hold: C0 and C1 controls, DEL, and the
 *  Unicode line and paragraph separators. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
