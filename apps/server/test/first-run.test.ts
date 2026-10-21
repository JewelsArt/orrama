/**
 * First run without your vault (1A): an empty folder and a fresh database. The founder signs
 * up, and the app asks where the notes are until that is settled (`chooseNotes`). Starting
 * writes the note that says what things are (from core's ONTOLOGY_TEMPLATE, said for anyone)
 * when the folder has none, and the example when asked: one project with a status, a start
 * date and three steps, one person at one company in the project, one event this week. After
 * it the graph is on: people are typed and related, Orr noticed has rules to check, and the
 * example raises no warning. Remove the example takes exactly its notes and its event away.
 *
 * Nothing of this happens at boot or at sign-up: only when the person chooses.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionOf, signedIn } from "./helpers/session.js";

process.env.ORRAMA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orrama-first-run-"));
process.env.ORRAMA_VAULT_DIR = path.join(process.env.ORRAMA_DATA_DIR, "vault");
process.env.ORRAMA_JWT_SECRET = "test-secret-jwt-0123456789abcdef";
process.env.ORRAMA_SECRET_KEY = "test-secret-key-0123456789abcdef";
const vault = process.env.ORRAMA_VAULT_DIR;

const { buildServer } = await import("../src/main.js");
const { ONTOLOGY_PATH, exampleFiles, starterOntology } = await import("../src/firstRun.js");
const { parseOntology } = await import("@orrama/core");
const { tables } = await import("../src/db.js");

type Built = Awaited<ReturnType<typeof buildServer>>;
let b: Built;
let session = "";
const as = (method: "GET" | "POST" | "DELETE" | "PUT", url: string, payload?: unknown, who = session) =>
  b.app.inject({ method, url, headers: signedIn(who), ...(payload !== undefined ? { payload: payload as object } : {}) });
const files = (dir = vault, out: string[] = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) files(abs, out);
    else out.push(path.relative(vault, abs).split(path.sep).join("/"));
  }
  return out.sort();
};
/** The notes folder as a person sees it: everything outside the trash. */
const notesFiles = () => files().filter((f) => !f.startsWith(".trash/"));

beforeAll(async () => {
  b = await buildServer();
});
afterAll(async () => {
  await b.app.close();
  fs.rmSync(process.env.ORRAMA_DATA_DIR!, { recursive: true, force: true });
});

describe("the note that says what things are", () => {
  it("is core's template, said for anyone, typed where the app writes people, companies and projects", () => {
    const text = starterOntology();
    expect(text).not.toMatch(/Jules|Claude/);
    expect(text).toContain("someone you know");
    const o = parseOntology(text);
    const type = (id: string) => o.types.find((t) => t.id === id)!;
    expect(type("person").matches).toEqual([["tag:contact"], ["folder:Contacts"]]);
    expect(type("company").matches).toEqual([["tag:company"], ["folder:Contacts/Companies"]]);
    expect(o.types.map((t) => t.id)).toContain("conversation");
  });
});

