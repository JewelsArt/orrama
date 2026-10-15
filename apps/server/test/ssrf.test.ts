/**
 * Calendar feeds and webhooks fetch URLs the user typed. They must not reach
 * the server's own network — loopback, the LAN, link-local cloud metadata —
 * directly, through a hostname that resolves there, or through a redirect;
 * and they must not report what answered there.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-ssrf-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
delete process.env.ORRAMA_FETCH_ALLOW;

const { BlockedTargetError, isPublicAddress, safeFetch } = await import("../src/safeFetch.js");

const hits: string[] = [];
let port = 0;
const server = http.createServer((req, res) => {
  hits.push(req.url ?? "");
  if (req.url === "/redirect") {
    res.writeHead(302, { location: `http://127.0.0.1:${port}/internal` });
    return res.end();
  }
  res.writeHead(401, { "content-type": "text/plain" });
  res.end("admin panel: login required");
});
beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => ((port = (server.address() as { port: number }).port), r()))));
afterAll(() => {
  server.close();
  delete process.env.ORRAMA_FETCH_ALLOW;
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("isPublicAddress", () => {
  it("refuses loopback, private, link-local, CGNAT and their IPv6/mapped forms", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.100.10.10", "0.0.0.0", "::1", "fe80::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "not-an-ip"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
});

describe("isPublicAddress: IPv6 ranges that embed or route to IPv4 (audit INP-005)", () => {
  // Each of these reaches a private IPv4 address on a host with 6to4, Teredo,
  // a NAT64 translator or an old stack, and each read as public.
  it("refuses the transition, translation and deprecated ranges", () => {
    for (const ip of [
      "::7f00:1", //                                 IPv4-compatible ::127.0.0.1
      "::127.0.0.1",
      "::a00:1", //                                   ::10.0.0.1
      "2002:7f00:1::", //                             6to4 around 127.0.0.1
      "2002:a00:1::1", //                             6to4 around 10.0.0.1
      "2002:808:808::1", //                           6to4 around a public one: still a relay path, refused
      "2001:0:4136:e378:8000:63bf:80ff:fffe", //      Teredo
      "64:ff9b:1::a00:1", //                          local-use NAT64 around 10.0.0.1
      "::ffff:0:7f00:1", //                           IPv4-translated (SIIT) 127.0.0.1
      "fec0::1", //                                   site-local (deprecated, still configurable)
      "3fff::1", //                                   documentation (RFC 9637)
      "2001:2::1", //                                 benchmarking
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it("still lets ordinary public IPv6 and IPv4 through", () => {
    for (const ip of ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2001:4860:4860::8888", "::ffff:8.8.8.8", "8.8.8.8", "203.0.114.1"]) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });
});

describe("safeFetch", () => {
  it("will not connect to a private address, by IP or by a name that resolves to one", async () => {
    hits.length = 0;
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { timeoutMs: 2000, maxBytes: 1000 })).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(safeFetch(`http://localhost:${port}/`, { timeoutMs: 2000, maxBytes: 1000 })).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(safeFetch(`http://[::ffff:127.0.0.1]:${port}/`, { timeoutMs: 2000, maxBytes: 1000 })).rejects.toBeInstanceOf(BlockedTargetError);
    expect(hits).toEqual([]);
  });

  it("checks every redirect hop, not just the first URL", async () => {
    process.env.ORRAMA_FETCH_ALLOW = "localhost"; // the first hop is allowed by name…
    hits.length = 0;
    try {
      await expect(safeFetch(`http://localhost:${port}/redirect`, { timeoutMs: 2000, maxBytes: 1000 })).rejects.toBeInstanceOf(BlockedTargetError);
      expect(hits).toEqual(["/redirect"]); // …the hop to a bare private IP never happened
    } finally {
      delete process.env.ORRAMA_FETCH_ALLOW;
    }
  });
});

describe("through the API", () => {
  let app: Awaited<ReturnType<typeof import("../src/main.js")["buildServer"]>>["app"];
  let token = "";
  beforeAll(async () => {
    await import("../src/seed.js");
    app = (await (await import("../src/main.js")).buildServer()).app;
    token = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
  });
  afterAll(async () => app.close());
  const call = (method: "POST", url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  it("a feed on the server's network is refused, and the reply says nothing about what is there", async () => {
    hits.length = 0;
    const r = await call("POST", "/api/calendar/feeds", { label: "LAN", url: `http://127.0.0.1:${port}/cal.ics` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/private network/);
    expect(r.body).not.toMatch(/401|admin panel/);
    expect(hits).toEqual([]);
  });

  it("a webhook aimed inward delivers nothing and records no status", async () => {
    hits.length = 0;
    const hook = await call("POST", "/api/webhooks", { url: `http://127.0.0.1:${port}/hook`, events: ["note.changed"] });
    expect(hook.statusCode).toBe(200);
    const test = await call("POST", `/api/webhooks/${hook.json().id}/test`);
    expect(test.json().status).toBeNull();
    expect(hits).toEqual([]);
  });
});
