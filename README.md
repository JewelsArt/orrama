# Orrama

**A personal knowledge and life OS built on plain Markdown files.**

Notes are real `.md` files in real folders, linked `[[wiki-style]]`. On top of that
same vault sit a dashboard, a calendar, project workspaces, contacts, mail and
finance — every one of them a *view over the files*, not a separate database with
its own truth. The vault opens fine in Obsidian; Orrama reads and writes the same
folder live.

## What it does

| Surface | What it is |
|---|---|
| **Today** | The first screen: the day's timetable, what is due or late, unread mail and Orr's drafts, people you will see, what is coming up, projects, money against a typical month |
| **Notes** | The vault itself: file tree, the live-preview Markdown editor (CodeMirror), pins, backlinks |
| **Orrery** | A map of the vault: every file around Orr, in rings by kind and slices by life area, or one thing at the centre with what is one step away |
| **Planning** | Week, day and month — dated tasks, deadlines and money as a band, time-blocks and events, ICS feeds in and out, "Plan my week" proposals |
| **Projects** | One row per project; each opens a workspace whose goals, decisions and inbox are `##` sections of one note, with a timeline, documents and a to-do list |
| **People** | People and companies side by side, from `#contact` and `#company` notes and their front-matter |
| **Mail** | Gmail over IMAP/SMTP, in-app; the agent drafts, only you send |
| **Money** | Bank statements, payslips, spending categories, subscriptions and savings — parsed in `packages/core`, rules authored as Markdown tables in the vault |

Plus a command palette, quick capture, and **Ask** — retrieval over the vault using
your own AI provider key.

## The idea that holds it together

- **Your files stay files.** Valid CommonMark + YAML front-matter + wiki-links. No
  lock-in, no proprietary store — `rsync` or `git init` the folder and you're backed up.
- **The files are the truth.** SQLite holds an index of the Markdown, which
  rebuilds from the files: notes, task status, time blocks, events, projects.
  It also holds what has no place in a note — accounts and credentials, task
  comments, mail drafts, and every note's history — so it is backed up with
  `pnpm --dir apps/server export`, not deleted.
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
- **Desktop** — Tauri 2: a native window on the local server, with no Tauri
  commands; all product logic is the shared TypeScript
- **Monorepo** — pnpm workspaces + Turborepo, Node ≥22
- **Tests** — Vitest across core, sync, server, web and mcp; CI runs them (see Status)

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
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)   # keep both: the next start
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)   # needs the same values
pnpm --dir apps/server start    # http://127.0.0.1:4623
```

A fresh install asks you to create an account — the first one founds the workspace
and owns it. The server refuses to start on missing or placeholder secrets. To look
around with a sample vault instead, `pnpm --dir apps/server seed` then
`pnpm --dir apps/server dev` (:4627, its own `data-dev` folder). Full walkthrough,
including how to point Orrama at an existing Obsidian vault:
**[INSTALL.md](INSTALL.md)**.

> `pnpm build` and `pnpm dev` fan out to `apps/desktop`, which is a Tauri app and
> needs a Rust toolchain. Use the scoped commands above unless you want a desktop
> bundle. `pnpm --dir apps/web dev` (:4625) is for iterating on the frontend.

After changing web code, `pnpm ship` — typecheck, test, build, restart. Editing
source alone changes nothing in a running instance, because it serves the *built*
bundle and registers static files at boot.

```bash
pnpm test        # core, sync, server, web, mcp
pnpm typecheck
```

Self-hosting is `docker compose up`, with `ORRAMA_JWT_SECRET` and
`ORRAMA_SECRET_KEY` exported first — the server refuses to boot on placeholder
secrets. Builds on arm64 and x64, so a Raspberry Pi works.

## Permissions

Orrama has a full team permission model, and it is the most carefully tested part of
the codebase — folder grants, two tag overlays (`#only/<team>` restricts,
`#share/<team>` shares read-only), path-based personal vaults, and anti-lockout rules
the server enforces on every write. Unreadable notes are filtered server-side and
never reach a client (partial checkout, not client-side hiding), and every surface —
search, graph, backlinks, tasks, dashboard, AI retrieval — goes through the same
`packages/core` function.

In practice Orrama runs single-user today. The model is infrastructure that works,
not a feature with a finished onboarding flow around it.

## Status

Honest state of things:

- **Single user.** Accounts, teams and grants all exist, and a fresh install now
  creates a real account rather than handing out demo logins — but there is still
  no invite flow, so a second person cannot be added from the UI.
- **CI** (`.github/workflows/`) runs typecheck, every package's tests, the web
  build and a dependency audit on Ubuntu for each push to `main` and each pull
  request. It builds and boots the Docker image when the image's files or the
  lockfile change. Typecheck and tests on macOS and Windows, the Docker image
  and the desktop crate also run weekly and by hand (CLAUDE.md, "Releases").
- **Desktop needs a Rust toolchain** to build; there are no signed installers yet.
- The original build spec ([docs/spec.md](docs/spec.md)) planned a team product for 5–50
  person startups. What got built and used daily is this: a personal tool. The README
  now describes the latter.

## Licence

Orrama is free software, copyright © 2026 Jules Timothy Sekelj, under the
[GNU Affero General Public License v3.0](LICENSE) or any later version (SPDX
`AGPL-3.0-or-later`). You may use, change and share it, for work too. If you share a
changed copy, or run one for other people over a network, you must offer them its source
under the same licence: Settings links to the source the server runs
(`ORRAMA_SOURCE_URL`, see INSTALL.md). The third-party software Orrama includes keeps its
own licences: see [NOTICE](NOTICE).
