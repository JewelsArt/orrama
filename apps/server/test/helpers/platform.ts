/**
 * What a test may assume about the platform (audit OPS-003). The suite runs on
 * macOS (where Orrama lives), Linux (CI, Docker) and Windows (where the backup
 * is audited). These name the POSIX-only behaviours, so a test skips exactly
 * the part Windows cannot do, and says why.
 */
import fs from "node:fs";
import path from "node:path";

export const WINDOWS = process.platform === "win32";

/** Windows: chmod only toggles read-only, so permission bits and `chmod 000` mean nothing. */
export const POSIX_MODES = !WINDOWS;

/** Windows: `child.kill("SIGTERM")` ends the process outright; no handler runs. */
export const SIGNAL_HANDLERS = !WINDOWS;

/** Whether this process may create a symlink in `dir` (Windows: admin rights or Developer Mode). */
export function canSymlink(dir: string): boolean {
  const probe = path.join(dir, `.symlink-probe-${process.pid}`);
  try {
    fs.symlinkSync(dir, probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
