# ⬡ Basalt

**A personal knowledge and life OS built on plain Markdown files.**

Notes are real `.md` files in real folders, linked `[[wiki-style]]`. On top of that
same vault sit a dashboard, a calendar, project workspaces, contacts, mail and
finance — every one of them a *view over the files*, not a separate database with
its own truth. The vault opens fine in Obsidian; Basalt reads and writes the same
folder live.

> Obsidian is volcanic glass; basalt is its structural cousin — the rock that forms
> interlocking columns. Individual columns, stronger together.

## What it does

| Surface | What it is |
|---|---|
| **Dashboard** | The first screen. Everything the vault knows about today — tasks due, project progress, what changed |
| **Architecture** | The vault itself: file tree, Markdown editor (CodeMirror), backlinks, and a force-directed graph of the link structure |
| **Planning** | Week and month calendar — dated notes as a band, time-blocks on a grid, events, ICS feeds in and out, auto-scheduling |
| **Overview** | Project board grouped by life-area, with a Gantt view; drills into a per-project workspace whose goals, decisions and inbox are `##` sections of one note |
| **Contacts** | People and companies side by side, both derived from `#contact` notes and their front-matter |
| **Mail** | Gmail over IMAP/SMTP, in-app |
| **Finance** | Bank statements, payslips, spending categories, subscriptions and savings — parsed in `packages/core`, rules authored as Markdown tables in the vault |

Plus a command palette, quick capture, and **Ask** — retrieval over the vault using
your own AI provider key.

## The idea that holds it together

- **Your files stay files.** Valid CommonMark + YAML front-matter + wiki-links. No
  lock-in, no proprietary store — `rsync` or `git init` the folder and you're backed up.
- **The database is disposable.** SQLite holds an index and the CRDT update log.
  Delete it, re-index the Markdown, and the dashboard rebuilds. Only promoted-task
  metadata is DB-only.
- **Tasks without a second system.** Any `- [ ]` line in any note is a task
  (`@assignee due:2026-07-10 !p1`). Promote one when it needs structure; the checkbox
  in the file and the task object stay two-way bound, and the file wins.
- **One engine, three surfaces.** `packages/core` does the parsing and the permission
  checks, and server, web and desktop all run that same code.
- **Your keys.** AI is bring-your-own-key against your own server. Anthropic, Google
  and OpenAI are all supported and loaded on demand.

## Stack

TypeScript end to end, except a deliberately thin Rust shell.

- **Server** — Fastify 5, SQLite (better-sqlite3) via Drizzle ORM, Zod, Yjs for CRDT
  note merging, chokidar to pick up external edits, argon2 for passwords
- **Web** — React 19, Vite 6, CodeMirror 6, d3-force, Vercel AI SDK
- **Desktop** — Tauri 2. Rust is window, filesystem, watcher and tray only; all
  product logic is the shared TypeScript
- **Monorepo** — pnpm workspaces + Turborepo, Node ≥22
- **Tests** — Vitest: **262 cases** across core, sync and server

## Layout

| Path | What |
|---|---|
| `packages/core` | Vault engine — parser, link graph, tags, tasks, sections, finance, **ACL** |
| `packages/sync` | Y.Doc helpers, splice diffs, partial-checkout manifests |
| `packages/schema` | Zod API schemas + Drizzle tables |
| `packages/ui` | Design tokens and base styles, shared across surfaces |
| `apps/server` | Fastify API, vault store, SQLite index, WebSocket bus |
| `apps/web` | React app, served by the server in production |
| `apps/desktop` | Tauri shell |

## Running it

```bash
pnpm install
pnpm --dir apps/web build       # the server serves a built bundle
pnpm --dir apps/server start    # http://127.0.0.1:4623
```

A fresh install asks you to create an account — the first one founds the workspace
and owns it. `pnpm --dir apps/server seed` is optional and loads a sample vault.
Full walkthrough, including how to point Basalt at an existing Obsidian vault:
**[INSTALL.md](INSTALL.md)**.

> `pnpm build` and `pnpm dev` fan out to `apps/desktop`, which is a Tauri app and
> needs a Rust toolchain. Use the scoped commands above unless you want a desktop
> bundle. `pnpm --dir apps/web dev` (:4625) is for iterating on the frontend.

After changing web code, `pnpm ship` — typecheck, test, build, restart. Editing
source alone changes nothing in a running instance, because it serves the *built*
bundle and registers static files at boot.

```bash
pnpm test        # 262 tests
pnpm typecheck
```

Self-hosting is `docker compose up`; set `BASALT_JWT_SECRET` and `BASALT_SECRET_KEY`
to real values first.

## Permissions

Basalt has a full team permission model, and it is the most carefully tested part of
the codebase — folder grants, two tag overlays (`#only/<team>` restricts,
`#share/<team>` shares read-only), path-based personal vaults, and anti-lockout rules
the server enforces on every write. Unreadable notes are filtered server-side and
never reach a client (partial checkout, not client-side hiding), and every surface —
search, graph, backlinks, tasks, dashboard, AI retrieval — goes through the same
`packages/core` function.

In practice Basalt runs single-user today. The model is infrastructure that works,
not a feature with a finished onboarding flow around it.

## Status

Honest state of things:

- **Single user.** Accounts, teams and grants all exist, and a fresh install now
  creates a real account rather than handing out demo logins — but there is still
  no invite flow, so a second person cannot be added from the UI.
- **No CI.** The 262 tests pass, but only when run by hand.
- **Desktop needs a Rust toolchain** to build; there are no signed installers yet.
- The original build spec (`~/basalt-prompt.md`) planned a team product for 5–50
  person startups. What got built and used daily is this: a personal tool. The README
  now describes the latter.

## License

Apache-2.0.
