/**
 * What the request log may say about a request.
 *
 * Fastify logs every request's URL, and under launchd that log is a plain file
 * (~/.basalt-run/server.log) that is never rotated. Secrets rode in URLs: the
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
