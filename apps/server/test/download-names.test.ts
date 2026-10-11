/**
 * A document's own name must never take the server down (audit INP-001).
 *
 * The raw-file routes put the filename straight into Content-Disposition. Node
 * refuses a header byte above U+00FF, and on a streamed reply it throws
 * outside every handler, so the process exited: a macOS screenshot (U+202F
 * before "PM"), `Jules’s CV.pdf` or `Rapport – v2.pdf` was enough, opened from
 * the reader. Served over a real socket here, the way the reader fetches.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-download-names-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

fs.mkdirSync(process.env.BASALT_VAULT_DIR, { recursive: true });
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
let base = "";
let token = "";
const req = (method: string, url: string, body?: unknown) =>
  fetch(base + url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** The name a Content-Disposition header gives, preferring `filename*` as a browser does. */
function nameIn(header: string | null): string | null {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header ?? "");
  if (star) return decodeURIComponent(star[1]!);
  return /filename="([^"]*)"/.exec(header ?? "")?.[1] ?? null;
}

const NAMES = ["Rapport \u2013 v2", "Screenshot 2026-10-02 at 2.30.12\u202fPM", "Jules\u2019s CV", "Jules's notes", "M\u00e9moire", 'say "hi" (draft) 100%*'];

beforeAll(async () => {
  b = await buildServer();
  await b.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = b.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  token = ((await (await req("POST", "/api/auth/login", { email: "jules@basalt.dev", password: "basalt-demo" })).json()) as { token: string }).token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

describe("serving a file under a name outside Latin-1", () => {
  it("project documents: 200, and the header names the file exactly", async () => {
    for (const stem of NAMES) {
      const name = `${stem}.pdf`;
      const up = await req("POST", "/api/projects/acme/files", { name, dataBase64: Buffer.from(`%PDF ${stem}`).toString("base64") });
      expect(up.status).toBe(200);
      const res = await req("GET", `/api/projects/acme/files/${encodeURIComponent(name)}`);
      expect(res.status).toBe(200);
      expect(nameIn(res.headers.get("content-disposition"))).toBe(name);
      // RFC 5987: after UTF-8'' only attr-chars and %XX; a bare ' or ( breaks the value.
      expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
      expect(await res.text()).toBe(`%PDF ${stem}`);
    }
    expect((await req("GET", "/api/health")).status).toBe(200);
  });

  it("finance files: 200, and the header names the file exactly", async () => {
    for (const stem of NAMES) {
      const name = `${stem}.csv`;
      const up = await req("POST", "/api/finance/payslip", { name, dataBase64: Buffer.from("month,net\n").toString("base64") });
      expect(up.status).toBe(200);
      const res = await req("GET", `/api/finance/files/${encodeURIComponent(name)}`);
      expect(res.status).toBe(200);
      expect(nameIn(res.headers.get("content-disposition"))).toBe(name);
    }
    expect((await req("GET", "/api/health")).status).toBe(200);
  });

  it("a file dropped into the folder from Finder is served too", async () => {
    const dir = path.join(process.env.BASALT_VAULT_DIR!, "04-Projects/acme/files");
    fs.writeFileSync(path.join(dir, "Notes \u2014 \u65e5\u672c.txt"), "x");
    const res = await req("GET", `/api/projects/acme/files/${encodeURIComponent("Notes \u2014 \u65e5\u672c.txt")}`);
    expect(res.status).toBe(200);
    expect(nameIn(res.headers.get("content-disposition"))).toBe("Notes \u2014 \u65e5\u672c.txt");
  });
});

describe("names with control characters are refused", () => {
  for (const bad of ["two\nlines.csv", "carriage\rreturn.csv", "tab\there.csv", "c1\u0085.csv", "sep\u2028.csv"]) {
    it(JSON.stringify(bad), async () => {
      expect((await req("POST", "/api/finance/payslip", { name: bad, dataBase64: Buffer.from("x").toString("base64") })).status).toBe(400);
      expect((await req("POST", "/api/projects/acme/files", { name: bad.replace(".csv", ".txt"), dataBase64: Buffer.from("x").toString("base64") })).status).toBe(400);
    });
  }
});
