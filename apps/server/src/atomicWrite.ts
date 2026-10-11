/**
 * Replace a file's contents all at once, or not at all (audit, root cause 4).
 *
 * Every vault write was a bare fs.writeFileSync: it truncates the note, then
 * writes the new bytes. A crash, a full disk or a power cut in between left a
 * note empty or half-written — in the folder Obsidian has open, with nothing
 * to restore it from but the Y.Doc log. Now the bytes go to a temp file in the
 * same folder, are flushed to disk, and only then renamed over the note: a
 * rename within one filesystem is atomic, so a reader (Obsidian, the watcher,
 * a crash) sees the old note or the new one, never a part of either.
 *
 * - The temp file is hidden (`.name.<pid>.<rand>.tmp`): the vault watcher and
 *   Obsidian both skip dotfiles, so a write in progress is never indexed.
 * - An existing file keeps its permission bits (a rename would otherwise give
 *   the note the umask's).
 * - A symlinked note is written at its target, so the link survives.
 * - Side effect: the note is a new file on every save, so its creation time is
 *   the last save. Only a DB-less rebuild reads creation time (noteIds.ts),
 *   and there the choice of owner costs nothing — the history went with the DB.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * `exclusive`: create the file, never replace one (audit WEB-001, STO-006). The
 * temp file is hard-linked to the name instead of renamed over it, and a link
 * fails with EEXIST when the name is taken — in any spelling the volume folds
 * together — so a file that appeared since the caller looked is not lost.
 */
export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { exclusive?: boolean } = {}): void {
  let target = file;
  let mode: number | undefined;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    // New file: written where it was asked for, with the default mode.
  }
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, "wx", mode ?? 0o666);
    fs.writeFileSync(fd, data);
    if (mode !== undefined) fs.fchmodSync(fd, mode); // openSync's mode is filtered by the umask
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (opts.exclusive) {
      fs.linkSync(tmp, target);
      fs.rmSync(tmp);
    } else {
      fs.renameSync(tmp, target);
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // The rename itself lives in the directory: flush that too, where the OS
  // allows opening a directory (not on Windows).
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    // best effort
  }
}
