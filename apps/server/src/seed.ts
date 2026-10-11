/**
 * Seed a demo workspace (spec M4 "seed demo workspace"): two teams, three users,
 * a vault with links, tags, tasks, and both permission overlays exercised.
 * Users: jules (owner), erin (engineering), mara (marketing) — password "basalt-demo".
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hash as argonHash } from "@node-rs/argon2";
import { promoteTaskLine } from "@basalt/core";
import { writeFileAtomic } from "./atomicWrite.js";
import { createDb, tables } from "./db.js";
import { vaultDir } from "./env.js";
import { VaultStore } from "./vaultStore.js";

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

const FILES: Record<string, string> = {
  "Welcome.md": `---
title: Welcome to Basalt
tags: [handbook]
---
# Welcome 👋

This vault is plain Markdown in real folders — open it in Obsidian if you like.
Start with [[Atlas Roadmap]] or the [[Acme Relaunch Brief]].

- [ ] read the handbook @erin
- [ ] read the handbook @mara
`,
  "Engineering/Atlas Roadmap.md": `---
title: Atlas Roadmap
aliases: [Roadmap]
tags: [project/atlas]
---
# Atlas Roadmap

Q3 milestones for [[Atlas Architecture|the architecture]]. Marketing input in [[Acme Relaunch Brief]].

- [x] freeze v1 scope @erin
- [x] pick sync stack @erin
- [ ] partial checkout spike @erin due:2026-07-08 !p1
- [ ] permission test suite @erin due:2026-07-15 !p1
- [ ] dashboard API @jules due:2026-07-20 !p2
`,
  "Engineering/Atlas Architecture.md": `---
title: Atlas Architecture
tags: [project/atlas]
---
# Architecture

One parser everywhere: desktop, web, server all run the same vault engine.
CRDT merge via Yjs; the file on disk is the render of the doc. See [[Atlas Roadmap]].

- [ ] write ADR for CRDT choice @erin !p2
- [ ] threat-model the sync server @jules due:2026-07-12 !p1
`,
  "Engineering/Incident Runbook.md": `---
title: Incident Runbook
tags: [handbook, only/engineering]
---
# Incident Runbook  #only/engineering

Pager rotations and postmortem templates. Engineering-eyes only while we draft it.

- [ ] fill in escalation ladder @erin
`,
  "Marketing/Acme Relaunch Brief.md": `---
title: Acme Relaunch Brief
tags: [project/acme, share/engineering]
---
# Acme Relaunch  #share/engineering

Shared with engineering so [[Atlas Roadmap]] scoping can reference the launch dates.

- [x] positioning workshop @mara
- [ ] landing page copy @mara due:2026-07-09 !p1
- [ ] pricing one-pager @mara due:2026-07-14 !p2
`,
  "Marketing/Surprise Campaign.md": `---
title: Surprise Campaign
tags: [project/acme, only/marketing]
---
# Surprise Campaign  #only/marketing

The teaser nobody outside marketing may see — not even in search counts.

- [ ] book influencer slots @mara due:2026-07-11
- [ ] draft teaser video script @mara !p1
`,
  "Contacts/Pieter Haans.md": `---
title: Pieter Haans
tags: [contact]
sector: Finance
role: Finance lead (internship coach)
company: Northwind
email: p.haans@example.com
phone: "+44 7700 900022"
linkedin: ""
---
# Pieter Haans

Internship coach at Northwind.
`,
  "Contacts/Marijke Elzinga.md": `---
title: Marijke Elzinga
tags: [contact]
sector: Leadership
role: Founder
company: Northwind
email: ""
phone: ""
linkedin: ""
---
# Marijke Elzinga
`,
  "Contacts/Wilma Doorn.md": `---
title: Wilma Doorn
tags: [contact]
sector: Operations
role: Operations lead
company: Northwind
email: ""
phone: "+44 7700 900021"
linkedin: ""
---
# Wilma Doorn
`,
  "Contacts/Claire Bertrand.md": `---
title: Claire Bertrand
tags: [contact]
sector: University
role: Internship supervisor
company: Example University
email: ""
phone: ""
linkedin: ""
---
# Claire Bertrand
`,
  "Contacts/Companies/Northwind.md": `---
title: Northwind
tags: [company]
sector: Marketing
description: "Design studio — the internship host."
linkedin: "linkedin.com/company/northwind-example"
website: "northwind.example"
location: "Amsterdam"
positions: ["Data Analyst intern", "Growth Marketeer"]
---
# Northwind

People here: [[Marijke Elzinga]] · [[Pieter Haans]] · [[Wilma Doorn]]
`,
  "Contacts/Companies/Example University.md": `---
title: Example University
tags: [company]
sector: University
description: "The school side of the internship and thesis."
linkedin: "linkedin.com/school/example-university"
website: "university.example"
location: "Amsterdam"
positions: ["Thesis supervision"]
---
# Example University

Contact: [[Claire Bertrand]]
`,
  "Shared/Meeting Notes 2026-07-01.md": `---
title: Meeting Notes 2026-07-01
tags: [meeting]
---
# Weekly sync

Cross-team sync. [[Atlas Roadmap]] on track; [[Acme Relaunch Brief]] copy due next week.

- [x] send recap @jules
- [ ] schedule next sync @jules due:2026-07-08
`,
};

/**
 * The first note found under `root` (dot-folders such as .obsidian skipped), or
 * null. Seed only ever fills an empty vault: run with the agent's
 * BASALT_VAULT_DIR exported and an empty users table (a deleted database), it
 * wrote 13 demo notes over the real vault, bare writes overwriting same-named
 * files, and put a published-password owner on the database (audit REG-013).
 * The test suites, which write fixtures and then seed, opt out with
 * BASALT_SEED_INTO_EXISTING_VAULT=1 (vitest.config.ts); a demo file never
 * replaces one that is there.
 */
