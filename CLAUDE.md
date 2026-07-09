# Basalt — codebase guide

Team knowledge tool on plain Markdown files. Product spec (locked decisions, do not
re-litigate): `~/basalt-prompt.md`. Working title everywhere is **Basalt**.

## Architecture in one paragraph

Everything is TypeScript except the thin Tauri shell. `packages/core` is the single
source of truth for parsing (front-matter, `[[links]]`, `#tags`, checkbox tasks) and
for **permissions** — desktop, web, and server all run the same code. The server
(`apps/server`) holds the vault as real `.md` files on disk plus a SQLite index; each
note is a Yjs `Y.Doc` whose update log lives in SQLite (history + merge). Clients get
a *partial checkout*: unreadable notes are filtered server-side before transport and
never reach the wire. The dashboard is a pure view over checkbox tasks in the notes —
delete the DB, re-index the Markdown, and it rebuilds (only promoted-task metadata
lives DB-only).

## Layout

| Path | Contents |
|---|---|
| `packages/core/src/parse.ts` | Markdown → links/tags/tasks/headings. Line-based; skips code fences |
| `packages/core/src/acl.ts` | **THE permission implementation.** `canRead`/`canEdit`/`validateEdit`/`filterReadable` + `personalOwner`. Never filter anywhere else |
| `packages/core/src/vault.ts` | `VaultIndex`: link resolution, backlinks, tag index, project progress, search |
| `packages/core/src/tasks.ts` | Text transforms: toggle checkbox, promote (`^t-xxxxxx` block id), append |
| `packages/core/src/related.ts` | "Suggested links" TF-IDF scorer (embeddings will replace scorer, same interface) |
| `packages/sync/` | Y.Doc helpers, splice diffs, `computeManifest` (partial checkout) |
| `packages/schema/` | Zod API schemas (`api.ts`) + Drizzle tables (`db.ts`) |
| `apps/server/src/vaultStore.ts` | Files-on-disk + index + Y.Doc cache + `events` EventEmitter (live sync bus) |
| `apps/server/src/routes/` | auth, vault, tasks, dashboard, home (personal aggregates for the Dashboard), admin, ai, ws, plan, calendar, contacts, ics (ICS feeds in/out), integrations (API tokens + webhooks), terminal (node-pty PTY over WS, owner-only) — one file each |
| `apps/server/src/ics.ts` | Minimal RFC 5545 parse/expand/build (RRULE subset, TZID via Intl) — no Google API |
| `apps/server/src/webhooks.ts` | Outgoing webhook dispatcher; HMAC-signed, ACL-filtered per hook owner |
| `apps/web/src/` | React, left-rail shell in `App.tsx`: `Dashboard` (default tab, `/api/home`), `Architecture` (scoped files + `GraphCanvas` + `Editor`), `Planning` (week/month calendar: backlog→grid time-blocks, events, ICS overlay, est. via `/api/plan`), `Overview` (project board by life-area, `Gantt.tsx`), `Contacts`, `Terminal.tsx` (xterm, owner-only), `Admin` (DnD grants), `Settings` (character `avatars.tsx`), `AskPanel`, `icons.tsx` (no emoji chrome), `ws.ts` |
| `apps/desktop/` | Tauri 2 scaffold; building needs a Rust toolchain |

## Permission model (memorize this)

1. Folder grants `(team, folder, role)`; nearest ancestor **with any grant** decides
   (a subfolder grant overrides and can restrict). No applicable grant → invisible.
2. `#only/<team>` restricts a note to that team (union across tags); wins over
   everything except workspace owners. `#share/<team>` grants read-only across
   folder boundaries. Touching `#only/<team>` requires membership of `<team>`;
   no edit may make a note unreadable to its own editor (server rejects).
3. `Personal/<username>/…` is permissioned **by path**: that user + owners only;
   `#share` can extend read. Folder grants never apply there. Quick capture writes
   to `Personal/<username>/Inbox.md`.
4. Owners see everything (documented, visible — no secret superuser).
5. Every user-facing surface (tree, search, backlinks, tags, tasks, dashboard,
   manifest, WS events, AI retrieval) filters through `packages/core` ACL. Adding a
   surface? Call `filterReadable`/`canRead` and add a leak test.

## Live sync

`VaultStore.events` emits `note-changed` on every mutation → `routes/ws.ts`
broadcasts to connected clients **after a per-recipient `canRead` check**. Clients
(`apps/web/src/ws.ts`) auto-reconnect; Notes view refetches the open note (editor
only swaps content when unfocused), Dashboard reloads debounced. Presence =
`{type:"editing", noteId}` pings, rebroadcast only to users who can read that note.

