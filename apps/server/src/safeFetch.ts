/**
 * Outbound requests to URLs a user typed: subscribed calendars and webhooks.
 *
 * Both went through plain `fetch` with whatever URL was saved, so the server
 * would request `http://127.0.0.1:…`, a router's admin page, a NAS on the LAN,
 * or 169.254.169.254 (a cloud host's metadata service) on the user's behalf —
 * and the feed's `lastError` ("feed returned 401") and the hook's `lastStatus`
 * reported what answered, which is a port scanner (SSRF). ICS also followed
 * redirects blindly, so a public URL could bounce the request inward.
 *
 * Now:
 * - only http(s);
 * - every address a host resolves to must be public — checked in the socket's
 *   own `lookup`, i.e. at connect time, so DNS that answers public for a check
 *   and private for the connection (rebinding) is caught too; IP literals are
 *   checked before connecting, because Node does not look those up;
 * - redirects are followed by hand, at most 3, each hop checked the same way,
 *   and only for GET;
 * - callers get a coarse outcome, not the upstream's status or error text.
 *
 * A private target that is really wanted (a calendar on the NAS, a host on the
 * tailnet, a test server) is named in ORRAMA_FETCH_ALLOW: hosts or CIDRs,
 * comma-separated. Nothing private is reachable without it.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class BlockedTargetError extends Error {}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
/**
 * IPv6. Besides loopback, private, link-local and multicast, every range that
 * carries or reaches an IPv4 address is refused whole, whatever IPv4 it holds:
 * IPv4-compatible (::/96, `::127.0.0.1`), IPv4-translated (::ffff:0:0:0/96),
 * NAT64 (64:ff9b::/96 and the local-use 64:ff9b:1::/48), 6to4 (2002::/16)
 * and Teredo (2001::/32). On a host with a 6to4 relay, Teredo or a NAT64
 * translator each of them reaches the private IPv4 they wrap, and all of them
 * read as public (audit INP-005). Refusing the whole range rather than judging
 * the IPv4 inside costs nothing real: no calendar or webhook lives on these
 * deprecated transition paths. Plus deprecated site-local (fec0::/10) and the
 * ranges that are never on the internet: documentation (2001:db8::/32,
 * 3fff::/20), benchmarking (2001:2::/48), discard (100::/64).
 * IPv4-mapped (::ffff:0:0/96) is matched against the IPv4 list by BlockList.
 */
for (const [addr, prefix] of [
  ["::", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:2::", 48],
  ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

/** An allow-list entry: a hostname, or an address/CIDR. */
function allowList(): { hosts: Set<string>; nets: net.BlockList } {
  const hosts = new Set<string>();
  const nets = new net.BlockList();
  for (const raw of (process.env.ORRAMA_FETCH_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = raw.split("/");
    const v = net.isIP(addr!);
    if (v) nets.addSubnet(addr!, prefix ? Number(prefix) : v === 4 ? 32 : 128, v === 4 ? "ipv4" : "ipv6");
    else hosts.add(raw.toLowerCase());
  }
  return { hosts, nets };
}

/** True for an address the server may reach without being told to. */
export function isPublicAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 0) return false;
  // BlockList matches IPv4-mapped IPv6 (::ffff:127.0.0.1, and the hex form
  // ::ffff:7f00:1 that URL parsing produces) against the IPv4 subnets itself.
  return !blocked.check(ip, v === 6 ? "ipv6" : "ipv4");
}

const permitted = (ip: string, host: string) => {
  if (isPublicAddress(ip)) return true;
  const allow = allowList();
  return allow.hosts.has(host.toLowerCase()) || allow.nets.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");
};

export interface SafeResponse {
  status: number;
  text: string;
}

export interface SafeRequest {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  /** GET only; each hop is checked like the first. */
  maxRedirects?: number;
}

function once(url: URL, req: SafeRequest): Promise<{ status: number; location: string | null; text: string }> {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && !permitted(host, host)) return reject(new BlockedTargetError("address not allowed"));
    const lookup: net.LookupFunction = (hostname, options, cb) => {
      dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
        if (err) return (cb as (e: Error | null, a: string, f: number) => void)(err, "", 0);
        const bad = addrs.find((a) => !permitted(a.address, hostname));
        if (bad || addrs.length === 0) {
          return (cb as (e: Error | null, a: string, f: number) => void)(new BlockedTargetError("address not allowed"), "", 0);
        }
        if ((options as dns.LookupOptions).all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addrs);
        else (cb as (e: null, a: string, f: number) => void)(null, addrs[0]!.address, addrs[0]!.family);
      });
    };
    const mod = url.protocol === "https:" ? https : http;
    const r = mod.request(
      url,
      { method: req.method ?? "GET", headers: req.headers, lookup, timeout: req.timeoutMs },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > req.maxBytes) {
            res.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: typeof res.headers.location === "string" ? res.headers.location : null, text: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", reject);
    const hard = setTimeout(() => r.destroy(new Error("timed out")), req.timeoutMs);
    r.on("close", () => clearTimeout(hard));
    if (req.body) r.write(req.body);
    r.end();
  });
}

/**
 * The same address rule for a connection this module does not make itself —
 * IMAP and SMTP to a user-typed mail server. Throws BlockedTargetError unless
 * every address `host` resolves to is public or allow-listed. Checked before
 * the client connects, so unlike safeFetch it does not catch a name that is
 * re-pointed in between; it does stop the plain "connect to 10.x / 127.x and
 * read back what happened" probe.
 */
export async function assertPermittedHost(host: string): Promise<void> {
  const name = host.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(name) ? [name] : (await dns.promises.lookup(name, { all: true, verbatim: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some((ip) => !permitted(ip, name))) throw new BlockedTargetError("address not allowed");
}

/** One request to a user-supplied URL, under every rule above. Throws on a blocked target. */
export async function safeFetch(input: string, req: SafeRequest): Promise<SafeResponse> {
  let url = new URL(input);
  const hops = (req.method ?? "GET") === "GET" ? (req.maxRedirects ?? 3) : 0;
  for (let i = 0; ; i++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedTargetError("only http(s)");
    const res = await once(url, req);
    if (res.status >= 300 && res.status < 400 && res.location && i < hops) {
      url = new URL(res.location, url);
      continue;
    }
    return { status: res.status, text: res.text };
  }
}

/** What a caller may say about an attempt: never the upstream's own status or message. */
export type Outcome = "delivered" | "rejected" | "server-error" | "unreachable" | "blocked";
export function outcomeOf(r: SafeResponse | Error): Outcome {
  if (r instanceof BlockedTargetError) return "blocked";
  if (r instanceof Error) return "unreachable";
  if (r.status >= 200 && r.status < 300) return "delivered";
  if (r.status >= 500) return "server-error";
  return "rejected";
}
