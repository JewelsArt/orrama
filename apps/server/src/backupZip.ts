/**
 * The backup's .zip, written and read with node:zlib (backup.ts). No library: what a backup
 * needs is small (stored and deflated entries, UTF-8 names), and what a restore must refuse is
 * specific (a name that climbs out of the folder, an entry that inflates past what it says, a
 * file that is not a zip at all).
 *
 * Writing streams each file through deflate into the open zip, so a vault of any size is never
 * held in memory; sizes and CRCs follow each entry in a data descriptor (flag bit 3), which
 * Finder, Explorer and every unzip read. Reading opens the central directory from the file's
 * tail and inflates one entry at a time into a file, checking its size and CRC.
 *
 * Limits: no ZIP64, so a backup stops at 65,535 entries and 4 GB, with a sentence that says so
 * (a friend's vault is far below either; a bigger one is a follow-up, changes/2F.md).
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import zlib from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const DESCRIPTOR = 0x08074b50;
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0008 | 0x0800;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

export class ZipLimitError extends Error {}

interface Written {
  name: Buffer;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

/** MS-DOS time and date, local, as zips keep them. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Counts and checksums what passes through. */
class Measure extends Transform {
  bytes = 0;
  crc = 0;
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null, data?: Buffer) => void) {
    this.bytes += chunk.length;
    this.crc = zlib.crc32(chunk, this.crc);
    done(null, chunk);
  }
}

/** A zip written front to back into one file. */
export class ZipWriter {
  private offset = 0;
  private readonly entries: Written[] = [];
  private constructor(private readonly fd: number) {}

  static open(file: string): ZipWriter {
    return new ZipWriter(fs.openSync(file, "wx", 0o600));
  }

  get count(): number {
    return this.entries.length;
  }

  private write(buf: Buffer): void {
    let at = 0;
    while (at < buf.length) at += fs.writeSync(this.fd, buf, at, buf.length - at, this.offset + at);
    this.offset += buf.length;
  }

  private header(name: Buffer, method: number, t: { time: number; date: number }): void {
    if (this.entries.length >= MAX_ENTRIES) throw new ZipLimitError(`a backup holds at most ${MAX_ENTRIES} files`);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(LOCAL, 0);
    h.writeUInt16LE(20, 4); // version needed: 2.0
    h.writeUInt16LE(FLAGS, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(t.time, 10);
    h.writeUInt16LE(t.date, 12);
    // CRC and sizes are in the descriptor after the data.
    h.writeUInt16LE(name.length, 26);
    this.write(h);
    this.write(name);
  }

  private finishEntry(name: Buffer, method: number, t: { time: number; date: number }, offset: number, crc: number, compSize: number, size: number): void {
    if (this.offset > MAX_BYTES || size > MAX_BYTES) throw new ZipLimitError("a backup can be at most 4 GB");
    const d = Buffer.alloc(16);
    d.writeUInt32LE(DESCRIPTOR, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(compSize, 8);
    d.writeUInt32LE(size, 12);
    this.write(d);
    this.entries.push({ name, method, crc: crc >>> 0, compSize, size, offset, ...t });
  }

  /** A small entry from memory (the README, the JSON). */
  addBuffer(name: string, data: Buffer | string, mtime = new Date()): void {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const n = Buffer.from(name, "utf8");
    const t = dosTime(mtime);
    const offset = this.offset;
    this.header(n, 8, t);
    const packed = zlib.deflateRawSync(buf);
    this.write(packed);
    this.finishEntry(n, 8, t, offset, zlib.crc32(buf), packed.length, buf.length);
  }

  /** A file from disk, streamed through deflate. */
  async addFile(name: string, file: string): Promise<void> {
    const stat = fs.statSync(file);
    const n = Buffer.from(name, "utf8");
    const t = dosTime(stat.mtime);
    const offset = this.offset;
    this.header(n, 8, t);
    const measure = new Measure();
    const self = this;
    let compSize = 0;
    await pipeline(fs.createReadStream(file), measure, zlib.createDeflateRaw({ level: 6 }), async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        compSize += chunk.length;
        self.write(chunk);
        if (self.offset > MAX_BYTES) throw new ZipLimitError("a backup can be at most 4 GB");
      }
    });
    this.finishEntry(n, 8, t, offset, measure.crc, compSize, measure.bytes);
  }