## Conventions & gotchas

- Team **slugs** (not ids) are the `TeamId` in core ACL and what `#only/#share` match.
- Note ids live in front-matter (`id: n-…`), assigned on first index; renames are
  metadata ops so links never break. `VaultStore.write` preserves the existing id.
- Unreadable link targets render as locked stubs: author's text only, 404 on fetch —
  never confirm existence (§5.4).
- Web saves send full content + `baseHash`; server rebases as a splice against the
  live Y.Doc. Desktop clients will exchange raw Y updates instead.
- DB bootstraps from plain SQL in `apps/server/src/db.ts` (no drizzle-kit). Keep the
  Drizzle table defs in `packages/schema/src/db.ts` in lockstep with it.
- Task objects are keyed `(noteId, blockId)`; file wins on conflict; deleted lines
  orphan the object (surfaced on the dashboard, never auto-deleted).

## Design rules

**Glass design language** (the mock lives in `~/basalt-dash-mock`;
`architecture-glass.html` is canonical). Frosted translucent surfaces
(`backdrop-filter: blur(22–26px) saturate(150%)`, `--glass*` fills, 1px
`--glass-brd` borders, inset top-highlight) float over a fixed radial-blob
backdrop (`base.css` body). Two themes, swapped by the rail's animated toggle
(View Transitions API clip-path ripple from the click point, `base.css`):
`[data-theme="command"]` = graphite monochrome (silver accent), `[data-theme="light"]`
= frosted white (sapphire accent). The purple `--logo` mark is the only constant
spark. Radii: `--radius` 12 / `--radius-sm` 8 / `--radius-lg` 22 (cards, rail,
modals). Type is Plus Jakarta Sans (`--font-ui`) + JetBrains Mono for
numbers/paths/micro-labels; mono/paths still carry meaning. No emoji as icons
(use `icons.tsx`). **Token-first**: everything reads `var(--…)` from
`packages/ui/src/tokens.css`, so a theme is just a token set — retint there, not
in components. The map (`GraphCanvas`) is a live d3-force
graph on canvas, Obsidian-style: repulsion + `forceCollide` (nodes never overlap),
link springs, drag a node to move it (pointer sets `fx/fy`, release settles),
wheel-zoom, background-pan, hover lights the neighbourhood, labels appear on
hover/zoom only. Nodes are coloured by `categories.ts` — the SINGLE source of
truth for vault grouping+colour, shared by the map, the file-list dots, and the
category filter, so a note is the same colour everywhere. Team color is data,
not decoration. Members are hex-column characters (`avatars.tsx`).

The **Dashboard** (`Dashboard.tsx`, the default tab) is a frosted card grid
(HireFlow-style layout: rounded glass cards, In Focus tints, badge pills,
avatars). Six cards: hero stat, this-week/last-week activity line chart, In Focus
tasks, Schedule (mini calendar + agenda), Today's Tasks checklist, Analytics
(stat tiles + category donut). Scoped under `.home` via `--d-*` vars, but those
now alias the global glass tokens (`--glass`, `--ink`→`--text`, badge hues,
translucent `color-mix` tints), so the Dashboard flips with the theme toggle like
every other surface — no bespoke light-only palette, no special rail. Fed by
`/api/home` (personal aggregates, ACL-filtered) + the donut computed client-side
from the tree via `categories.ts`. Charts are hand-drawn SVG, no chart lib.

The editor is live-preview (`livePreview.ts`): frontmatter collapses to a
properties row (StateField — multi-line replaces can't live in view plugins),
checkboxes/tags/links/metadata render as widgets and chips, the active line
always shows raw source. Planning is a calendar: `planned_date` on task objects,
`POST /api/tasks/schedule` (auto-promotes), drag from backlog to days, parallel
read-only lanes for selected teammates.

## Dev loop

```sh
pnpm install
pnpm --dir apps/server seed   # demo: jules/erin/mara @basalt.dev, pw basalt-demo
pnpm --dir apps/server dev    # :4623 (delete apps/server/data to reseed)
pnpm --dir apps/web dev       # :4625, proxies /api (ws included)
pnpm test                     # core + sync + server — permission tests are release-blocking
```

Ports 4623/4625 are deliberate (4620/4621 are taken on this machine). When testing
the web UI programmatically: React controlled inputs need native-setter + `input`
event dispatch, and forms need `requestSubmit()`.
