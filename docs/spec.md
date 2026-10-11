> **The original build spec**, as written in July 2026 (`basalt-prompt.md`, v1.0),
> kept here so a clone, CI or an agent can read it. Basalt has since become a
> single-user tool (README, "Status"; CLAUDE.md, "One user, one vault"): the
> team dashboard, invites and team UI described below were built and then
> removed from the interface, while the permission model underneath still
> holds. Where this spec and CLAUDE.md disagree, CLAUDE.md describes the code.

# BASALT — Build Prompt v1.0

> **Working title: Basalt.** Obsidian is volcanic glass; basalt is its structural cousin — the rock that forms interlocking columns (Giant's Causeway). Individual columns, stronger together. That's the product: personal-knowledge-tool DNA, built for teams.
>
> Alternative names, in case Basalt doesn't stick: **Cairn** (stones stacked by travelers to guide the next person — knowledge left for teammates), **Quarry** (where you dig knowledge out), **Tessera** (one tile of a mosaic), **Lodestone** (the stone that gives direction). Check domains/trademarks before public release; "Basalt" is the working title everywhere in this document.

---

## 1. One-paragraph vision

Basalt is a downloadable, open-core, team knowledge tool: **Obsidian you can share with your team without giving up your files.** Notes are plain Markdown files in real folders on disk, linked together `[[wiki-style]]`. A self-hostable sync server keeps every teammate's vault in sync, enforcing team-based permissions so each person only ever receives the files they're allowed to see. The first screen is not a note — it's a **team dashboard**: a live to-do list per team with real progress bars and "who is working on what," computed entirely from tasks written inside the notes, topped with an AI digest. An AI layer (bring-your-own-key, local embeddings) uses the link graph and vector search to pull only the relevant notes into context — smart connections for smarter use of tokens.

**Target customer:** small teams and startups, 5–50 people. **Positioning:** more trustworthy than Notion (your files, your server), more team-ready than Obsidian (permissions, sync, dashboard built in).

---

## 2. Locked product decisions (do not re-litigate)

| Area | Decision |
|---|---|
| Platform | Desktop app first (macOS/Windows/Linux) + browser access to the same workspace in v1 |
| Data | Real Markdown files in folders; sync server is coordinator + permission gate, never the only copy |
| Collab | Sync-with-merge (CRDT under the hood, seconds-fast, auto-merge). No live cursors in v1, but architecture must allow them in v2 |
| Permissions | Layered: folders give baseline team access; tags can additionally restrict or share individual notes |
| Tasks | Both: Markdown checkboxes parsed from any note + promotable to full task objects with assignee/due/status |
| Dashboard | Per-team to-do list with real progress and ownership, fed by the whole vault; AI digest section |
| AI | Bring-your-own-key (workspace admin's Claude/OpenAI key); embeddings computed locally/on own server; RAG over the vault |
| Web in v1 | Browser read/edit access for team members. Public publishing (handbook sites) is v2 |
| Business | Open core: app + server open source and self-hostable; hosted cloud + enterprise features (SSO, audit) later |
| Design | Adaptive dual theme via design tokens: dark "command center" default, light "paper" theme for writing |
| Plugins | None in v1. Keep internals modular so a plugin API is feasible in v2. CSS theming is cheap — allow it |

---

## 3. Core concepts & vocabulary

- **Workspace** — one company/org. Has members, teams, one vault.
- **Vault** — the folder tree of Markdown files. Server holds the authoritative replica; each client holds a *partial checkout* (only what that user may read).
- **Team** — named group of members (Engineering, Marketing…). Teams have a color, an icon, and a set of *team tags*. A member can belong to multiple teams.
- **Role** — per-team: `admin` / `editor` / `viewer`. Workspace-level `owner` exists above all teams.
- **Note** — a Markdown file. Front-matter (YAML) holds id, tags, and system metadata. Body is CommonMark + wiki-links + checkboxes.
- **Link** — `[[Note Name]]` or `[[Note Name|alias]]` or `[[Note#Heading]]`. Backlinks are first-class and always visible in a side panel.
- **Tag** — `#tag` inline or in front-matter. Hierarchical (`#project/atlas`). Two special namespaces have security meaning (§5).
- **Task** — a checkbox line in any note; optionally *promoted* to a task object (§7).
- **Project** — a folder or a tag designated as a project; the unit progress is computed against.

---

## 4. Architecture & tech stack (chosen — justify in code comments, don't revisit)

**Monorepo (pnpm + Turborepo):**

```
basalt/
  apps/
    desktop/        # Tauri 2 shell (Rust) — window, FS access, file watcher, keychain, tray
    web/            # Same React app served by the server for browser access
    server/         # Node 22 + Fastify — sync, auth, permissions, task/index API, AI proxy
  packages/
    core/           # TS. Vault engine: markdown parsing, link graph, tag index, task extraction. Runs in desktop, web, AND server — one parser everywhere
    sync/           # TS. Sync protocol client+server logic (Yjs update exchange, partial checkout manifests)
    ui/             # React component library + design tokens (both themes)
    schema/         # Zod schemas + Drizzle table definitions shared by server and clients
```

**Choices and why:**
- **TypeScript everywhere for product logic; Rust only as the Tauri shell.** One language means the vault engine (`packages/core`) runs identically on desktop, web, and server — the same parser produces the same link graph and task list everywhere. This is the single most important architectural property.
- **Tauri 2 over Electron:** ~10 MB binaries, native FS speed, and the UI is plain web code, which is exactly what `apps/web` reuses.
- **Editor: CodeMirror 6** with a live-preview Markdown setup (Obsidian-style: syntax hides when the cursor leaves it). Not a block editor — Basalt is a *text* tool.
- **CRDT: Yjs.** Each note is a `Y.Doc` (Y.Text of the Markdown source). Clients merge offline edits automatically; the Markdown file on disk is the render of the Y.Doc. Store Y.Doc updates server-side per note for history. This is also the upgrade path to live cursors in v2 (y-protocols awareness).
- **Server storage:** SQLite via Drizzle for the default single-container self-host (small teams!), with Postgres as a config option. Files stored on the server's disk as a real folder tree (bonus: admins can back it up with rsync/git). S3-compatible blob storage optional for attachments.
- **Deployment:** one `docker compose up` for the whole self-host (server + web). Desktop installers via Tauri bundler + GitHub Releases with auto-update.
- **Auth:** email+password (argon2) + workspace invite links in v1. Structure the auth module so OIDC/SAML can be added without refactoring (auth provider interface).
- **License:** Apache-2.0 for everything in v1. Future paid enterprise features live in a clearly separated `ee/` directory under a commercial license (GitLab model). Never mix `ee/` imports into core.

---

## 5. Permission model (the heart of the server — spec precisely)

### 5.1 Folder baseline
- Permissions attach to **top-level folders** (and may be overridden on any subfolder).
- A grant is `(team, folder, role)` where role ∈ `viewer | editor | admin`.
- Effective folder access for a user = max role across their teams for the nearest ancestor folder with an explicit grant.
- A folder with no applicable grant is invisible: it does not appear in the tree, search, graph, or sync manifest.

### 5.2 Tag overlays (the novel layer)
Two reserved tag namespaces, valid inline or in front-matter:
- **Restrict:** `#only/<team>` — the note is visible *only* to that team (and workspace owners), even inside a folder others can read. Multiple `#only/` tags = union of those teams.
- **Share:** `#share/<team>` — grants that team **read** access to this single note even if they have no access to its folder. (Read-only by design: cross-team edit rights must be granted via folders, deliberately.)

### 5.3 Anti-lockout & abuse rules (server-enforced, reject on sync)
1. Adding or removing a `#only/<team>` tag requires the actor to be a member of `<team>` (or workspace owner). Otherwise anyone could hide notes from their own team, or lock a team out of its notes.
2. A user can never produce, via any edit, a note state that they themselves can no longer read. Reject with a clear error.
3. `#share/` tags can be added by anyone with edit rights on the note, removed likewise.
4. Workspace owners see everything (documented, visible in UI — no secret superuser).

### 5.4 Information-leak rules
- Sync manifests contain only readable files: unreadable notes never reach a client's disk. This is partial checkout, not client-side filtering.
- A `[[link]]` to an unreadable note renders as a "locked" stub — the link text the author wrote is visible (they wrote it), but no preview, no backlink content, no existence confirmation beyond the styling.
- Search results, graph nodes, embeddings retrieval, task lists, and dashboard aggregates are all filtered by the same ACL function — implement it once in `packages/core`, use it everywhere, test it hard. **Every permission rule in this section must have automated tests, including the leak rules.**

---

## 6. The dashboard (first screen, the product's face)

Not a widget wall. A **team command center** answering three questions at a glance: *What are we doing? How far along are we? Who's on what?*

Layout (dark "command center" theme by default):
1. **Team switcher** (left rail) — teams you belong to, each with color + progress ring.
2. **Team to-do board** (center) — the team's open tasks, grouped by project. Each project row: name, progress bar (`done/total` checkboxes+tasks), avatars of assignees currently active in it, most recent activity timestamp. Expand a project → its tasks, checkable *directly from the dashboard* (checking here edits the underlying Markdown — the file is always the source of truth).
3. **Who's working on what** (right column) — one row per teammate: their in-progress/assigned tasks and the note they most recently edited. Presence = recent edit activity, not surveillance; no idle timers, no screenshots, ever.
4. **AI digest** (top banner, collapsible) — generated on demand and cached daily per team: what changed, what got completed, what looks stale, suggested connections ("these 2 notes discuss the same client — link them?"). Only renders if a workspace AI key is configured; the dashboard must be fully useful without it.
5. **Quick capture** — a one-keystroke box (`c`) that appends to the user's daily note or inbox note.

Everything on the dashboard is a *view over the vault* — deleting the server DB and re-indexing the Markdown must rebuild the whole dashboard except task-object metadata (§7).

---

## 7. Tasks (both modes, one source of truth)

### 7.1 Checkbox tasks (lightweight, file-native)
- Any `- [ ]` / `- [x]` line in any note is a task. Parsed by `packages/core` with inline metadata:
  - Assignee: `@jules` (matched to workspace members; renders as avatar chip)
  - Due date: `due:2026-07-10` (renders as a date chip; overdue = red)
  - Priority: `!p1` `!p2` `!p3`
- The task's *project* = the note's project (nearest project folder or project tag).
- Progress = checked/total within the project. Real, computed, no manual status.

### 7.2 Promoted task objects (structure when needed)
- Any checkbox can be **promoted** (UI action). Promotion appends a stable block id to the line (`^t-a1b2c3`) and creates a task row in the server DB keyed by `(note id, block id)` with: status (`todo/in-progress/done/blocked`), assignee, due, description, and a comment thread.
- **Two-way binding:** checking the box in the file marks the object done; closing the object checks the box in the file (a real file edit through the CRDT). Conflicts resolve file-wins.
- If the line is deleted from the note, the object goes to an "orphaned" state and is shown on the dashboard for triage — never silently deleted.
- "In-progress" status is what powers "who is working on what."

---

## 8. Editor & knowledge features (the Obsidian bar to clear)

v1 must include, well-executed rather than numerous:
- Live-preview Markdown editing (CodeMirror 6), plus a raw-source toggle.
- `[[` autocomplete for links (fuzzy over titles + aliases + headings), `#` autocomplete for tags, `@` for members.
- Backlinks panel + unlinked mentions.
- Fast full-vault search (client-side index in the desktop app; server-side for web) with filters: `tag:`, `path:`, `task:`, `assignee:`.
- Tag pane and folder tree (respecting permissions).
- Local graph view (note-centric, 1–2 hops). Full workspace graph can wait for v2 — a small, fast, useful graph beats a slow galaxy.
- Daily notes + templates (simple `{{date}}`-style variables).
- Attachments: images/PDFs pasted into notes, stored in the vault, synced with the same permissions as their folder.
- Command palette (`cmd+k`) and full keyboard-first navigation.
- File format promise: **valid CommonMark + front-matter + wiki-links, no proprietary syntax beyond §7 metadata.** A Basalt vault must open fine in Obsidian, and vice versa (Basalt should import an Obsidian vault as onboarding — this is a killer acquisition feature; make it a first-run option).

---

## 9. AI layer ("smart connections, smarter tokens")

- **Keys:** workspace admin configures a provider + API key (Anthropic first-class, OpenAI-compatible endpoint as generic option). Key stored encrypted at rest on *their* server; requests go direct from their server to the provider. Basalt-the-company is never in the data path. Per-member toggle to opt out of their notes being sent to the provider.
- **Embeddings:** computed with a local model (e.g. a small sentence-transformer via ONNX runtime) on the sync server at index time; stored in SQLite (sqlite-vec) per chunk. No embedding API costs, no note content leaving the server for indexing.
- **Retrieval (the "smart connections" pitch):** for a query, candidate notes = vector top-k **∪** link-graph neighbors (1 hop) of the current note **∪** same-project recent notes, then rerank, then pack into the model's context under an explicit token budget. The link structure the team built by hand *is* the retrieval signal — that's why RAG here beats generic RAG, and the pitch is honest: fewer, better tokens.
- **ACL before AI, always:** retrieval only ever searches notes the *requesting user* can read. Test this as rigorously as §5.
- **Surfaces in v1 (only three, all with citations that open the source note):**
  1. **Ask your vault** — chat panel; answers cite `[[notes]]`.
  2. **Team digest** — the dashboard banner (§6.4).
  3. **Suggested links** — sidebar section on each note: "possibly related, not yet linked" (pure embeddings, no API call, free and instant; one-click to insert the link).
- Explicitly out of v1: AI autocomplete-while-typing, agents that edit notes, auto-tagging.

---

## 10. Sync protocol (summary spec)

- Client authenticates (JWT), receives a **manifest** of readable files (path, note id, Y.Doc state vector, content hash).
- Delta sync: client sends local Y.Doc updates, receives remote updates, applies, renders Markdown to disk. Attachments sync by content hash.
- Offline-first: full functionality offline against the local partial checkout; queued updates merge on reconnect (that's the CRDT's job).
- Permission changes trigger manifest re-evaluation: revoked files are deleted from the client's checkout on next sync (documented behavior: "revoke removes remote copies on next sync; it cannot un-see").
- File renames/moves are metadata operations (note ids are stable, in front-matter), so links never break; `packages/core` updates link *display* text lazily.
- History: server retains Y.Doc update log per note → per-note version history UI ("restore this version" = new merged edit, never destructive).

---

## 11. Design system

Token-first (CSS custom properties in `packages/ui`), two complete themes shipped in v1:
- **Command Center (dark, default):** near-black `#0d0f12` surfaces, one restrained accent (electric cyan or team color), glassy elevated panels, subtle 1px borders (`rgba(255,255,255,.08)`), Inter for UI, JetBrains Mono for code. Linear/Raycast energy — a power tool, not a toy.
- **Paper (light):** warm off-white `#faf9f6`, high-contrast charcoal text, generous line-height (1.65), serif optional for reading mode. Calm, for long writing sessions.
- Theme applies per-context if the user wants: dashboard in dark, editor in light — support this, it's the "adaptive" promise.
- Density: comfortable default, `compact` mode toggle (small teams have power users).
- Every interactive element keyboard-reachable; visible focus rings; WCAG AA contrast in both themes.
- Team colors are semantic tokens used consistently: rail, progress rings, graph nodes, avatars.

---

## 12. Milestones (build in this order; each one ends usable)

- **M0 — Local Basalt (no server).** Tauri app opens a folder as vault: editor, links, backlinks, tags, search, daily notes, task parsing, *local* dashboard (personal tasks + progress). Obsidian-vault import. → Already a usable personal app; validates `packages/core`.
- **M1 — Sync + Teams.** Server (Docker), accounts, invites, teams, folder permissions, partial checkout, CRDT merge sync, version history. Two users on two machines editing one vault safely.
- **M2 — The Dashboard.** Tag overlays (`#only/`, `#share/`) with full test suite; task promotion + task objects; team dashboard with progress, who-does-what, dashboard checkboxes writing back to files.
- **M3 — Web + AI.** `apps/web` served by the server (read/edit, dashboard); AI layer: local embeddings, suggested links, ask-your-vault, team digest, BYO key config.
- **M4 — Ship.** Installers + auto-update, `docker compose` self-host path polished, onboarding flow, docs site, seed demo workspace, Apache-2.0 release on GitHub.

**Non-goals for v1 (write them in the README to keep scope honest):** plugin API, live cursors, public publishing, mobile apps, SSO/SCIM/audit logs (v2 `ee/`), whiteboards/canvas, comments-on-text (task comments only).

---

## 13. Quality bar & acceptance criteria

- `packages/core` parser: golden-file test suite (Markdown in → links/tags/tasks out); property tests for CRDT merge (any interleaving of edits converges).
- Permission tests are release-blocking: folder rules, both tag namespaces, all four §5.3 abuse rules, all §5.4 leak rules, ACL-filtered search/graph/RAG.
- Performance targets: 10k-note vault → cold open < 2s, search-as-you-type < 50ms, sync round-trip < 3s on LAN.
- Dashboard rebuildable from Markdown alone (delete DB, re-index, diff — only task-object extras may differ).
- A brand-new user goes from download → first synced team note in under 10 minutes without reading docs.
