/**
 * What the request log may say about a request.
 *
 * Fastify logs every request's URL, and under launchd that log is a plain file
 * (~/.orrama-run/server.log) that is never rotated. Secrets rode in URLs: the
 * live-sync socket put the 30-day session token in `?token=` and reconnected
 * every two seconds while offline, and the calendar feed's secret IS its path
 * (`/ics/<token>.ics`) — Google polls it hourly. By September the log held
 * 5,485 lines carrying a session token, and search terms besides (audit B7).
 *
 * So the log gets the route, never the query string, and never a secret path
 * segment. Tokens have also left the socket URL (routes/ws.ts), but redaction
 * does not depend on that: any client, old or new, gets the same treatment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";

/** A URL with its query string dropped and any secret path segment masked. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  const path = q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
  // /ics/<token>.ics — the token is the whole credential for the feed.
  return path.replace(/^\/ics\/[^/?]+/, "/ics/[redacted]");
}

/** Replaces Fastify's default `req` serializer, field for field, with a redacted URL. */
export function reqSerializer(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Fields of a logged error that carry what was sent or received. The AI SDK's
 * errors hold the whole request — APICallError.requestBodyValues is the
 * prompt, notes and all, and RetryError repeats it once per attempt in
 * `errors`/`lastError` — and pino copied every one into server.log (audit
 * AI-008). They are left out, whoever throws them.
 */
const BODY_FIELDS = new Set(["requestBodyValues", "responseBody", "responseHeaders", "errors", "lastError", "aggregateErrors", "data", "value", "text", "prompt"]);

/** Replaces pino's `err` serializer: type, message, stack and the error's own fields, less any body. */
export function errSerializer(err: Error, depth = 0): { [key: string]: unknown; type: string; message: string; stack: string } {
  const out: { [key: string]: unknown; type: string; message: string; stack: string } = { type: err.constructor?.name ?? "Error", message: err.message, stack: err.stack ?? "" };
  for (const [k, v] of Object.entries(err)) {
    if (!BODY_FIELDS.has(k) && !(k in out)) out[k] = v;
  }
  delete out["cause"];
  if (err.cause instanceof Error && depth < 3) out["cause"] = errSerializer(err.cause, depth + 1);
  return out;
}

/**
 * Make the log file readable by its owner only.
 *
 * launchd opens StandardOutPath with the default umask, so the log came out
 * 0644: readable by every account and process on the machine. The server is
 * the one thing that knows it is writing to a file, so it tightens that file
 * itself, on every boot — no plist change to remember, and a new or rotated
 * log is fixed the next time the agent starts. A terminal or a pipe is left
 * alone. Returns the descriptors it changed.
 */
export function privateLogFiles(fds: number[] = [1, 2]): number[] {
  const changed: number[] = [];
  for (const fd of fds) {
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) === 0) continue;
      fs.fchmodSync(fd, st.mode & 0o700);
      changed.push(fd);
    } catch {
      // Not a file we can inspect: nothing to do.
    }
  }
  return changed;
}

/** Past this the log is rotated: one previous generation is kept, so ~10 MB at most. */
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/**
 * The server's own log: where the launchd agent sends stdout and stderr
 * (dev.orrama.server.plist), or, in the desktop app, `ORRAMA_LOG_FILE`, the file the shell
 * hands the server as stdout and stderr (`<data dir>/logs/server.log`).
 */
export const agentLog = (e: NodeJS.ProcessEnv = process.env): string =>
  e.ORRAMA_LOG_FILE ? path.resolve(e.ORRAMA_LOG_FILE) : path.join(os.homedir(), ".orrama-run", "server.log");
export const AGENT_LOG = agentLog();

/**
 * Keep the agent's log from growing forever (audit B7). launchd opens
 * StandardOutPath once, in append mode, and never rotates it; by September it
 * was 6.4 MB and climbing. newsyslog would need a system config and sudo, so
 * the server does it: when its stdout IS that file (same device and inode —
 * never a file it merely has the name of) and the file is past the cap, the
 * contents move to `server.log.1` (owner-only, replacing the previous one) and
 * the file is truncated in place. Append mode means the next write lands at
 * the new end. Lines written between the copy and the truncate — a few
 * milliseconds — are lost. Returns whether it rotated.
 *
 * Truncated by its name, just checked to be the same file, not through `fd`:
 * Windows opens an append-mode handle with append rights only, and refuses
 * to truncate through it (audit OPS-003).
 */
export function rotateLogIfLarge(opts: { fd?: number; file?: string; maxBytes?: number } = {}): boolean {
  const { fd = 1, file = AGENT_LOG, maxBytes = LOG_ROTATE_BYTES } = opts;
  try {
    const open = fs.fstatSync(fd);
    const named = fs.statSync(file);
    if (!open.isFile() || open.dev !== named.dev || open.ino !== named.ino) return false;
    if (open.size <= maxBytes) return false;
    const previous = `${file}.1`;
    fs.copyFileSync(file, previous);
    fs.chmodSync(previous, 0o600);
    fs.truncateSync(file, 0);
    return true;
  } catch {
    // No such file, not ours, or not a file: a terminal or a pipe needs nothing.
    return false;
  }
}
