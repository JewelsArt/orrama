/**
 * Failed-login throttle, per client address.
 *
 * Argon2 makes each guess slow but not rare: a script on the LAN or the
 * tailnet could still try thousands of passwords a day against the one
 * account that matters. After MAX_FAILS wrong passwords inside WINDOW_MS from
 * one address, that address gets a 429 until the oldest of them ages out —
 * even with the RIGHT password, or a lockout would be an oracle.
 *
 * Keyed on the socket address (`req.ip` with trustProxy off), never on a
 * forwarded header, which the client writes. Keyed on the address rather than
 * the email so a stranger cannot lock Jules out of his own account from
 * outside; the passcode unlock keeps its own per-account lockout.
 *
 * In memory on purpose: a restart forgetting the count is fine — launchd
 * restarts are rare and an attacker cannot trigger one.
 */
export const MAX_FAILS = 5;
export const WINDOW_MS = 15 * 60_000;
/** Bound on tracked addresses, so a spray of sources cannot grow the map forever. */
const MAX_KEYS = 10_000;

export class LoginLimiter {
  private fails = new Map<string, number[]>();

  constructor(private now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - WINDOW_MS;
    const kept = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.fails.set(key, kept);
    else this.fails.delete(key);
    return kept;
  }

  /** Milliseconds until this address may try again; 0 when it may now. */
  retryAfter(key: string): number {
    const kept = this.recent(key);
    if (kept.length < MAX_FAILS) return 0;
    return kept[kept.length - MAX_FAILS]! + WINDOW_MS - this.now();
  }

  fail(key: string): void {
    const kept = this.recent(key);
    if (!this.fails.has(key) && this.fails.size >= MAX_KEYS) {
      const oldest = this.fails.keys().next().value;
      if (oldest !== undefined) this.fails.delete(oldest);
    }
    this.fails.set(key, [...kept, this.now()]);
  }

  succeed(key: string): void {
    this.fails.delete(key);
  }
}