  /** The central directory and its end record; closes the file. */
  close(): void {
    try {
      const start = this.offset;
      for (const e of this.entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(CENTRAL, 0);
        c.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0 (keeps the mode below)
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(FLAGS, 8);
        c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(e.time, 12);
        c.writeUInt16LE(e.date, 14);
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.compSize, 20);
        c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.name.length, 28);
        c.writeUInt32LE((0o100600 << 16) >>> 0, 38); // a regular file, owner read/write
        c.writeUInt32LE(e.offset, 42);
        this.write(c);
        this.write(e.name);
      }
      const size = this.offset - start;
      if (this.offset > MAX_BYTES) throw new ZipLimitError("a backup can be at most 4 GB");
      const end = Buffer.alloc(22);
      end.writeUInt32LE(END, 0);
      end.writeUInt16LE(this.entries.length, 8);
      end.writeUInt16LE(this.entries.length, 10);
      end.writeUInt32LE(size, 12);
      end.writeUInt32LE(start, 16);
      this.write(end);
    } finally {
      fs.closeSync(this.fd);
    }
  }

  /** Give up: close the file, written or not. */
  abandon(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

export interface ZipItem {
  name: string;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  offset: number;
}

/** Not a zip, a damaged one, or one that says something it isn't: the route answers 422. */
export class ZipReadError extends Error {}

function readAt(fd: number, length: number, position: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, position + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** A zip opened for reading: its directory, and each entry on request. */
export class ZipReader {
  private constructor(
    private readonly fd: number,
    readonly items: ZipItem[],
  ) {}

  static open(file: string): ZipReader {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const tailLen = Math.min(size, 22 + 0xffff);
      const tail = readAt(fd, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === END) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new ZipReadError("not a zip file");
      const count = tail.readUInt16LE(eocd + 10);
      const dirSize = tail.readUInt32LE(eocd + 12);
      const dirStart = tail.readUInt32LE(eocd + 16);
      if (dirStart + dirSize > size) throw new ZipReadError("the zip's directory is cut off");
      const dir = readAt(fd, dirSize, dirStart);
      const items: ZipItem[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw new ZipReadError("the zip's directory is damaged");
        const nameLen = dir.readUInt16LE(p + 28);
        const extraLen = dir.readUInt16LE(p + 30);
        const commentLen = dir.readUInt16LE(p + 32);
        items.push({
          name: dir.toString("utf8", p + 46, p + 46 + nameLen),
          method: dir.readUInt16LE(p + 10),
          crc: dir.readUInt32LE(p + 16),
          compSize: dir.readUInt32LE(p + 20),
          size: dir.readUInt32LE(p + 24),
          offset: dir.readUInt32LE(p + 42),
        });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return new ZipReader(fd, items);
    } catch (err) {
      fs.closeSync(fd);
      throw err instanceof ZipReadError ? err : new ZipReadError("not a zip file");
    }
  }

  get(name: string): ZipItem | undefined {
    return this.items.find((i) => i.name === name);
  }

  /** The streams that give an entry's data, inflated, failing on a wrong size or CRC. */
  private stages(item: ZipItem): (Readable | Transform)[] {
    const lh = readAt(this.fd, 30, item.offset);
    if (lh.length < 30 || lh.readUInt32LE(0) !== LOCAL) throw new ZipReadError(`${item.name} is not where the zip says`);
    if (item.method !== 0 && item.method !== 8) throw new ZipReadError(`${item.name} is packed in a way Orrama doesn't read`);
    const start = item.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const raw = fs.createReadStream("", { fd: this.fd, start, end: start + item.compSize - 1, autoClose: false });
    const measure = new Measure();
    const verify = new Transform({
      transform(chunk: Buffer, _enc, done) {
        if (measure.bytes > item.size) return done(new ZipReadError(`${item.name} is larger than the zip says`));
        done(null, chunk);
      },
      flush(done) {
        if (measure.bytes !== item.size || measure.crc >>> 0 !== item.crc) return done(new ZipReadError(`${item.name} is damaged`));
        done();
      },
    });
    // Past the size the zip states, `verify` stops the whole pipeline: a bomb inflates no further.
    return item.method === 8 ? [raw, zlib.createInflateRaw(), measure, verify] : [raw, measure, verify];
  }

  /** Write one entry to `file` (made with `mode`), checking size and CRC. */
  async extractTo(item: ZipItem, file: string, mode = 0o600): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (item.size === 0 && item.compSize <= 2) {
      fs.writeFileSync(file, "", { mode });
      return;
    }
    try {
      await pipeline([...this.stages(item), fs.createWriteStream(file, { mode })] as unknown as readonly NodeJS.ReadWriteStream[]);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err instanceof ZipReadError ? err : new ZipReadError(`${item.name} is damaged`);
    }
  }

  /** One small entry in memory, refused past `max` bytes. */
  async read(item: ZipItem, max: number): Promise<Buffer> {
    if (item.size > max) throw new ZipReadError(`${item.name} is larger than expected`);
    if (item.size === 0 && item.compSize <= 2) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    try {
      await pipeline([
        ...this.stages(item),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) parts.push(chunk);
        },
      ] as unknown as readonly NodeJS.ReadWriteStream[]);
    } catch (err) {
      throw err instanceof ZipReadError ? err : new ZipReadError(`${item.name} is damaged`);
    }
    return Buffer.concat(parts);
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

/**
 * A zip entry's name as a relative path under a folder, or null when it is not one a backup
 * may write: absolute, a drive or a share, `..` anywhere, a backslash (a Windows separator in a
 * name lets `..\..` through a check that only splits on `/`), or empty parts.
 */
export function safeEntryPath(name: string): string[] | null {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-zA-Z]:/.test(name)) return null;
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts;
}
