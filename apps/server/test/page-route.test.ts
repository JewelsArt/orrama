/**
 * An .html document served as a page for the reader's frame (`…/files/:name/page`).
 *
 * The one document route that lets a file's own scripts run, so what it sends is pinned
 * exactly: the sandbox (an opaque origin, no session), the hosts it may load from, who may
 * frame it. That the page really gets no cookie, storage, parent or API was checked in
 * WebKit and Chrome against a probe page (HR notes); here the server's half is held.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-page-route-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

fs.mkdirSync(process.env.ORRAMA_VAULT_DIR, { recursive: true });
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { PAGE_CSP, PAGE_SANDBOX } = await import("../src/pageSandbox.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const dir = path.join(process.env.ORRAMA_VAULT_DIR, "04-Projects/acme/files");
const PAGE = "<!doctype html><title>Map</title><script>document.title = 'ran'</script><p>The map</p>";
const get = (url: string, headers: Record<string, string> = {}) => b.app.inject({ method: "GET", url, headers: { ...signedIn(token), ...headers } });

beforeAll(async () => {
  b = await buildServer();
  token = sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Process map.html"), PAGE);
  fs.writeFileSync(path.join(dir, "old.HTM"), PAGE);
  fs.writeFileSync(path.join(dir, "brief.txt"), "plain");
  fs.writeFileSync(path.join(dir, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("GET /api/projects/:slug/files/:name/page", () => {
  it("serves the page as it is, sandboxed: an opaque origin, CDN scripts, framed by Orrama only", async () => {
    const res = await get("/api/projects/acme/files/Process%20map.html/page");
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PAGE);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.headers["content-security-policy"]).toBe(PAGE_CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-disposition"]).toBeUndefined();

    const csp = Object.fromEntries(PAGE_CSP.split("; ").map((d) => [d.split(" ")[0]!, d.split(" ").slice(1)]));
    // The page's own origin is never granted: that is what keeps the session and Orrama out of reach.
    expect(PAGE_SANDBOX).not.toContain("allow-same-origin");
    expect(PAGE_SANDBOX).not.toContain("allow-top-navigation");
    expect(csp["sandbox"]).toEqual([...PAGE_SANDBOX]);
    expect(csp["frame-ancestors"]).toEqual(["'self'"]);
    expect(csp["default-src"]).toEqual(["'none'"]);
    expect(csp["form-action"]).toEqual(["'none'"]);
    // Scripts from the page itself and the artifact CDNs; no `https:` wildcard, no 'self'.
    expect(csp["script-src"]).toContain("https://cdn.jsdelivr.net");
    expect(csp["script-src"]).not.toContain("https:");
    expect(csp["script-src"]).not.toContain("'self'");
    expect(csp["connect-src"]).not.toContain("'self'");
  });

  it("takes .htm in any case too", async () => {
    expect((await get("/api/projects/acme/files/old.HTM/page")).statusCode).toBe(200);
  });

  it("serves nothing but .html: text and SVG are refused, not run", async () => {
    expect((await get("/api/projects/acme/files/brief.txt/page")).statusCode).toBe(400);
    expect((await get("/api/projects/acme/files/logo.svg/page")).statusCode).toBe(400);
  });

  it("refuses a path out of the folder, a missing file and a missing session", async () => {
    expect((await get("/api/projects/acme/files/..%2F..%2Facme.md/page")).statusCode).toBe(400);
    expect((await get("/api/projects/acme/files/gone.html/page")).statusCode).toBe(404);
    const anon = await b.app.inject({ method: "GET", url: "/api/projects/acme/files/Process%20map.html/page" });
    expect(anon.statusCode).toBe(401);
  });

  it("is read access on the project, as for the raw file: someone who cannot read its note gets nothing", async () => {
    // mara (Marketing) cannot read Engineering/; erin (Engineering) can. The page exists either way.
    const as = async (who: string) => sessionOf(await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
    const note = await b.app.inject({ method: "PUT", url: "/api/vault/note", headers: signedIn(token), payload: { path: "Engineering/Secret plan.md", content: "---\ntitle: Secret plan\ntags: [project/secret]\n---\n# Secret plan\n" } });
    expect(note.statusCode).toBe(200);
    const secret = path.join(process.env.ORRAMA_VAULT_DIR!, "04-Projects/secret/files");
    fs.mkdirSync(secret, { recursive: true });
    fs.writeFileSync(path.join(secret, "map.html"), PAGE);
    const url = "/api/projects/secret/files/map.html/page";
    const mara = await b.app.inject({ method: "GET", url, headers: signedIn(await as("mara")) });
    expect(mara.statusCode).toBe(404);
    expect(mara.body).not.toContain("The map");
    const erin = await b.app.inject({ method: "GET", url, headers: signedIn(await as("erin")) });
    expect(erin.statusCode).toBe(200);
    expect(erin.body).toBe(PAGE);
  });

  it("answers 304 to a page the reader already has, and the page again once it changes", async () => {
    const first = await get("/api/projects/acme/files/Process%20map.html/page");
    const since = first.headers["last-modified"] as string;
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const again = await get("/api/projects/acme/files/Process%20map.html/page", { "if-modified-since": since });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers["content-security-policy"]).toBe(PAGE_CSP);

    const later = new Date(Date.parse(since) + 60_000);
    fs.utimesSync(path.join(dir, "Process map.html"), later, later);
    const changed = await get("/api/projects/acme/files/Process%20map.html/page", { "if-modified-since": since });
    expect(changed.statusCode).toBe(200);
    expect(changed.body).toBe(PAGE);
  });

  it("leaves the raw file route as it was: an .html there is a download, never a page", async () => {
    const raw = await get("/api/projects/acme/files/Process%20map.html");
    expect(raw.statusCode).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/octet-stream");
    expect(String(raw.headers["content-disposition"])).toMatch(/^attachment/);
  });
});
