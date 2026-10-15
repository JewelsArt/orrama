/**
 * A project with no 04-Projects/<slug>.md is the note its tag points to — and
 * it must stay the SAME note. projectNoteFor took the first tagged note the
 * index listed, and every save moves its note to the end of that list, so
 * with two tagged notes the project note flipped on each write: a decision
 * landed in one note, the next capture in the other, and the workspace showed
 * whichever was current (in the seed, Atlas Roadmap and Atlas Architecture).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-project-note-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";

const { buildServer } = await import("../src/main.js");
const { projectNoteFor } = await import("../src/routes/projects.js");
let b: Awaited<ReturnType<typeof buildServer>>;
let token = "";
const call = (method: string, url: string, payload?: object) =>
  b.app.inject({ method: method as "POST", url, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  fs.mkdirSync(process.env.ORRAMA_VAULT_DIR!, { recursive: true });
  await import("../src/seed.js");
  b = await buildServer();
  token = (await b.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })).json().token;
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the project note without a 04-Projects/<slug>.md", () => {
  it("the seed's atlas has two tagged notes and no conventional one — the case under test", () => {
    const tagged = b.store.index.all().filter((n) => n.tags.some((t) => t.tag === "project/atlas"));
    expect(tagged.length).toBeGreaterThan(1);
    expect(b.store.index.getByPath("04-Projects/atlas.md")).toBeUndefined();
  });

  it("every write lands in one note, and the workspace shows all of them", async () => {
    const contact = (await call("GET", "/api/contacts")).json()[0];
    await call("POST", "/api/projects/atlas/decisions", { text: "D1" });
    await call("POST", "/api/projects/atlas/capture", { text: "I1" });
    await call("POST", "/api/projects/atlas/people", { noteId: contact.id });
    await call("POST", "/api/projects/atlas/decisions", { text: "D2" });
    const w = (await call("GET", "/api/projects/atlas")).json();
    expect(w.decisions.map((d: string) => d.replace(/^\*\*[\d-]+\*\* — /, ""))).toEqual(["D1", "D2"]);
    expect(w.inbox).toEqual(["I1"]);
    expect(w.people.map((p: { id: string }) => p.id)).toEqual([contact.id]);
    const holding = b.store.index.all().filter((n) => /D1|I1/.test(n.content)).map((n) => n.path);
    expect(holding).toEqual([w.path]);
  });

  it("does not depend on the order the index lists notes in", () => {
    const notes = b.store.index.all();
    const forward = projectNoteFor(notes, "project/atlas")?.id;
    expect(projectNoteFor([...notes].reverse(), "project/atlas")?.id).toBe(forward);
  });
});
