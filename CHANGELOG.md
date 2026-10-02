# Changelog

What changed in each release of Basalt, newest first. The commit messages carry
the detail — the why, how it was verified, what was left out; this file is the
map. Releases are git tags (`v0.1.0`) on the commit that was shipped; how to cut
one is in CLAUDE.md, "Releases".

## [Unreleased]

### Added

- `pnpm --dir apps/server export`: everything that lives only in the database
  — accounts, team grants, task descriptions and comments, project settings,
  mail drafts, AI settings, tokens, webhooks, feeds, history — as a restorable
  snapshot plus a readable JSON with every secret left out.
- Settings → AI: **ChatGPT plan** — Sign in with ChatGPT, so a Plus or Pro plan
  runs the agent instead of an API key (from a browser on the Mac that runs
  Basalt). Your other provider's key stays stored for switching back.

### Fixed

- A request the server cannot read — malformed or empty JSON, an unsupported
  content type, an upload over the size limit — is answered with its 400, 413
  or 415 and Fastify's reason, not `500 internal error`, and no longer logged
  as a server crash.
- A note created together with its new folder is indexed. chokidar reads a
  new folder before it watches it, and on Linux (the Docker image) a note
  landing in between was missed until something else in that folder changed —
  10 of 10 in a probe. The server now looks at each new folder again a second
  later. macOS was not affected in practice.
- Tags in any alphabet: `#réunion` was filed as `r` and `#été` as no tag at
  all. Front-matter tags now follow the same rules as inline ones (a tag with a
  space or a dot in it is dropped), except an `only/…` tag, which stays so the
  note stays restricted.
- The note map works from the keyboard: Tab to it, arrow keys move between
  notes (shown and read out like a hover), Enter opens, + and − zoom, Esc
  lets go.
- Copies of a note in one folder are told apart in the file tree: a copy
  made outside Basalt keeps the original's title, so rows sharing a title
  also show their filename.
- A copied calendar note no longer doubles the events typed into it by hand.
- Note titles in the file tree sit on the left, next to their dot, instead of
  floating mid-row.
- A note Basalt has just created and that is deleted outside it a moment
  later leaves the list, instead of staying there until a restart.

## [0.1.0] — 2026-10-01

The first tagged release: 120 commits from 3 July to 1 October 2026, running
daily as Jules's assistant on `~/Obsidian Vault`. Everything below is in it.

### The app

- **Notes on plain Markdown, shared live with Obsidian.** The vault folder is
  the store; a watcher takes in outside edits, and Basalt's own saves merge
  with them instead of overwriting (Yjs history per note). Live-preview editor,
  backlinks, tags, ranked accent-insensitive search, and a d3-force map sized
  by degree with a local view.
- **Dashboard** of deadlines, the week ahead, projects and last month's money.
- **Planning**: a week/month calendar of time blocks, events, dated tasks,
  milestones and charges; "Plan my week" proposes blocks it never writes
  itself. Blocks and events live in monthly calendar notes
  (`01-Me/Calendar/YYYY-MM.md`), and a task's status is its checkbox
  (`[ ]`, `[/]`, `[b]`, `[x]`).
- **Projects** bound by `project/<slug>` tags: one page per project with an
  Overview, a week-column Timeline, a Documents board (JSON Canvas) and a to-do
  grouped by the note's sections. A document reader for PDF, images, .docx,
  .xlsx and .pptx.
- **Contacts**: people and companies side by side, from `#contact` notes.
- **Mail**: a Gmail inbox over IMAP with an app password; the agent can draft
  mail but never send it.
- **Finance**: Revolut statements, payslips, subscriptions, income and an
  own-accounts list read from the vault; spending by category and merchant,
  typical months, refunds netted against their purchase, a savings plan
  drawn from your own months.
- **Ask**: an agent over the vault with your own provider key (Anthropic,
  Gemini or OpenAI-compatible), set under Settings → AI.
- **MCP server** so Claude Code can read projects, log decisions and draft mail.
- **Integrations**: ICS feeds in and out, personal API tokens, signed webhooks.
- **Runs as** a launchd agent on macOS (`pnpm ship`), a Docker image, or the
  Tauri desktop window; installable on a phone.

### Since the September 2026 engineering audit

- **Data safety.** Malformed front matter is never rewritten; YAML comments
  survive a rewrite; vault writes are atomic (temp file, fsync, rename); an edit
  the watcher has not delivered yet is merged, not erased; nothing in the vault
  can stop the server booting; a note copied outside Basalt gets its own id
  instead of taking over the original's; deleting the database and
  re-indexing brings back task status, time blocks and events.
- **Security.** The server refuses to boot on the shipped secrets; CORS is
  closed; a Content-Security-Policy on every page; sign-in throttled; sessions
  are rows that sign-out and Settings can end; no tokens or search terms in the
  request log, which is owner-only and rotates at 5 MB; Finance follows the
  folder ACL; task, date and block changes need edit; a front-matter tag cannot
  become a filesystem path; calendar feeds and webhooks cannot reach the
  server's own network; SMTP never logs in without TLS; .docx HTML is rebuilt
  from an allowlist; Touch ID trusts only known origins; four real people
  removed from the repository.
- **Correctness.** One money parser (thousands separators no longer read
  1,000× too small), one `typicalMonth()`, one local-date module; the RRULE
  expander, the savings model, refund netting, subscription anchors and
  statement ordering corrected; first-run registration makes exactly one owner.
- **Operations.** CI on every push (Ubuntu and macOS); a schema version stamp
  and a test that the two schema definitions agree; environment validated at
  boot; graceful SIGTERM; the boot waits for the vault watcher; a bounded Y.Doc
  cache and a compacted, paginated history.

### Upgrading to 0.1.0

- The database moves to **schema 2** (a `sessions` table). Older builds refuse
  a schema-2 database: going back means restoring a backup taken before.
- **Every device signs in once** after the upgrade: tokens from before sessions
  existed are refused.
- AI settings moved from the old Admin screen, which is gone, to
  **Settings → AI**.

[Unreleased]: https://github.com/JewelsArt/Basalt-backup/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JewelsArt/Basalt-backup/releases/tag/v0.1.0