export function firstNote(root: string): string | null {
  const walk = (dir: string): string | null => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null; // a vault that does not exist yet is empty
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        const found = walk(abs);
        if (found) return found;
      } else if (e.name.toLowerCase().endsWith(".md")) return abs;
    }
    return null;
  };
  return walk(root);
}

async function main() {
  const db = createDb();
  try {
    await seed(db);
  } finally {
    // Left open, the handle kept the data dir locked: on Windows every test
    // file that seeds failed its cleanup with EBUSY (audit OPS-003).
    (db as unknown as { $client: { close(): void } }).$client.close();
  }
}

async function seed(db: ReturnType<typeof createDb>) {
  if (db.select().from(tables.users).all().length > 0) {
    console.log("already seeded — nothing to do");
    return;
  }
  const root = vaultDir();
  const existing = process.env.BASALT_SEED_INTO_EXISTING_VAULT === "1" ? null : firstNote(root);
  if (existing) {
    throw new Error(
      `Refusing to seed: ${root} already holds notes (${path.relative(root, existing)}). ` +
        `Seed writes demo notes and a demo owner with a published password; point ` +
        `BASALT_DATA_DIR and BASALT_VAULT_DIR at an empty scratch folder instead.`,
    );
  }
  if (db.select().from(tables.workspace).all().length === 0) {
    db.insert(tables.workspace).values({ id: uid("w"), name: "Basalt Demo" }).run();
  }

  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    writeFileAtomic(abs, content, { exclusive: true });
  }

  const pw = await argonHash("basalt-demo");
  const users = [
    { id: uid("u"), email: "jules@basalt.dev", username: "jules", displayName: "Jules", passwordHash: pw, isOwner: true, createdAt: Date.now() },
    { id: uid("u"), email: "erin@basalt.dev", username: "erin", displayName: "Erin", passwordHash: pw, isOwner: false, createdAt: Date.now() },
    { id: uid("u"), email: "mara@basalt.dev", username: "mara", displayName: "Mara", passwordHash: pw, isOwner: false, createdAt: Date.now() },
  ];
  for (const u of users) db.insert(tables.users).values(u).run();
  const [jules, erin, mara] = users;

  const eng = { id: uid("t"), slug: "engineering", name: "Engineering", color: "#4a9eff", icon: "e" };
  const mkt = { id: uid("t"), slug: "marketing", name: "Marketing", color: "#e5383b", icon: "m" };
  db.insert(tables.teams).values([eng, mkt]).run();
  db.insert(tables.memberships).values([
    { id: uid("m"), userId: erin!.id, teamId: eng.id },
    { id: uid("m"), userId: jules!.id, teamId: eng.id },
    { id: uid("m"), userId: mara!.id, teamId: mkt.id },
    { id: uid("m"), userId: jules!.id, teamId: mkt.id },
  ]).run();

  db.insert(tables.folderGrants).values([
    { id: uid("g"), teamId: eng.id, folder: "Engineering", role: "editor" },
    { id: uid("g"), teamId: mkt.id, folder: "Marketing", role: "editor" },
    { id: uid("g"), teamId: eng.id, folder: "Shared", role: "editor" },
    { id: uid("g"), teamId: mkt.id, folder: "Shared", role: "editor" },
    { id: uid("g"), teamId: eng.id, folder: "Contacts", role: "editor" },
    { id: uid("g"), teamId: mkt.id, folder: "Contacts", role: "editor" },
    { id: uid("g"), teamId: eng.id, folder: "", role: "viewer" },
    { id: uid("g"), teamId: mkt.id, folder: "", role: "viewer" },
  ]).run();

  db.insert(tables.projects).values([
    { id: uid("p"), kind: "tag", key: "project/atlas", name: "Atlas", teamId: eng.id },
    { id: uid("p"), kind: "tag", key: "project/acme", name: "Acme Relaunch", teamId: mkt.id },
    { id: uid("p"), kind: "folder", key: "Shared", name: "Team Ops", teamId: null },
  ]).run();

  // Boot the store once so every note gets its stable front-matter id.
  const store = new VaultStore(db);
  store.load();

  // Promote one task and mark it in-progress so "who's working on what" has life.
  const roadmap = store.index.getByPath("Engineering/Atlas Roadmap.md")!;
  const spike = roadmap.tasks.find((t) => t.text.includes("partial checkout spike"))!;
  const erinAcl = store.aclUser(erin!.id);
  const promoted = promoteTaskLine(roadmap.content, spike)!;
  store.write(erinAcl, roadmap.path, promoted.content);
  db.insert(tables.taskObjects).values({
    id: uid("task"),
    noteId: roadmap.id,
    blockId: promoted.blockId,
    status: "in-progress",
    assigneeId: erin!.id,
    due: "2026-07-08",
    description: "Spike: manifest diffing + revoke-on-sync behavior.",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }).run();

  // load() started a vault watcher. Left open, it kept `pnpm seed` from ever
  // exiting, and inside a test process it kept a second, stale store alive
  // that re-read the server's writes and logged them against its own
  // seed-time doc — which corrupted the notes' Y.Doc history.
  await store.close();
  console.log("seeded: jules/erin/mara @basalt.dev — password basalt-demo");
}

await main();
