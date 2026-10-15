/**
 * A restricted note stays restricted however its front matter is written
 * (audit ACL-006): one unquoted colon in the YAML, `tags: a, only/x` as a
 * string, or the singular `tag:` key used to drop the `#only/<team>` and fall
 * back to the folder grant, so every teammate with folder access could read
 * the note. Here mara (marketing, editor on Shared/) must not see any of them
 * on any surface; erin (engineering) sees them all. The parser half is
 * packages/core/test/only-fails-closed.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-only-closed-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const VAULT = process.env.ORRAMA_VAULT_DIR;
const NOTES: Record<string, string> = {
  "Shared/Q3 Review.md": "---\ntitle: Q3 Review: Ops\ntags: [only/engineering]\n---\n# Q3\n\nzebracorn-q3 headcount cuts [[Target]]\n- [ ] zebracorn-q3 tell the team\n",
  "Shared/Handbook.md": "---\ntags: handbook, only/engineering\n---\n# Handbook\n\nzebracorn-hb [[Target]]\n- [ ] zebracorn-hb review\n",
  "Shared/Singular.md": "---\ntag: only/engineering\n---\n# Singular\n\nzebracorn-sg [[Target]]\n- [ ] zebracorn-sg review\n",
};
fs.mkdirSync(path.join(VAULT, "Shared"), { recursive: true });
fs.writeFileSync(path.join(VAULT, "Shared/Target.md"), "# Target\n\nopen to all\n");
for (const [p, c] of Object.entries(NOTES)) fs.writeFileSync(path.join(VAULT, p), c);
await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");

let b: Awaited<ReturnType<typeof buildServer>>;
const tokens: Record<string, string> = {};
const get = async (who: string, url: string) => {
  const res = await b.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tokens[who]}` } });
  return { status: res.statusCode, text: res.body };
};
const ids = () => Object.keys(NOTES).map((p) => b.store.index.getByPath(p)!.id);
const MARKS = ["zebracorn-q3", "zebracorn-hb", "zebracorn-sg"];

beforeAll(async () => {
  b = await buildServer();
  for (const who of ["erin", "mara"]) {
    tokens[who] = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${who}@orrama.dev`, password: "orrama-demo" } })).json().token;
  }
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

const target = () => b.store.index.getByPath("Shared/Target.md")!.id;
const SURFACES: [string, () => string][] = [
  ["tree", () => "/api/vault/tree"],
  ["search", () => "/api/vault/search?q=zebracorn"],
  ["backlinks", () => `/api/vault/note/${target()}`],
  ["graph", () => "/api/vault/graph"],
  ["tasks", () => "/api/tasks"],
];

it("a non-member sees none of them, on any surface", async () => {
  for (const [name, url] of SURFACES) {
    const { status, text } = await get("mara", url());
    expect(status, name).toBe(200);
    for (const id of ids()) expect(text, `${name} leaks ${id}`).not.toContain(id);
    for (const m of MARKS) expect(text, `${name} leaks ${m}`).not.toContain(m);
  }
  for (const id of ids()) expect((await get("mara", `/api/vault/note/${id}`)).status).toBe(404);
});

it("a member of the team sees all of them (so the check above is not vacuous)", async () => {
  const tree = (await get("erin", "/api/vault/tree")).text;
  for (const id of ids()) expect(tree).toContain(id);
  expect((await get("erin", `/api/vault/note/${target()}`)).text).toContain(ids()[0]!);
  const tasks = (await get("erin", "/api/tasks")).text;
  for (const m of MARKS) expect(tasks).toContain(m);
  for (const id of ids()) expect((await get("erin", `/api/vault/note/${id}`)).status).toBe(200);
});
