/**
 * The tree carries each note's life-area, decided by the vault's own
 * #vault-categories note as the caller can read it — a rule note someone
 * cannot read does not shape their view.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-cats-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { app } = await buildServer();
afterAll(async () => {
  await app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});
const tok: Record<string, string> = {};
for (const who of ["jules", "mara"]) tok[who] = sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } }));
const tree = async (who: string) =>
  new Map(((await app.inject({ method: "GET", url: "/api/vault/tree", headers: signedIn(tok[who]) })).json() as { path: string; category: string }[]).map((n) => [n.path, n.category]));

describe("tree categories", () => {
  it("without a rules note, only the PARA defaults apply", async () => {
    const t = await tree("jules");
    expect(t.get("Shared/Meeting Notes 2026-07-01.md")).toBe("personal");
  });

  it("a readable rules note decides; an unreadable one does not", async () => {
    // Engineering is readable by jules (owner) but not by mara (marketing).
    const put = await app.inject({
      method: "PUT",
      url: "/api/vault/note",
      headers: signedIn(tok["jules"]),
      payload: { path: "Engineering/Vault categories.md", content: "---\ntags: [vault-categories]\n---\n| Category | Matches |\n| --- | --- |\n| Work | meeting notes, marketing/ |\n" },
    });
    expect(put.statusCode).toBe(200);
    const jules = await tree("jules");
    expect(jules.get("Shared/Meeting Notes 2026-07-01.md")).toBe("work");
    const mara = await tree("mara");
    expect(mara.get("Shared/Meeting Notes 2026-07-01.md")).toBe("personal");
    expect([...mara.values()].includes("work")).toBe(false);
  });
});
