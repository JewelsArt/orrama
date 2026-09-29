/**
 * Audit B10, status half: "working on it" / "blocked" used to live on
 * task_objects alone. They now live in the line (`[/]`, `[b]`); a database
 * from before that is migrated once, and only once — after that the file wins,
 * even over a stale row.
 *
 * The seed writes exactly the old shape: erin's "partial checkout spike" is a
 * plain `[ ]` line with an in-progress task object.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

process.env.BASALT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "basalt-marks-"));
process.env.BASALT_VAULT_DIR = path.join(process.env.BASALT_DATA_DIR, "vault");
process.env.BASALT_JWT_SECRET = "test-secret";
process.env.BASALT_SECRET_KEY = "test-secret-key-0123456789abcdef";

await import("../src/seed.js");
const { buildServer } = await import("../src/main.js");
const { tables } = await import("../src/db.js");

const roadmap = path.join(process.env.BASALT_VAULT_DIR!, "Engineering/Atlas Roadmap.md");
const spike = () => fs.readFileSync(roadmap, "utf8").split("\n").find((l) => l.includes("partial checkout spike"))!;

afterAll(() => fs.rmSync(process.env.BASALT_DATA_DIR!, { recursive: true, force: true }));

describe("task status migration", () => {
  it("the seed is the old shape: an open box, an in-progress row", () => {
    expect(spike()).toMatch(/^- \[ \] partial checkout spike/);
  });

  it("first boot writes the row's status into the line", async () => {
    const { app, db, store } = await buildServer();
    expect(spike()).toMatch(/^- \[\/\] partial checkout spike/);
    const note = store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    expect(note.tasks.find((t) => t.text.startsWith("partial checkout spike"))!.status).toBe("in-progress");
    expect(db.select().from(tables.meta).where(eq(tables.meta.key, "b10-task-marks")).get()).toBeTruthy();
    await app.close();
  });

  it("after that the file wins: a box cleared while the server was down stays cleared", async () => {
    // Obsidian, server stopped: back to [ ]. The row still says in-progress.
    fs.writeFileSync(roadmap, fs.readFileSync(roadmap, "utf8").replace("- [/] partial checkout spike", "- [ ] partial checkout spike"));
    const { app, db, store } = await buildServer();
    expect(spike()).toMatch(/^- \[ \] partial checkout spike/);
    const note = store.index.getByPath("Engineering/Atlas Roadmap.md")!;
    const row = db.select().from(tables.taskObjects).where(eq(tables.taskObjects.noteId, note.id)).get()!;
    expect(row.status).toBe("todo"); // reconciled from the file at boot
    await app.close();
  });
});
