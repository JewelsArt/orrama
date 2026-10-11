/**
 * Office documents (.docx, .xlsx, .pptx) are zips, read with node:zlib here
 * rather than trusted to a library, because what matters is the ceiling. A
 * zip states each part's size and nothing makes it honest: a 60 KB .docx
 * whose document.xml inflates to 20 MB took mammoth 9 s and 1.7 GB, and a
 * slightly larger one is an out-of-memory crash of the whole server (audit
 * INP-004). So every part is inflated with `maxOutputLength`, and before
 * mammoth or exceljs sees a document, every part of it has been inflated
 * against a cap for any one XML part and a cap for the whole — on zlib's
 * thread pool, not the event loop.
 */
import fs from "node:fs";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { HttpError } from "./vaultStore.js";

export interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  offset: number;
}

/** Over a cap: the route answers 413. Anything else thrown here means the file is not a readable zip (422). */
export class TooLargeError extends Error {}

export interface InflateCaps {
  /** The file on disk. Uploads stop at 25 MB; a file dropped into the vault from Finder does not. */
  fileBytes: number;
  /** Any one XML part (.xml, .rels), inflated: what the parsers turn into a tree. */
  xmlBytes: number;
  /** Every part together, inflated, images included. */
  totalBytes: number;
}

/**
 * mammoth's cost grows with document.xml: at 8 MB (a long book, and the most
 * paragraph-dense one we could build) it took 1.2 s and 1.1 GB, with the
 * event loop held for half a second at a time; at 20 MB, 9 s and 1.7 GB.
 */
export const DOCX_CAPS: InflateCaps = { fileBytes: 80 * 1024 * 1024, xmlBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };
/**
 * exceljs yields to the event loop as it reads but holds every row: a 28 MB
 * sheet is ~100,000 rows and 370 MB. Statements and data dumps fit; a bomb
 * does not.
 */
export const XLSX_CAPS: InflateCaps = { fileBytes: 80 * 1024 * 1024, xmlBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };

/** Every entry the central directory lists, duplicates included. */
export function readCentralDirectory(buf: Buffer): ZipEntry[] {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** An entry's compressed bytes, or null when its local header is not where the directory says. */
function entryData(buf: Buffer, e: ZipEntry): Buffer | null {
  const lh = e.offset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  return buf.subarray(start, start + e.compSize);
}

/** One part's bytes, or null when it is absent, unsupported or over `max`. */
export function extract(buf: Buffer, entries: Map<string, ZipEntry>, name: string, max: number): Buffer | null {
  const e = entries.get(name);
  if (!e || e.size > max) return null;
  const data = entryData(buf, e);
  if (!data) return null;
  try {
    if (e.method === 0) return data.length <= max ? data : null;
    // The declared size is the zip's claim; maxOutputLength is the enforcement.
    if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, max) });
  } catch {
    return null;
  }
  return null;
}

const inflateRaw = promisify(zlib.inflateRaw);
const isXml = (name: string) => /\.(xml|rels)$/i.test(name);

/**
 * Inflate every part of `buf` and throw TooLargeError the moment an XML part
 * or the whole outgrows its cap. The declared sizes are not believed: each
 * inflate stops at what is left of its cap.
 */
export async function assertInflatesWithin(buf: Buffer, caps: InflateCaps): Promise<void> {
  if (buf.length > caps.fileBytes) throw new TooLargeError("file too large");
  let total = 0;
  for (const e of readCentralDirectory(buf)) {
    const cap = Math.min(isXml(e.name) ? caps.xmlBytes : Infinity, caps.totalBytes - total);
    const data = entryData(buf, e);
    if (!data) throw new Error("corrupt zip entry");
    let size: number;
    if (e.method === 0) size = data.length;
    else if (e.method === 8) {
      try {
        size = (await inflateRaw(data, { maxOutputLength: Math.max(1, cap) })).length;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new TooLargeError("inflates past its cap");
        throw err;
      }
    } else throw new Error("unsupported zip compression");
    if (size > cap) throw new TooLargeError("inflates past its cap");
    total += size;
  }
}

/** A document's bytes, read once its size on disk and every part's inflated size are within `caps`. */
export async function readOfficeFile(abs: string, caps: InflateCaps): Promise<Buffer<ArrayBuffer>> {
  if ((await fs.promises.stat(abs)).size > caps.fileBytes) throw new TooLargeError("file too large");
  const buf = await fs.promises.readFile(abs);
  await assertInflatesWithin(buf, caps);
  return buf;
}

/** For a route's `.catch`: over a cap is a 413, anything else a document that cannot be read is a 422 — never a 500. */
export const officeRefusal =
  (what: string) =>
  (err: unknown): never => {
    if (err instanceof TooLargeError) throw new HttpError(413, `${what} too large to preview`);
    throw new HttpError(422, `could not read this ${what}`);
  };
