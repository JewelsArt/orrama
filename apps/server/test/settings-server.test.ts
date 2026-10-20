/**
 * Settings → Notes says which folder this server reads the notes from (structure.md §3.2, "This
 * server"). It is a path on the Mac, so only an owner may see it, and it is said the way a
 * person writes it: `~/Orrama Vault`, not `/Users/<name>/Orrama Vault`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-settings-server-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { homePath } = await import("../src/routes/settings.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let built: Built;
const tokens: Record<string, string> = {};
const get = (who: string) => built.app.inject({ method: "GET", url: "/api/settings/server", headers: signedIn(tokens[who]) });

beforeAll(async () => {
  built = await buildServer();
  for (const who of ["jules", "erin"]) {
    tokens[who] = sessionOf(await built.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
  }
});
afterAll(async () => {
  await built.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("GET /api/settings/server", () => {
  it("tells the owner the notes folder, how many notes it holds, and the version", async () => {
    const r = await get("jules");
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.notesFolder).toBe(homePath(path.resolve(process.env.ORRAMA_VAULT_DIR!)));
    expect(body.notes).toBe(built.store.index.all().length);
    expect(body.notes).toBeGreaterThan(0);
    expect(body.version).toBe(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });

  it("is refused to anyone who is not an owner", async () => {
    expect((await get("erin")).statusCode).toBe(403);
  });

  it("is refused without a session", async () => {
    expect((await built.app.inject({ method: "GET", url: "/api/settings/server" })).statusCode).toBe(401);
  });
});

describe("homePath", () => {
  it("says a folder under home with a tilde, and leaves others alone", () => {
    expect(homePath("/Users/x/Orrama Vault", "/Users/x")).toBe("~/Orrama Vault");
    expect(homePath("/Users/x/a/b", "/Users/x")).toBe("~/a/b");
    expect(homePath("/Users/xy/notes", "/Users/x")).toBe("/Users/xy/notes");
    expect(homePath("/srv/notes", "/Users/x")).toBe("/srv/notes");
    expect(homePath("/Users/x", "/Users/x")).toBe("/Users/x");
  });
});
