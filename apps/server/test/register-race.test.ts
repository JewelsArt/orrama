/**
 * First-run registration founds the workspace: exactly one owner, however many
 * sign-ups arrive at once. The count used to be read before an awaited password
 * hash and used after it, so two simultaneous requests on an empty server both
 * saw zero users and both became owner.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-register-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true });
});

const register = (n: number, inviteToken?: string) =>
  b.app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { email: `u${n}@example.test`, username: `user${n}`, displayName: `User ${n}`, password: "correct horse battery", ...(inviteToken ? { inviteToken } : {}) },
  });

describe("first-run registration", () => {
  it("makes exactly one owner when sign-ups race on an empty server", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => register(n)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403, 403, 403]);
    const users = b.db.select().from(tables.users).all();
    expect(users).toHaveLength(1);
    expect(users.filter((u) => u.isOwner)).toHaveLength(1);
  });

  it("spends an invite once, however many sign-ups race for it", async () => {
    b.db.insert(tables.invites).values({ token: "inv-once", teamIds: "[]", createdBy: "x", expiresAt: Date.now() + 60_000 }).run();
    const results = await Promise.all([5, 6, 7].map((n) => register(n, "inv-once")));
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403, 403]);
    expect(b.db.select().from(tables.users).all()).toHaveLength(2);
  });
});
