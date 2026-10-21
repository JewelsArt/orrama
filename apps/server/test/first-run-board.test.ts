/**
 * A new install's Projects board loads (1A). The first account founds the workspace without a
 * team (routes/auth.ts), and the board used to ask for one: `/api/teams` answered `[]` and the
 * page said "The board could not be loaded" in a person's first minute. The board now reads
 * `/api/dashboard`, every project the requester can see, with no team at all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-first-board-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const b = await buildServer();
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("an empty install's Projects board", () => {
  it("loads after the first sign-up and one new project, with no team anywhere", async () => {
    const signUp = await b.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "alex@example.test", username: "alex", displayName: "Alex", password: "correct horse battery" },
    });
    expect(signUp.statusCode).toBe(200);
    const session = sessionOf(signUp);

    const teams = await b.app.inject({ method: "GET", url: "/api/teams", headers: signedIn(session) });
    expect(teams.json()).toEqual([]);

    const made = await b.app.inject({ method: "POST", url: "/api/projects", headers: signedIn(session), payload: { name: "Kitchen renovation" } });
    expect(made.statusCode).toBe(200);

    const board = await b.app.inject({ method: "GET", url: "/api/dashboard", headers: signedIn(session) });
    expect(board.statusCode).toBe(200);
    const body = board.json();
    expect(body.team).toBeNull();
    expect(body.projects.map((p: { slug: string }) => p.slug)).toEqual(["kitchen-renovation"]);
    expect(body.projects[0].tasks.map((t: { text: string }) => t.text)).toEqual(["First step"]);
  });

  it("is a session's board: without one it is refused", async () => {
    expect((await b.app.inject({ method: "GET", url: "/api/dashboard" })).statusCode).toBe(401);
  });
});