describe("first run on an empty folder", () => {
  it("signing up founds the workspace and writes nothing into the folder; the app asks where the notes are", async () => {
    expect((await b.app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ needsSetup: true, chooseNotes: false });
    const r = await b.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "alex@example.test", username: "alex", displayName: "Alex", password: "correct horse battery" },
    });
    expect(r.statusCode).toBe(200);
    session = sessionOf(r);
    expect(files()).toEqual([]);
    expect((await b.app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ needsSetup: false, chooseNotes: true });
  });

  it("starting with the example writes the ontology note, the example and its event, and ends first run", async () => {
    const r = await as("POST", "/api/settings/start", { example: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ontology: "written", example: 4 });
    expect(files()).toEqual(
      [ONTOLOGY_PATH, ...exampleFiles(new Date()).map((f) => f.path), `01-Me/Calendar/${new Date().toISOString().slice(0, 7)}.md`].sort(),
    );
    expect((await b.app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ needsSetup: false, chooseNotes: false });
    const events = b.db.select().from(tables.events).all();
    expect(events.map((e) => e.title)).toEqual(["Site visit with Sam"]);
    const server = (await as("GET", "/api/settings/server")).json();
    expect(server).toMatchObject({ fixed: true, example: 4 });
  });

  it("then the graph is on: the person works at the company and is in the project, and nothing is wrong", async () => {
    const schema = (await as("GET", "/api/graph/schema")).json();
    expect(schema.types.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(["person", "company", "project"]));
    const sam = b.store.index.getByPath("Contacts/Sam Rivera.md")!;
    const rel = (await as("GET", `/api/graph/relations?entity=${encodeURIComponent(sam.id)}`)).json();
    const facts = rel.relations.flatMap((f: { relation: string; to: { title: string }[] }) => f.to.map((t) => `${f.relation} ${t.title}`));
    expect(facts).toEqual(expect.arrayContaining(["works_at Oakline Builders", "involved_in Garden studio"]));
    const warnings = (await as("GET", "/api/graph/warnings")).json();
    expect(warnings.warnings ?? warnings).toEqual([]);
    const people = (await as("GET", "/api/people/context")).json();
    expect(JSON.stringify(people)).toContain("Oakline Builders");
    const board = (await as("GET", "/api/dashboard")).json();
    expect(board.projects.map((p: { slug: string; status: string }) => `${p.slug} ${p.status}`)).toEqual(["garden-studio on-track"]);
  });

  it("a project made after it has a status and raises no warning", async () => {
    expect((await as("POST", "/api/projects", { name: "Kitchen renovation" })).statusCode).toBe(200);
    const warnings = (await as("GET", "/api/graph/warnings")).json();
    expect(warnings.warnings ?? warnings).toEqual([]);
  });

  it("starting again writes no second ontology note and no second example", async () => {
    const before = files();
    expect((await as("POST", "/api/settings/start", { example: true })).json()).toEqual({ ontology: "there", example: 4 });
    expect(files()).toEqual(before);
  });

  it("Remove the example puts exactly its notes in the trash, takes its event away, and leaves the rest", async () => {
    const r = await as("DELETE", "/api/settings/example");
    expect(r.json()).toEqual({ removed: 4 });
    expect(notesFiles()).toEqual([ONTOLOGY_PATH, "04-Projects/kitchen-renovation.md"].sort());
    // In the trash, restorable, as any note put there (1C), not deleted for good.
    const trashed = [...exampleFiles(new Date()).map((f) => f.path), `01-Me/Calendar/${new Date().toISOString().slice(0, 7)}.md`].sort();
    expect(files().filter((f) => f.startsWith(".trash/"))).toEqual(trashed.map((f) => `.trash/${f}`));
    expect(((await as("GET", "/api/vault/trash")).json() as { from: string }[]).map((t) => t.from).sort()).toEqual(trashed);
    expect(b.store.index.getByPath("Contacts/Sam Rivera.md")).toBeUndefined();
    expect(b.db.select().from(tables.events).all()).toEqual([]);
    expect((await as("GET", "/api/settings/server")).json()).toMatchObject({ example: 0 });
    expect((await as("DELETE", "/api/settings/example")).json()).toEqual({ removed: 0 });
  });

  it("the rest of the folder is the person's: a second account (invite) never writes the ontology again", async () => {
    fs.rmSync(path.join(vault, ONTOLOGY_PATH));
    for (let i = 0; i < 100 && b.store.index.getByPath(ONTOLOGY_PATH); i++) await new Promise((r) => setTimeout(r, 50));
    b.db.insert(tables.teams).values({ id: "t-home", slug: "home", name: "Home", color: "" }).run();
    const invite = await as("POST", "/api/admin/invites", { teamIds: ["home"] });
    expect(invite.statusCode).toBe(200);
    const r = await b.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "kim@example.test", username: "kim", displayName: "Kim", password: "correct horse battery", inviteToken: invite.json().token },
    });
    expect(r.statusCode).toBe(200);
    expect(notesFiles()).toEqual(["04-Projects/kitchen-renovation.md"]);
    expect((await b.app.inject({ method: "GET", url: "/api/auth/status" })).json()).toEqual({ needsSetup: false, chooseNotes: false });
    expect((await as("POST", "/api/settings/start", { example: false }, sessionOf(r))).statusCode).toBe(403);
  });
});
