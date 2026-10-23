/**
 * Life areas are a list the person names (1D): Settings writes it into the areas note (made in
 * Orrama/ when there is none), a project picks one with `area:`, a rename or removal takes the
 * projects with it, and the projects row's `domain` follows its note.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-areas-"));
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
const vault = process.env.ORRAMA_VAULT_DIR!;
const h = signedIn(sessionOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "jules@orrama.dev", password: "orrama-demo" } })));
const call = (method: "GET" | "PUT" | "POST" | "PATCH", url: string, payload?: unknown) => app.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload: payload as object }) });

interface Areas {
  areas: { id: string; name: string; words: string[]; catchAll: boolean; notes: number; projects: number }[];
  note: { id: string; path: string; hash: string } | null;
  canEdit: boolean;
}
const areas = async () => (await call("GET", "/api/areas")).json() as Areas;
const areaOfPath = async (p: string) => ((await call("GET", "/api/vault/tree")).json() as { path: string; category: string }[]).find((n) => n.path === p)?.category;
const front = (p: string) => fs.readFileSync(path.join(vault, p), "utf8").split("\n---")[0]!;

describe("the list", () => {
  it("a vault with no areas note has Work and Personal, and nothing written", async () => {
    const a = await areas();
    expect(a.areas.map((x) => [x.id, x.catchAll])).toEqual([
      ["work", false],
      ["personal", true],
    ]);
    expect(a.note).toBeNull();
    expect(a.canEdit).toBe(true);
    expect(fs.existsSync(path.join(vault, "Orrama/Life areas.md"))).toBe(false);
  });

  it("the first change makes the note; rename, add and reorder land in that order", async () => {
    const put = await call("PUT", "/api/areas", {
      areas: [
        { name: "Family" },
        { name: "Home", catchAll: true, was: "personal" },
        { name: "Work", was: "work", words: ["meeting notes"] },
        { name: "Running" },
      ],
    });
    expect(put.statusCode).toBe(200);
    const a = await areas();
    expect(a.areas.map((x) => x.name)).toEqual(["Family", "Home", "Work", "Running"]);
    expect(a.note?.path).toBe("Orrama/Life areas.md");
    expect(fs.readFileSync(path.join(vault, "Orrama/Life areas.md"), "utf8")).toContain("| Home | everything else |\n| Work | meeting notes |\n| Running | |");
    // The words decide for other notes; the rest is Home.
    expect(await areaOfPath("Shared/Meeting Notes 2026-07-01.md")).toBe("work");
    expect(await areaOfPath("Engineering/Atlas Roadmap.md")).toBe("home");
  });

  it("a list it can't write is a 400; a list changed since it was read is a 409", async () => {
    expect((await call("PUT", "/api/areas", { areas: [{ name: "Work" }] })).json().error).toBe("One area takes everything else.");
    const stale = await call("PUT", "/api/areas", { areas: [{ name: "Home", catchAll: true }], baseHash: "nope" });
    expect(stale.statusCode).toBe(409);
    expect((await areas()).areas).toHaveLength(4);
  });
});

describe("a project's area", () => {
  let slug = "";
  it("New project takes the area it is made in", async () => {
    const res = await call("POST", "/api/projects", { name: "Garden shed", area: "family" });
    expect(res.statusCode).toBe(200);
    slug = res.json().slug;
    expect(front(`04-Projects/${slug}.md`)).toContain("area: Family");
    expect(await areaOfPath(`04-Projects/${slug}.md`)).toBe("family");
    expect((await call("POST", "/api/projects", { name: "Nowhere", area: "mars" })).statusCode).toBe(400);
  });

  it("the header writes area:, which replaces an old domain:", async () => {
    const note = `04-Projects/${slug}.md`;
    fs.writeFileSync(path.join(vault, note), fs.readFileSync(path.join(vault, note), "utf8").replace("area: Family", "domain: professional"));
    const put = await call("PUT", "/api/vault/note", { path: note, content: fs.readFileSync(path.join(vault, note), "utf8") });
    expect(put.statusCode).toBe(200);
    // The old domain: reads as Work, and the projects row follows the note (it was frozen at registration).
    expect(await areaOfPath(note)).toBe("work");
    const row = () => ((call("GET", "/api/projects") as Promise<{ json(): { key: string; domain: string | null }[] }>).then((r) => r.json().find((p) => p.key === `project/${slug}`)?.domain));
    expect(await row()).toBe("professional");
    const patch = await call("PATCH", `/api/projects/${slug}`, { area: "Running" });
    expect(patch.statusCode).toBe(200);
    expect(front(note)).toContain("area: Running");
    expect(front(note)).not.toContain("domain:");
    expect(await areaOfPath(note)).toBe("running");
    expect(await row()).toBeNull();
    expect((await call("PATCH", `/api/projects/${slug}`, { area: "Mars" })).statusCode).toBe(400);
  });

  it("removing an area moves its projects to the catch-all, and says how many", async () => {
    const a = await areas();
    expect(a.areas.find((x) => x.id === "running")?.projects).toBe(1);
    const res = await call("PUT", "/api/areas", { areas: a.areas.filter((x) => x.id !== "running").map((x) => ({ name: x.name, words: x.words, catchAll: x.catchAll, was: x.id })), baseHash: a.note!.hash });
    expect(res.json()).toMatchObject({ ok: true, projects: 1, unmoved: 0, rest: "home" });
    expect(front(`04-Projects/${slug}.md`)).toContain("area: Home");
    expect(await areaOfPath(`04-Projects/${slug}.md`)).toBe("home");
  });

  it("renaming an area renames it in its projects", async () => {
    await call("PATCH", `/api/projects/${slug}`, { area: "Family" });
    const a = await areas();
    const res = await call("PUT", "/api/areas", { areas: a.areas.map((x) => ({ name: x.id === "family" ? "Kin" : x.name, words: x.words, catchAll: x.catchAll, was: x.id })) });
    expect(res.json().projects).toBe(1);
    expect(front(`04-Projects/${slug}.md`)).toContain("area: Kin");
    expect(await areaOfPath(`04-Projects/${slug}.md`)).toBe("kin");
  });
});
