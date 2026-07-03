# ⬡ Basalt

**Obsidian you can share with your team without giving up your files.**

Basalt is a downloadable, open-core team knowledge tool. Notes are plain Markdown
files in real folders on disk, linked `[[wiki-style]]`. A self-hostable sync server
keeps every teammate's vault in sync and enforces team permissions — each person
only ever *receives* the files they're allowed to read. The first screen isn't a
note: it's a **team dashboard** with real progress bars computed from checkboxes
inside your notes, and "who's working on what" derived from actual edits.

> Basalt is obsidian's structural cousin — the rock that forms interlocking
> columns. Individual columns, stronger together.

## Why Basalt

- **Your files.** Valid CommonMark + front-matter + wiki-links. A Basalt vault
  opens fine in Obsidian and vice versa. The server stores the vault as a real
  folder tree you can rsync or `git init`.
- **Your server.** One `docker compose up`. Basalt-the-company is never in your
  data path — including for AI, which uses *your* provider key from *your* server.
- **Team-real permissions.** Folder grants give teams baseline access; two tag
  overlays refine it per note: `#only/<team>` restricts, `#share/<team>` shares
  read-only. Unreadable notes never reach a client's disk (partial checkout, not
  client-side hiding), and every surface — search, graph, backlinks, tasks,
  dashboards, AI retrieval — is filtered by the same tested ACL function.
- **Tasks without a second system.** Any `- [ ]` line is a task
  (`@assignee due:2026-07-10 !p1`). Promote one to a full task object with
  status/comments when you need structure; the checkbox in the file and the
  object stay two-way bound, file wins.
- **A dashboard that can't lie.** Progress = checked/total, computed from the
  vault. Delete the database, re-index the Markdown, and the dashboard rebuilds.

## Monorepo

| Path | What |
|---|---|
| `packages/core` | Vault engine: parser, link graph, tags, tasks, **ACL** — same code on desktop, web, server |
| `packages/sync` | Yjs note docs, CRDT merge, partial-checkout manifests |
| `packages/schema` | Zod API schemas + Drizzle tables |
| `packages/ui` | Design tokens: Command Center (dark) + Paper (light) |
| `apps/server` | Fastify sync server: auth, permission gate, tasks, dashboard, AI proxy |
| `apps/web` | React + CodeMirror 6 client (dashboard, editor, palette) |
| `apps/desktop` | Tauri 2 shell (thin; needs a Rust toolchain to build) |

## Quickstart (dev)

```sh
pnpm install
pnpm --dir apps/server seed   # demo workspace: jules/erin/mara @basalt.dev, pw "basalt-demo"
pnpm --dir apps/server dev    # API on :4623
pnpm --dir apps/web dev       # web on :4625
pnpm test                     # core + sync + server suites (permission tests are release-blocking)
```

## Self-host

```sh
BASALT_JWT_SECRET=$(openssl rand -hex 32) BASALT_SECRET_KEY=$(openssl rand -hex 16) docker compose up -d
```

Your vault lives in `./data/vault` as plain Markdown.

## AI (optional, bring your own key)

A workspace owner adds an Anthropic (or OpenAI-compatible) key in Settings; it is
encrypted at rest and requests go straight from your server to the provider.
Surfaces: **ask your vault** (cited answers), **team digest**, and **suggested
links** (local scoring, no API call). Retrieval = lexical top-k ∪ link-graph
neighbors ∪ same-project notes — the link structure your team built by hand is
the retrieval signal. ACL runs *before* retrieval, always.

## Non-goals for v1

Plugin API, live cursors, public publishing, mobile apps, SSO/SCIM/audit logs
(v2 `ee/`), whiteboards/canvas, comments-on-text (task comments only).

## License

Apache-2.0. Future enterprise features will live in a clearly separated `ee/`
directory under a commercial license (GitLab model); `ee/` imports never mix
into core.
