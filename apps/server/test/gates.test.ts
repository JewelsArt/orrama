/**
 * Gate tests.
 *
 * The existing suite is thorough about the ACL *rules* — whether canRead says
 * yes — but several endpoints were never asked whether they CALL them. A rule
 * that holds and a route that forgets to consult it look identical in a unit
 * test and opposite in production. These five had zero test references:
 * /api/admin/grants, /api/admin/teams(/:id/members), /api/vault/move,
 * /api/vault/tags and /api/ws (the socket now in log-secrets.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-gates-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
// The startup guard refuses placeholder secrets everywhere now, not just
// under NODE_ENV=production, so the suite has to carry a real-shaped one too.
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

let app: Awaited<ReturnType<typeof buildServer>>["app"];
let db: Awaited<ReturnType<typeof buildServer>>["db"];
let store: Awaited<ReturnType<typeof buildServer>>["store"];
const tokens: Record<string, string> = {};

const api = async (method: string, url: string, user?: string, body?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: user ? { authorization: `Bearer ${tokens[user]}` } : {},
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
  return { status: res.statusCode, json: (() => { try { return res.json(); } catch { return null; } })() };
};

beforeAll(async () => {
  await import("../src/seed.js");
  const built = await buildServer();
  app = built.app;
  db = built.db;
  store = built.store;
  for (const email of ["jules@basalt.dev", "erin@basalt.dev", "mara@basalt.dev"]) {
    const r = await api("POST", "/api/auth/login", undefined, { email, password: "basalt-demo" });
    expect(r.status).toBe(200);
    tokens[email.split("@")[0]!] = r.json.token;
  }
});

afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

/** Every admin route hands out or revokes access, so each one is owner-only. */
describe("admin routes are owner-only", () => {
  const teamId = () => db.select().from(tables.teams).all()[0]!.id;
  const userId = (u: string) => db.select().from(tables.users).where(eq(tables.users.username, u)).get()!.id;

  const ROUTES: [string, string, () => unknown][] = [
    ["GET", "/api/admin/grants", () => undefined],
    ["POST", "/api/admin/grants", () => ({ teamId: teamId(), folder: "Engineering", role: "viewer" })],
    ["POST", "/api/admin/teams", () => ({ slug: "sneaky", name: "Sneaky", color: "#ffffff" })],
    ["POST", "/api/admin/teams/:t/members", () => ({ userId: userId("erin") })],
    ["DELETE", "/api/admin/grants/g-nonexistent", () => undefined],
  ];

  it("refuses a non-owner on every one of them", async () => {
    for (const [method, raw, body] of ROUTES) {
      const url = raw.replace(":t", teamId());
      for (const who of ["erin", "mara"]) {
        const r = await api(method, url, who, body());
        expect({ url, who, status: r.status }).toMatchObject({ status: 403 });
      }
    }
  });

  it("refuses an unauthenticated caller on every one of them", async () => {
    for (const [method, raw, body] of ROUTES) {
      const r = await api(method, raw.replace(":t", teamId()), undefined, body());
      expect(r.status).toBe(401);
    }
  });

  it("lets the owner through, so the guard is not simply refusing everyone", async () => {
    expect((await api("GET", "/api/admin/grants", "jules")).status).toBe(200);
    const created = await api("POST", "/api/admin/teams", "jules", { slug: "gate-check", name: "Gate", color: "#aabbcc" });
    expect(created.status).toBe(200);
  });

  it("did not create anything while refusing", async () => {
    expect(db.select().from(tables.teams).all().some((t) => t.slug === "sneaky")).toBe(false);
  });
});

/** A move is a write to two folders; both ends must be authorised. */
describe("POST /api/vault/move is gated at both ends", () => {
  it("refuses a note the caller cannot edit", async () => {
    const note = store.readable(store.aclUser(db.select().from(tables.users).where(eq(tables.users.username, "jules")).get()!.id))
      .find((n) => n.path.startsWith("Marketing/"));
    expect(note).toBeDefined();
    const r = await api("POST", "/api/vault/move", "erin", { fromPath: note!.path, toPath: "Engineering/stolen.md" });
    expect(r.status).not.toBe(200);
    expect(fs.existsSync(path.join(store.vaultRoot, "Engineering/stolen.md"))).toBe(false);
  });

  it("refuses a move INTO another user's personal vault, in any casing", async () => {
    const own = "Personal/erin/Note.md";
    store.write(store.aclUser(db.select().from(tables.users).where(eq(tables.users.username, "erin")).get()!.id), own, "# mine\n");
    for (const target of ["Personal/mara/stolen.md", "personal/mara/stolen.md"]) {
      const r = await api("POST", "/api/vault/move", "erin", { fromPath: own, toPath: target });
      expect(r.status).not.toBe(200);
    }
  });

  it("requires authentication", async () => {
    expect((await api("POST", "/api/vault/move", undefined, { fromPath: "a.md", toPath: "b.md" })).status).toBe(401);
  });
});

/** The tag index is a surface like any other: it must not name unreadable notes. */
describe("GET /api/vault/tags is ACL-filtered", () => {
  it("requires authentication", async () => {
    expect((await api("GET", "/api/vault/tags")).status).toBe(401);
  });

  it("does not leak a tag that exists only on a note the caller cannot read", async () => {
    const mara = store.aclUser(db.select().from(tables.users).where(eq(tables.users.username, "mara")).get()!.id);
    store.write(mara, "Personal/mara/Secret.md", "---\ntags: [maras-private-tag]\n---\n\n# Secret\n");

    const hers = await api("GET", "/api/vault/tags", "mara");
    expect(hers.json.map((t: { tag: string }) => t.tag)).toContain("maras-private-tag");

    const his = await api("GET", "/api/vault/tags", "erin");
    expect(his.json.map((t: { tag: string }) => t.tag)).not.toContain("maras-private-tag");
  });
});

// /api/ws is tested in log-secrets.test.ts, over a real WebSocket handshake.
// The two tests that stood here sent a plain GET, which a websocket route
// refuses whatever the token says: with socket auth removed entirely they
// still passed.
