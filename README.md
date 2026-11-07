# Orrama

Orrama keeps your notes, projects, plans, people, mail and money in one app, on top of a
folder of plain Markdown files that stays yours. It runs on your own computer: nothing is
sent anywhere unless you connect it (your mail, a calendar, an AI provider).

## Download

Get the newest version from **[Releases](https://github.com/JewelsArt/orrama/releases/latest)**:

- **Mac** (Apple silicon, macOS 13.5 or later): the `.dmg`. The app isn't signed by Apple yet,
  so the first time macOS says it can't check it: open System Settings → Privacy & Security
  and click Open Anyway, once.
- **Windows** (10 or 11, 64-bit): the `-setup.exe`. It installs for you alone, no administrator
  needed. It isn't signed yet either: on the blue SmartScreen box, click More info, then Run
  anyway.

Open Orrama, make your account, and choose where your notes live: a new folder, an example
to look around in, or a folder of Markdown you already have (an Obsidian vault works as it
is). Orrama updates itself when a new version is out.

## What it does

| Page | What it is |
|---|---|
| **Today** | The day's timetable, what is due or late, unread mail, who you'll see, what's coming up, your projects, money this month |
| **Notes** | Your folder of notes: a live-preview Markdown editor, `[[links]]`, backlinks, pins, history |
| **Orrery** | A map of everything, by kind and life area, or one thing in the middle with what it touches |
| **Planning** | Week, day and month: dated steps, deadlines, time blocks and events, calendars in and out |
| **Projects** | One row per project; each opens a workspace whose goals, decisions and inbox are sections of one note |
| **People** | People and companies, from your contact notes |
| **Mail** | Gmail in the app; the assistant can draft, only you send |
| **Money** | Bank statements, payslips, categories, subscriptions and savings, with the rules kept as tables in your notes |

**Orr**, the assistant, answers questions about your notes with the AI you choose: sign in
with ChatGPT, or a key from Anthropic or Google. Without one, everything else still works.

Your notes stay files. Any `- [ ]` line is a task, a project is a note with a tag, a
calendar is a table: delete Orrama's database and it rebuilds them from the folder. The
database keeps only what has no place in a note: your account, mail drafts, comments and
each note's history.

## Running it from source

For developers. The desktop app also needs a Rust toolchain; the server and the web app
need Node 22 or later and pnpm.

```bash
git clone https://github.com/JewelsArt/orrama.git
cd orrama
pnpm install
pnpm --dir apps/web build       # the server serves the built web app
export ORRAMA_JWT_SECRET=$(openssl rand -hex 32)   # keep both: the next start
export ORRAMA_SECRET_KEY=$(openssl rand -hex 32)   # needs the same values
pnpm --dir apps/server start    # http://127.0.0.1:4623
```

The server refuses to start without real secrets. To look around with a sample vault instead,
`pnpm --dir apps/server seed` then `pnpm --dir apps/server dev` (:4627, its own `data-dev`
folder). [INSTALL.md](INSTALL.md) has the full walkthrough, Docker (`docker compose up`)
and how to point Orrama at an existing vault; [apps/desktop/README.md](apps/desktop/README.md)
builds the desktop app.

```bash
pnpm test        # core, sync, server, web, mcp
pnpm typecheck
```

How the code is laid out:

| Path | What |
|---|---|
| `packages/core` | Parsing, links, tags, tasks, sections, finance, and the permission rules every surface goes through |
| `packages/sync` | Note merging (Yjs) |
| `packages/schema` | API and database schemas |
| `packages/ui` | Design tokens and base styles |
| `apps/server` | The API, the notes folder and its index, live updates |
| `apps/web` | The app's pages (React) |
| `apps/desktop` | The desktop app (Tauri), which starts its own server |
| `apps/mcp` | An MCP server, so Claude Code and other agents can use your notes |

TypeScript throughout, except the desktop app's thin Rust shell.

## Security and contributing

Found a security hole? Please report it privately: [SECURITY.md](SECURITY.md).
Want to contribute? Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Licence

Orrama is free software, copyright © 2026 Jules Timothy Sekelj, under the
[GNU Affero General Public License v3.0](LICENSE) or any later version (SPDX
`AGPL-3.0-or-later`). You may use, change and share it, for work too. If you share a
changed copy, or run one for other people over a network, you must offer them its source
under the same licence: Settings links to the source the server runs
(`ORRAMA_SOURCE_URL`, see INSTALL.md). The third-party software Orrama includes keeps its
own licences: see [NOTICE](NOTICE).
