# Basalt — codebase guide

Jules's personal knowledge tool on plain Markdown files. The original product
spec is `docs/spec.md` (its locked decisions still hold where the product kept
them; it was written for a team product, and Basalt is now single-user — "One
user, one vault").

## Start here (read this first in a new session)

- **The vault is `~/Obsidian Vault`** — the same folder Obsidian opens, not a
  copy. Basalt reads and writes those files live. `apps/server/data/` holds the
  **live database** (and `vault-old-copy/`, a pre-merge backup you can ignore):
  the index, plus everything that exists only there — accounts, credentials,
  comments, mail drafts, note history (see "Architecture"). **Never delete,
  reseed or write to it**, in any checkout; run `export` before anything that
  could. Work on a scratch copy (Dev loop).
- **The app is already running.** A launchd agent
  (`~/Library/LaunchAgents/dev.basalt.server.plist`, KeepAlive) serves the API on
  **:4623** *and* the built web bundle from `apps/web/dist`. The desktop app is a
  Tauri window that shows :4623 once it answers as Basalt. `pnpm --dir apps/web dev` (:4625) is for
  iterating; the desktop app does not see it.
- **After changing web code, run `pnpm ship`** — typecheck, tests, build, and
  restart the agent. Editing source alone changes nothing in the desktop app,
  because it serves the *built* bundle and registers static files at boot.
  Restart the agent the right way: `lsof -nP -iTCP:4623 -sTCP:LISTEN -t` (the
  bare `lsof -ti :4623` returns client sockets too — killing one of those once
  took down an unrelated app).
- **The launchd agent carries the real secrets** (`BASALT_JWT_SECRET`,
  `BASALT_SECRET_KEY`) in its plist, which is `chmod 600`. The server refuses to
  boot on the shipped placeholders, or on a secret that is empty or under 32
  characters, regardless of `NODE_ENV`; `pnpm --dir apps/server dev` opts out
  with `--dev`, which also moves it to its own data folder and port (Dev loop). Changing `BASALT_SECRET_KEY` orphans every
  stored credential (mail password, AI key, ChatGPT sign-in, webhook secrets,
  calendar feed URLs) — run `pnpm --dir apps/server rotate-secret-key` with the
  server stopped.
- **Log in as** the owner's own account (single user; the team model underneath
  still exists but has no UI — ask Jules if you need it). The seeded `jules@basalt.dev` / `basalt-demo`
  account is what `pnpm --dir apps/server seed` creates and what the tests use —
  it is NOT the account on the running database, and trying it there is a
  rejected login, not a broken server.
- **To pick up a project cold**, ask over MCP: `list_projects`, then
  `get_project <slug>` returns that project's own prompt, goals, tasks,
  decisions, documents and linked people in one call.
- Verify in the browser, not by assertion — and take a screenshot *first*: a
  hidden Claude browser pane reports every element as 0×0, which reads as a
  layout bug that is not there.

## Architecture in one paragraph

Everything is TypeScript except the thin Tauri shell. `packages/core` is the single
source of truth for parsing (front-matter, `[[links]]`, `#tags`, checkbox tasks) and
for **permissions** — desktop, web, and server all run the same code. The server
(`apps/server`) holds the vault as real `.md` files on disk plus a SQLite index; each
note is a Yjs `Y.Doc` whose update log lives in SQLite (history + merge). Clients get
a *partial checkout*: unreadable notes are filtered server-side before transport and
never reach the wire. The dashboard is a pure view over checkbox tasks in the notes —
delete the DB, re-index the Markdown, and it rebuilds: task status is the checkbox,
time blocks and events are calendar notes (`test/rebuild.test.ts` does exactly
this). **Still DB-only** — gone for good if the database is deleted, so never
"just rebuild it": accounts, teams, memberships and folder grants; sessions,
passkeys (Touch ID), invites and API tokens; the workspace's AI settings and
key, the mail account and the ChatGPT sign-in (`meta`); task comments and
descriptions, an assignee set through `PATCH /api/tasks/:id` over the line's
`@user`, the legacy `planned_date`; a project's hidden flag; retired usernames (`meta`,
`usernames.ts`: a removed or renamed account's name is never handed out again,
since `Personal/<name>/` answers to it); staged mail drafts;
webhooks and calendar feeds; and **note history** (`ydoc_updates`, the Yjs log),
the only copy of a note's text before it was overwritten. History has no screen
and no MCP tool: it is API-only (`GET /api/vault/note/:id/history?content=1`,
`…/history/:seq`, for anyone who can read the note, with a session or an API
token) — that is how text lost to a bad write is recovered today. `test/db-only.test.ts` holds this list against the
tables in `db.ts`. `pnpm --dir apps/server export`
(`src/export.ts`) writes all of it out: a restorable `basalt.db` snapshot, a
readable `export.json` with every secret left out, and a README — to
`<data dir>/exports/` by default, never into the vault. Run it with the agent's
`BASALT_VAULT_DIR` so the never-into-the-vault check knows the real vault.

## Layout

| Path | Contents |
|---|---|
| `packages/core/src/parse.ts` | Markdown → links/tags/tasks/headings. Line-based, CRLF-aware (`noteLines`/`spliceNoteLines` — every by-line read or edit goes through them); skips code fences the CommonMark way (`codeLines`, shared with sections.ts) and inline code spans; never throws on user text (fuzzed) |
| `packages/core/src/sections.ts` | `##` headings as addressable slots (`readSection`/`writeSection`/`appendToSection`) — how the project workspace stores goals, prompt, decisions, inbox |
| `packages/core/src/acl.ts` | **THE permission implementation.** `canRead`/`canEdit`/`validateEdit`/`filterReadable` + `personalOwner`. Never filter anywhere else |
| `packages/core/src/vault.ts` | `VaultIndex`: link resolution, backlinks, tag index, project progress, search |
| `packages/core/src/tasks.ts` | Text transforms: toggle checkbox, promote (`^t-xxxxxx` block id), append |
| `packages/core/src/related.ts` | "Suggested links" TF-IDF scorer (embeddings will replace scorer, same interface) |
| `packages/core/src/ontology.ts` | The vault's ontology as data: parses the `#vault-ontology` tables; `typeOfNote` |
| `packages/core/src/graph.ts` | `buildGraph`: typed facts with provenance, inverses, derived relations, warnings. Pure index; takes a `readable` filter that restricts BOTH ends of a fact |
| `packages/sync/` | Y.Doc helpers, splice diffs, `computeManifest` (partial checkout) |
| `packages/schema/` | Zod API schemas (`api.ts`) + Drizzle tables (`db.ts`) |
| `apps/server/src/vaultStore.ts` | Files-on-disk + index + Y.Doc cache + `events` EventEmitter (live sync bus) |
| `apps/server/src/routes/` | auth, vault, tasks, dashboard, home (personal aggregates for Today), admin, ai, ws, plan, calendar, projects (the project workspace, its files and board), finance (Money), mail, graph (the knowledge graph), contacts, people (each person's and company's relations and newest mention, for the People page), ics (ICS feeds in/out), integrations (API tokens + webhooks), settings (the notes folder for Settings → Notes), notesHome (Notes home's pins and counts), noticed (every graph warning by note, with what its fix needs, for Orr noticed) — one file each |
| `apps/server/src/ics.ts` | Minimal RFC 5545 parse/expand/build (RRULE subset, TZID via Intl) — no Google API |
| `apps/server/src/webhooks.ts` | Outgoing webhook dispatcher; HMAC-signed, ACL-filtered per hook owner when the event fires and again when a debounced delivery goes out (ACL-007) |
| `apps/web/src/` | React. `App.tsx` maps addresses to screens inside the shell (`ui/shell/Shell.tsx`: rail, phone tabs, More); `ui/` is the design system (components, icons, Orr, overlays, router, keys, dates, theme); `styles/<area>.css` holds the older screens' styles, one file per area. Screens: `Today` (the default place: timetable and seven modules, `today/`), `Notes` (`Notes.tsx` holds the state and every request; the pieces are in `notes/`: tree, Notes home, the note's header, the side panel; `/notes/<path>`, `/notes` opens the last note until you close it), `orrery/` (the Orrery: `model.ts`, `layout.ts`, `physics.ts`, `engine.ts`, `Orrery.tsx`), `Planning` (`Planning.tsx` holds the state and every request; the pieces are in `planning/`: `model.ts` the item vocabulary, Lanes, Hours, Month, To plan, the item popover, the phone week; addresses `/planning/week/<Monday>`, `/planning/month/<yyyy-mm>`, `/planning/day/<date>`), `Overview` (Projects: one row per project, `OverviewHead.tsx`, the area filter and the shelves in the address) → `Project.tsx` (the project page; its Overview tab is `ProjectOverview.tsx`, the other three tabs `ProjectViews.tsx`, the Gantt under the Timeline), `entity/` (the entity pages, `/people/<slug>`, `/companies/<slug>`, `/conversations/<slug>`, `/documents/<path>`: `EntityPage.tsx` and its blocks in `parts.tsx`, the pure rules in `model.ts`, where a note opens in `links.ts`, the shared lists in `known.ts`; and the pieces the project page shares: header, status vocabulary, dates as text, relations), `noticed/` (Orr noticed, `/notes/health`: warnings as sentences with one fix, `model.ts` and `fixes.tsx`), `find/` (Find, ⌘K: `model.ts` matching and groups, `build.ts` what it finds), `people/` (People, `/people`: people and companies side by side as rows — ring or square, "Role · Company", the key relation from `/api/people/context`, the newest mention — one search and one sector select in the address; `/people/<slug>` and `/companies/<slug>` are entity pages; the A–Z rail is phone-only), `Mail` (`Mail.tsx` holds the state and every request; the pieces are in `mail/`; addresses `/mail`, `/mail/<uid>`, `/mail/waiting`, the composer as `?write=…` or `?draft=<id>`), `Finance` (Money: `Finance.tsx` holds the state and requests, `money/` the pages, chart and pure helpers), `Settings` (a page, `/settings/<section>`; the eight sections are in `settings/`, each says where it lives — this device, your account or this server; Orr & AI is owners only; `settings/parts.tsx` holds the sections, the where-marks and `SETTINGS_INDEX`), the door (`Login`, `Lock`, `Setup`, `door/`: the dots, the gather, the boot), `AskPanel` (Ask Orr: the panel; its pieces in `ask/`: the Markdown reader, his working in words, where names lead, the history on this device), `QuickCapture` (Capture, a Dialog), `create/` (New: the menu, its four dialogs and what each page prefills), `ui/Icon.tsx` (line icons; no glyphs, no emoji), `ws.ts` |
| `apps/desktop/` | Tauri 2 shell: one window, no commands; opens a bundled "Basalt isn't running" page (`src-tauri/fallback/`) and moves to :4623 once `/api/health` answers as Basalt (`is_basalt`, `src/lib.rs`). Building needs a Rust toolchain |

## Permission model (memorize this)

1. Folder grants `(team, folder, role)`; nearest ancestor **with any grant** decides
   (a subfolder grant overrides and can restrict). No applicable grant → invisible.
2. `#only/<team>` restricts a note to that team (union across tags); wins over
   everything except workspace owners. It fails closed: front-matter
   `tags:`/`tag:` are read as a list or a comma/space string, a block YAML
   cannot parse is read for `only/<team>` in its raw text, and an `only/` whose
   team cannot be read restricts the note to owners (`OWNERS_ONLY`). `share/` is
   never read from a broken block. `#share/<team>` grants read-only across
   folder boundaries. Touching `#only/<team>` requires membership of `<team>`;
   no edit may make a note unreadable to its own editor (server rejects).
3. `Personal/<username>/…` is permissioned **by path**: that user + owners only;
   `#share` can extend read. Folder grants never apply there. Quick capture writes
   to `Personal/<username>/Inbox.md`.
4. Owners see everything (documented, visible — no secret superuser).
5. Every user-facing surface (tree, search, backlinks, tags, tasks, dashboard,
   manifest, WS events, AI retrieval (the vault's CLAUDE.md included:
   `vaultGuide(user)`), search ranking (its corpus statistics are the
   reader's, ACL-008)) filters through `packages/core` ACL. Adding a surface?
   Call `filterReadable`/`canRead` and add a leak test.
6. **Paths are canonicalised before they are judged.** `VaultStore.resolvePath`
   resolves and re-relativises every mutation target, so the folder the ACL rules
   on is the folder the bytes land in. Judging the raw string instead lets
   `Personal/<me>/../../X/n.md` read as the caller's own vault and land in `X`.
   `noteWriteSchema`'s no-`..` regex is a second line, not the first — `store.write`
   is also called directly (the AI `write_note` tool passes a model-supplied
   string). Never derive a folder from an unresolved path.
   The path is also spelled the way the disk spells it: `resolvePath` maps each
   segment to the entry the directory holds, exact first, then case- and
   NFC-insensitively (`apps/server/src/diskPath.ts`), so on APFS
   `shared/eng secret.md` IS `Shared/Eng Secret.md` — that note, its `#only`
   tags and its folder's grant, merged into, never replaced by a new file.
   Folder grants compare folded too (`foldPath`, acl.ts). The watcher believes a
   spelling only when the directory lists it exactly (`listedExactly`):
   `existsSync` says yes to every spelling of a file, and trusting it turned a
   case-only rename in Obsidian into an endless restamp loop (audit STO-012).

## The project workspace is the note

A row on the Projects board opens `Project.tsx`, the project page, at
`/projects/<slug>`; its tabs are addresses too (`…/timeline`, `…/documents`,
`…/todo`), and App keys the page by project, so a tab switch keeps what it
loaded. The board's links open the tab used last (`basalt-proj-view`). The
header is the entity page's (`entity/EntityHeader`): the progress ring, status
as a menu, dates as text, the days left, the area, the steps, Add a step and a ⋯
menu. **Overview** (`ProjectOverview.tsx`) is one scroll: the note in the live
editor on the left; Decisions, the Inbox, Next steps, Goals, People & companies,
Conversations, Documents and the prompt on the right. **Timeline**,
**Documents** and **To-do** live in `ProjectViews.tsx`:

- *Timeline* — one column per week, a card per dated step in the project's area
  colour, its section named under it, `#deadline` cards solid red. Dragging a
  card to another week moves `due:` (and `start:`) by whole weeks through `POST
  /api/tasks/dates`; a click opens the same `TaskCard` Planning uses. The Gantt
  (`Gantt.tsx`) opens under it, remembered per project (`basalt-proj-gantt`).
- *To-do* — steps grouped by the project note's own `##` sections. The server
  sends each task's `section` (nearest `##` above it, or the note title for a
  step in another project note), so reordering the note regroups the list.
- *Documents* — the project's files as cards on a board, in boxes, joined by
  links. Stored as **JSON Canvas** in `04-Projects/<slug>/documents.canvas`
  (`GET/PUT /api/projects/:slug/board`, rules in `apps/server/src/board.ts`):
  files only — notes stay off the board by Jules's choice; a card whose file is
  gone is dropped, a file with no card gets one below the rest; reading never
  writes; saving needs edit. Links Orr proposes carry `basaltSuggested: true`
  and draw dashed until accepted: "N suggested links" asks about one at a time
  (Link, No), and Shift-click still accepts. Boxes are JSON Canvas groups, drawn
  uncoloured (their `color` stays in the file for Obsidian): add, rename, move
  (carrying their cards), resize, delete. Labels show only for the card or line
  under the pointer.

**None of it is a database row.** Goals/Prompt/Decisions/Inbox are `##` sections of the project note (`packages/core/src/sections.ts`),
people are real `[[links]]` the picker writes into `## People`, steps are the
note's checkboxes, and `status`/`start`/`deadline` are front-matter. Delete the
DB, re-index, and the workspace comes back — same rule as the dashboard.

**One status vocabulary**: a project's `status:` is read as one of the ontology's seven
words, *planned · on track · at risk · paused · completed · archived · cancelled*
(`entity/status.ts`, `statusOf`), whatever older spelling the note holds (sleeping,
planning, done, blocked…), and the menu writes the ontology's id (`on-track`). The shelf
follows from it (`shelfOf`): paused, cancelled, completed and archived leave the board,
and every step ticked is completed. The Projects board shows three shelves, Paused,
Cancelled and **Done** (completed and archived together, newest first by the board's
`lastActivityMs`; `boardShelf`/`shelfRows` in `OverviewHead.tsx`), each at
`/projects?shelf=<id>`; that is the page only, and the ontology and the project page keep
both words. Dates are typed (`entity/dateInput.ts`, day before
month) and written when a field is left: never while typing, never a year before 1900.

A slot is a `##` heading (a closed `## Goals ##` too; a `### Goals` inside
another section is not it), and writing one replaces its body between its first
and last non-blank line and no other byte (`sections.ts`). Goals are edited as
source: `GET /api/projects/:slug` sends `goalsSource`, the section as the note
has it, and the editor saves that; `goals` is display items only and is never
written back. The people picker writes `[[<path>|<title>]]`, because a bare
`[[title]]` resolves to any note with that filename first.

Documents are the one exception to "the vault is Markdown": uploads land in
`04-Projects/<slug>/files/` as real files, so they are visible in Finder and
Obsidian and travel with a vault backup. They sit outside `VaultStore.write`
(whose `resolvePath` only accepts `.md`), so `routes/projects.ts` guards them
itself: the filename is validated as sent (a `../` anywhere is a 400, not
something `basename()` quietly flattens), reads require read on the project
note, writes require edit, and nothing scriptable is ever served inline.

A person or company in the project's panel opens their own page
(`/people/<slug>`, `/companies/<slug>`, by file name; someone the graph names but
no `#contact`/`#company` note lists opens in Notes). The ⋯ beside a row the note
links holds Remove from this project (behind a Confirm), which deletes just that
`[[link]]` line from `## People` (`DELETE /api/projects/:slug/people/:noteId`);
whoever the graph says supervises or is involved in the project shows too, with
the relation's word. Documents open in the app's
own reader (`DocViewer.tsx`) — PDFs and images through a blob URL, text inline,
`.docx` converted by mammoth and `.xlsx` by exceljs **on the server** (`GET
…/files/:name/html` and `…/files/:name/sheet`), because mammoth's browser build
never settles under our bundler and a workbook parser has no business in the web
bundle. The HTML is scrubbed of scripts and `on*` handlers before it reaches
`dangerouslySetInnerHTML`; the sheet endpoint caps at 12 sheets × 500 rows × 40
columns and returns **dense** string rows — exceljs's `row.values` is 1-based
and sparse, and `.map` skips holes, which then serialise as nulls and crash the
table. `.pptx` goes through `…/files/:name/slides`
(`apps/server/src/slides.ts`): slide text, tables, speaker notes and images as
**data, not markup** — the reader builds its own elements, and an image is sent
only when its bytes say PNG/JPEG/GIF/WebP (an SVG named `image1.png` is
dropped). The zip is read with `node:zlib` so every part inflates under
`maxOutputLength`; caps are in `SLIDE_CAPS`. Decks built from text boxes have no
title placeholder, so a first box holding one short unbulleted line is taken as
the title.

`GET /api/projects/:slug` returns the whole workspace in one call; the MCP tools
`list_projects` / `get_project` / `log_decision` hand the same payload — prompt
included — to Claude Code, which is what makes "check the Thesis project" work
from a cold session. The prompt is the user's: no agent or API token can change
it (`agentWrites.ts`).

## Projects are bound by tag, not by folder

A note joins a project through a `project/<slug>` tag in its **front matter**; an inline `#project/x` in the body binds nothing. Folder location is irrelevant: a note under `04-Projects/thesis/` with only a `thesis` tag is indexed, searchable and visible in Documents, but does not belong to the Graduation Thesis project. There is one slug grammar, `PROJECT_SLUG_RE` / `projectSlugOf` in core `vault.ts` (a letter or digit of any script, then letters, marks, digits, `_` and `-`, at most 64 — one path segment), used by registration, the board and every route; a nested tag (`project/thesis/2026`) is no project. `projects` rows in SQLite are keyed on that tag (`kind='tag'`, `key='project/thesis'`), and every surface tells projects apart by key (`projectKeyOf`, `progress` keyed by key): a name is display only, and two projects may share one. A project's note is `VaultStore.projectNote(key)`: `04-Projects/<slug>.md`, else the note the registration row is anchored to (`projects.note_id`, set to the note that registered the key) while it still carries the tag; the `projectNoteFor` ranking only anchors a row that has none or whose note is gone or untagged, and the choice is stored. It is never chosen from the notes the caller can read: a tag is free text, and that made any folder editor the owner of another team's project (audit ACL-002). Every other tagged note only joins the project. A project is named by that note's `title:`, else by the name it was registered under. `store.projects(user)` lists only projects whose note (or, for a folder project, folder) the reader can read; a registration no note carries any more is the owners'. Project progress counts checkbox tasks inside tagged notes, so tagging a checklist-heavy note changes the project's totals. The Projects board reads only existing endpoints: the steps from `/api/dashboard/<team>`, each project's note and dates from `/api/projects`, the area from `/api/vault/tree`, the people from the links between the project note and contact or company notes in `/api/vault/graph`, and the graph's warnings per project only when `/api/graph/schema` has any.

## One shared vault with Obsidian

The vault is `~/Obsidian Vault` — the *same folder* Obsidian opens, not a copy.
`BASALT_VAULT_DIR` (see `env.ts`) points the server at it; the SQLite DB stays in
`<dataDir>` because it is a cache of the files, not part of the notes. Both apps
read and write the same Markdown: Obsidian saves whole files and the chokidar
watcher re-indexes them; Basalt writes through `VaultStore.write`. Editing the
*same note* in both at once is the one thing to avoid — last writer wins on the
overlapping region. A folder linked in from elsewhere (a symlink to a synced
folder) is part of the vault: followed at boot, by the watcher and for writes,
as Obsidian follows it. A link back into the vault, or up its own tree, is only
a second name for notes that have one and is left out everywhere; a write
through one is a 400 (`linksIntoVault`, diskPath.ts). One file is one note: a
second name for a file the index holds under a name that still exists is not
indexed.

On this machine the server runs as a launchd agent
(`~/Library/LaunchAgents/dev.basalt.server.plist`, `KeepAlive`), which is where
`BASALT_VAULT_DIR` is set — changing the vault path means editing that plist and
`launchctl unload && load`, not just an export in a shell. The vault deliberately
lives outside `~/Documents`: that folder is iCloud-synced (rewriting ~600 files
would churn the sync, and evicted files download one at a time) and is a
TCC-protected location a background agent may not be allowed to read.

**First index stamps every note** — when it can do so without changing anything
else: any note without `id: n-…` front-matter gets one line, `id: n-…`, added
after its opening fence (or a new block, CRLF and BOM kept). `stampId`
(`packages/core/src/frontmatter.ts`) refuses, and the note is indexed as it is,
when the front matter does not parse, is not a mapping (prose between two `---`
rules, a bare list), carries the user's own non-text `id:`, or the file is not
UTF-8. Such a note keeps the id its path already had (the notes table at boot,
the index live), so task objects stay attached; it is not rename-safe outside
Basalt. A file that is not UTF-8 is never written at all: `write()` answers 409.
That is what keeps renames link-safe (task objects key on the note id), and it
means pointing Basalt at a fresh vault modifies every file in it once.
`scripts/merge-vaults.mjs` is the one-off that folded Basalt's old copy into the
Obsidian vault (newest-wins per file, carrying ids across).

**Nothing else is written into the vault at boot.** Basalt used to create a
`.mcp.json` (a slot for an API token, in the folder Obsidian Sync, iCloud or git
copies elsewhere) and a `CLAUDE.md` whenever they were missing. The MCP server is
registered with `claude mcp add --scope user`, which keeps the token in
`~/.claude.json` (`apps/mcp/README.md`); a vault `CLAUDE.md` is the user's own
file. `test/vault-untouched.test.ts` boots against a vault and compares every
byte.

**One id, one file.** A note copied outside Basalt (Obsidian's "Make a copy",
Finder's Duplicate, `cp`, a sync conflict copy) carries the original's id. The
file that already owns the id keeps it; the copy is given its own, stamped into
its front matter and logged (`[vault] X 1.md: carries note id …`). Live, the
owner is the file the index holds under that id, if it is still on disk with
it — otherwise the newcomer is that note renamed, and keeps the id. At boot the
notes table's path wins, then the file created first, then the older mtime,
then path order (`apps/server/src/noteIds.ts`); a path that was overwritten by
a copy gets its old id back. `VaultIndex.upsert` holds one path per id, so a
stale path can never delete the note it used to name.

## The Finance area

`Finance.tsx` (web: the screen called Money, its state and every request; the
pages in `money/`) + `routes/finance.ts` (server) + the core modules
(`statement.ts`, `spending.ts`, `subscriptions.ts`, `payslip.ts`, `savings.ts`,
`money.ts` for amounts, `recurring.ts` for charges that repeat, `ownAccounts.ts`).
Same rule as everywhere else: **nothing lives only in the database.** The
ledgers are Markdown tables in notes found by tag (`#income`, `#subscriptions`,
`#payslips`, `#spending-categories`, `#own-accounts`), and statements and
payslips are real files in `02-Areas/finance/files/`.

**Which note is a ledger.** Every finance singleton (`#subscriptions`,
`#income`, `#payslips`, `#spending-categories`, `#own-accounts`, and the
`#finance` area note) goes through `ledgerNote` in `routes/finance.ts`: only
notes the reader can edit, never one in another user's `Personal/` folder,
ranked the finance area first (`02-Areas/finance.md`, `02-Areas/finance/…`),
then the reader's own places (`01-Me/`, `Personal/<me>/`), then the note made
first, then path. "The first readable tagged note" was index order, and a save
moves its note to the end of it, so two tagged notes alternated on every write
(ACL-011). Two candidates for one ledger tag are reported (`ledgerConflicts`)
and the Finance page says which one is used.

**A ledger row is read or reported, never guessed.** `parseLedger` returns the
rows it could not read (`unreadable`: line, field, cell): an amount that is not
ONE number (`parseMoney` takes one number per cell, drops parenthesised asides,
reads a lone separator before three digits as grouping and every minus sign),
or a cadence it does not know. Cadences are `CADENCES` (a whole number of weeks
or months each; an empty cell is monthly, "bimonthly" is deliberately not
read).

**Own accounts** (`packages/core/src/ownAccounts.ts`) are Jules's money held
elsewhere — Capital.com, a savings pot. A statement row matching the
`| Account | Matches |` table is a move whatever the bank calls it: the broker
deposits arrive as *Card Payments* and counted as spending until this existed.
Out, it is never spending (even if a category rule names it too) and the
savings plan counts it as saved — `savingsDrift` adds it back onto the balance
slope, because a €500 deposit lowers the bank balance and is not lost. Back in,
it is principal until everything deposited has returned and a gain (income)
above that, tracked over the whole history. The Balance card keeps the raw
slope; that is what the account itself did.

**Every page has an address** (`money/links.ts`): `/money` is the overview
(`?month=` another month), `/money/spending` every month (`?month=` one month in
full), `/money/spending/<category>` a category with a month open below its chart
(`?month=`), `/money/spending/<category>/<shop>` or `/money/spending?merchant=`
a shop, and `/money/subscriptions`, `/income` (`?month=` the calendar),
`/savings`, `/documents`. Every chart column, every category row, every shop and
every month heading is a link or a button. Adding a surface here means adding a
link out of it.

**The savings model** (`packages/core/src/savings.ts`) is the one piece of real
analysis, and it is deliberately derived from Jules's own months rather than
from a rule of thumb: `target = surplus + Σ(typical month − good month)` over
discretionary categories, where "good" is the 25th percentile of the months on
record — a number he has already lived through, not an aspiration. Two traps it
is built around. **Money in comes from the BANK**, not from payslips: where the
statement carries balances, whatever came in is whatever went out plus the
change in balance, and payslips see only one employer (on the real file the
payslip median was about half of what the account took in each month — the
payslip version reported a deficit for an account that was visibly growing). And **committed categories are never "trimmable"** —
telling someone to spend less on a subscription this month is noise; only a
cancellation moves it.

**A statement is read in one currency and one pocket, in time order.** Rows sort
by their completed timestamp (`byTime`), not the date — exports come newest-
first as well as oldest-first, and the closing balance is the day's last
movement. The currency most rows use is the statement's; other-currency rows are
left out of every total and counted (`otherCurrency`), and a file in another
currency is left out of the merge (`statements()` in `finance.ts`). The running
balance is Revolut's per pocket, so it is read from the pocket most rows move
(Current), never from a Savings row that happens to come last. The main pocket
is `mainPocket` in `statement.ts`, and everything that reads a balance — the
Balance card, the trend behind burn and runway, the savings plan's outflow and
own-account savings — reads that pocket only. **Complete months come from
coverage, not from spending**: each export covers its first row to its last, two
exports join when they overlap, touch, or the running balance carries across the
gap (`coverageOf`), and a month is complete only when covered from its first day
to its last (`fullMonths`). A covered month with nothing spent is a €0 month;
the drift is measured per contiguous run of complete months.

`loadStatements` (reached through `statementsFor`, which applies the reader's
own-accounts list; `txnsFor` is its rows alone) and `buildRules` are shared by
all four endpoints and Today on purpose: three copies of a
de-duplication rule is three chances for two pages to disagree about what a
month cost. **One quantity, one function**: what a month cost is `costOf`
through `monthlyByCategory` (the hero, the month page, the category page and
Today all read it); the savings plan is `planSavings`; "this month against
typical" is `typicalAround` (the complete months around it, itself excluded —
the month page and Today's Money module); whether a ledger line
matches a description is `matchesTerms`; in-minus-out of the ledgers is
`netTotals`, per currency, never summed across currencies. When a month view is
filtered to a category, its "typical" must be that category's median, not the
whole month's — comparing €250 of shopping against a €1,000 all-category median
is the bug the finance tests exist to catch. Loading is asynchronous and cached
in memory: each statement file's parse is kept while its inode, size and mtime
are unchanged, and the merged result while the files and the own-accounts list
are (FIN-015). Statements are `*.csv` (comma, `;` or tab, read off the header)
and `*.xlsx` (first sheet, via exceljs); a file that gives no rows, or is in
another currency, is listed in `spending.excluded` with the reason, and the
upload answers with the same summary.

Charts are hand-drawn SVG with no chart library (`money/Chart.tsx`), drawn at
the size they are shown, every column a button whose label says its month and
amount. Spending categories take `--c1`…`--c5` in the order the
spending-categories note lists them and `--c-other` after the fifth
(`money/palette.ts`); green and red are status only. Money has no tokens and no
exceptions of its own: it is the shared system (`styles/money.css`). The pages
only arrange the server's figures: `money/model.ts` groups and orders them, and
each grouping says what it adds up to (a month's shops must sum to the server's
total, or the page shows the year's instead). "Looks recurring" adds a line
through `POST /api/finance/subscriptions`, named as the bank names it and dated
from its last charge; "It's not recurring" is remembered on the device
(`basalt-money-not-recurring`).

## The Planning tab

`Planning.tsx` + `routes/plan.ts` + `routes/calendar.ts`. The week in lanes
(life areas across seven days, the dated row above a horizon with Orr at now,
the next three weeks on the right) or in hours, one day, or the month, over task
time-blocks, events and everything else the vault has dated, and the only place
the app will fill your calendar for you.

**The grid was empty because the vault's dates were not in it.** It drew blocks
and events alone, so a week with no meetings was a blank 24-hour rectangle while
the same vault held 44 dated tasks, a thesis deadline and a subscription charge.
None of those own a time of day, so they are not grid items — they are the
**dated band** between the day heads and the hours (`GET
/api/calendar/markers`), carrying the same four sources Today's agenda
unifies: `due` (an open task's `due:`), `milestone` (a project's
`start:`/`deadline:` front-matter), `charge` and `income` (the ledgers, expanded
across the range with `chargeDates` from the note's own date — `anchor`, not the
rolled-forward `next` — so a 31st stays the 31st and a range before `next` still
shows its charges; the Finance ledger calendar uses the same function). A due chip opens the task's own `TaskCard`, so the deadline
band is a way *into* the work rather than a label on it.

**One item vocabulary** (`planning/model.ts`, `buildItems`): booked time `bk`, your event
`ev`, a subscribed calendar's occurrence `fd`, a due step `du`, a key deadline `key`, a
milestone `ms`, money `mn`, Orr's proposal `pp`, drawn the same in the lanes, the hours and
the month. A step runs in its note's life area (the tree's `category`); events in the
Calendar lane; key deadlines, milestones, money and all-day events in the dated row. Only
an overdue step is red apart from the key deadline's fill. To plan is a button that opens a
sheet in Lanes and Month and a panel beside the hours you drag from (Jules, 11 Oct). Lanes
or Hours is per device (`basalt-plan-view`).

**The hour window follows the content.** The day opens on 07:00–23:00 and
`windowFor` widens it around anything outside — a 06:30 block moves the top of
the grid, it never falls off it. The label in the hour grid's corner is the
toggle: it says which hours you are looking at, and clicking it forces the full
24h (`localStorage`, `basalt-plan-fullday`). Do not "fix" this back to a fixed
0–24 grid: two thirds of it is a picture of when nothing happens. The grid opens
half an hour above the first timed item in view, else on 08:00.

**Key deadlines are a tag, not a priority.** A task line carrying `#deadline`
(`ParsedTask.key`) is drawn as a solid `--deadline` item, first in its day, in
both Planning views, and on Today, whose Due module leads with the next one
still ahead. Priority could not carry this: the thesis marks nearly every task
`!p1`. The tag is dropped from the title and still indexed like any other.

**"Plan my week" proposes; it never writes** (`POST /api/plan/auto`). Most
urgent first — overdue, then at-risk, then by deadline and priority — into the
gaps that are actually free, 09:00–18:00 on weekdays, at most 2h a sitting and
`hoursPerDay` of task time a day *counting what is already booked*. Nothing
lands over an existing block, event or subscribed-calendar occurrence (an
occurrence is busy on every day it covers, split at midnight, including one that
began before the range), nothing lands in the past, and nothing lands after its
own deadline unless it is already overdue (every day is late by then). The
response is a proposal the client draws hatched, with Orr's head, and says in
his words (`proposalWords`) — click one to leave it out — and **booking loops
the ordinary `POST /api/tasks/blocks`**, so one path still promotes the checkbox
and writes the block, and nothing reaches the calendar the user has not looked
at first.

`buildPlan` is shared by `GET /api/plan` (the whole vault, what the tab asks
for), `GET /api/plan/:teamSlug` (kept because the permission tests pin it — a
non-member must get a 404) and the auto-scheduler, so the backlog, the estimate
on a card and the proposal can never disagree about what a task costs.

## Removed on purpose

The **Terminal** (xterm in the rail, node-pty PTY over a WebSocket, owner-only)
was deleted in Sep 2026 — unused, and a remote shell is the last thing a notes
app needs to keep exposed. `node-pty` and the `@xterm/*` packages went with it.
`git log` has the code if it is ever wanted back.

## One user, one vault

Basalt started multi-tenant and is now Jules's assistant: the rail has no Admin
tab, Planning has no team lanes or people picker, the Overview board has no
"who's on what" panel and no owner column, and the account card says "your
vault". The team machinery underneath (`teams`, `memberships`, folder grants,
the whole §5 ACL) is untouched and still enforced — the permission tests are
release-blocking regardless — it simply has no UI. Re-adding a collaborator is a
UI job, not a migration: the old grants screen (`Admin.tsx`, teams dragged onto
folders over `routes/admin.ts`) was unreachable and was removed in Oct 2026 once
its AI section had moved to Settings — `git log -- apps/web/src/Admin.tsx`.

## Reading mail

**Categories come from Gmail, not from us.** `listInbox` asks the server through
the `X-GM-RAW` IMAP extension (one indexed UID search per category, scoped to the
fetched window), so the tabs match what Gmail itself shows and never drift.
**A message can carry several category labels at once** — Revolut's newsletter
answers to both `category:primary` and `category:updates` — and Gmail displays
anything holding `primary` in Primary. So `primary` is searched too and it wins;
the others only place a message Gmail did not put in Primary. Skipping the
primary search (it looks like the redundant one) files a third of a real inbox
under Updates. Anything unclaimed is Primary; a server without `X-GM-EXT-1`, or a failed search, leaves everything
Primary and the tabs collapse to just "All". The list adds an **All** tab Gmail
does not have, and defaults to it — Gmail's tabs *hide* mail, and this inbox was
one flat list before. The window is 60 messages rather than 30 because personal
mail is a thin slice: Jules's last 60 contain zero Primary. Tabs that don't
fit go into More, measured against the strip (`mail/tabs.ts`), and the current
tab always stays in the row.

`MessageBody` prefers the **HTML** part and falls back to text — the other way
round (what it used to do) means every marketing mail renders as its plain-text
alternative, which is a wall of bracketed tracking URLs. HTML goes into an
iframe (`mail/MessageBody.tsx`, `SANDBOX`) with
`sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"`: no
scripts, but links still open in the real browser. `allow-same-origin` is
present *only* so the parent can measure the message's body and size the frame
to it — one scrollbar, no dead box — which is safe because `allow-scripts` is
absent, so nothing inside can execute and use that origin;
`MessageBody.dom.test.tsx` holds both. Measure the **body**, never the
document: a document's scrollHeight is never less than its frame, so measuring
it (plus a margin) grew the frame at every re-measure and it could never
shrink. Images load by default like any mail client; Block images (the
message's ··· menu) flips the CSP to `img-src data:` and the preference sticks
(`basalt-mail-images`). Inject as little CSS as possible: `img`/`table` get
`max-width:100%`, and nothing else — a universal `max-width` forces email tables
into a stacked mobile layout (it quadrupled one message's height). The text
fallback drops image-only lines and labels links by host, keeping the full URL
on the href.

## The agent's model

Settings → Orr & AI (owners) picks it: a key for Anthropic, Gemini or an
OpenAI-compatible endpoint (stored encrypted in `workspace`), or **ChatGPT plan**
— Sign in with ChatGPT, so a Plus or Pro plan pays instead of a key
(`apps/server/src/chatgpt.ts`, from OpenAI's documented protocol; their DevKit
is noncommercial-licensed, so none of its code is used). OpenAI offers this to
open-source and locally run apps. Its rules shape the code:

- The redirect is fixed to `http://127.0.0.1:<port>/callback`, a root route,
  so sign-in starts from a browser on this Mac; from anywhere else
  `/api/admin/ai/chatgpt/start` refuses.
- Credentials live encrypted in `meta` (`chatgpt_credentials`), apart from the
  API key, so switching back to Gemini still finds its key. Each refresh
  spends the refresh token and returns a new one: refreshes are serialised and
  saved before use.
- Every ChatGPT-plan request is streamed with `store: false` and carries no
  token cap (`callOptions`/`completeText` in `aiProvider.ts`); one-shot calls
  go through `completeText`, which keeps the other providers non-streaming.
- Tool calling is not in OpenAI's docs for this flow; the Ask agent's tools are
  sent and it is unverified until a real account signs in.

The OpenAI-compatible provider speaks Chat Completions (`createOpenAI(…).chat`), the API
every compatible server implements; only the ChatGPT plan uses the Responses API. A stored
key that no longer decrypts makes `aiConfig` return null (AI off) and logs one line, never
a 500.

Ask Orr (`AskPanel.tsx`) sends the note the page is about as `contextNoteId`
(`ask/targets.ts`) and draws each tool call as a sentence (`ask/working.ts`): a new agent
tool gets a case there, or it reads "Used <name>". Earlier questions live on the device
(`basalt-ask-history`, the open one in sessionStorage `basalt-ask-open`), slimmed to
names, ids and counts: note text, excerpts and mail bodies are never copied into the
browser.

## The agent can draft mail, never send it

The agent reads text nobody vetted — inbox messages, notes any teammate can
write — while holding the vault's contents and a live SMTP session. So the send
is gated in code, not in the prompt: `draft_email` (in-app agent) and the MCP
`draft_email` both stage a `mail_drafts` row, `POST /api/mail/send` is
session-only (see **API tokens are the weaker credential**), and the Mail view
surfaces staged drafts under "Waiting for you" (`/mail/waiting`, and a box
above the list). Opening one loads it into the normal composer; a draft that
answers a message also sits under that message, whole, recipient address
included, and its Send posts exactly the text on the card. Either way, what
goes out is what the user just read, through the same session-only send. There is
deliberately no "send this stored draft" endpoint: one send path means one place
that requires a session. Adding another outbound channel (Slack, SMS, a webhook
the agent can aim)? It gets the same treatment.

## The agent edits notes, it never rebuilds them

`search_vault` sends an excerpt of each note (2,000 characters; `truncated: true` and
`length` say so) and no hash. `read_note` gives the whole note and its hash (past 60,000
characters it comes in parts, without one). `write_note` replaces an existing note only
with that hash, sent as `baseHash`, so a note changed since is refused, and text over a
fifth shorter needs `shrink: true`; `append_to_note` and `replace_section` change a note
without resending it. MCP `edit_note` has the same rules and writes a new path
create-only. A model rebuilding a note from what it saw deleted everything it was not
shown (audit AI-001).

**Standing instructions are the user's** (`apps/server/src/agentWrites.ts`). CLAUDE.md,
CLAUDE.local.md and AGENTS.md in any folder, anything under `.claude/`, and the
`## Prompt` of a note tagged `project/<slug>` are what agents obey. The in-app agent and
API tokens may not write those files or change that section — every agent write passes
`agentWriter`, a token's `PUT /api/vault/note`, move and `PATCH /api/projects/:slug` pass
`tokenWriter` (a `guard` on `VaultStore.write`). The user edits them from a session or in
Obsidian. The vault's CLAUDE.md reaches Ask only through `canRead` (`vaultGuide(user)`), as
a marked note at the head of the first user message, never in the system prompt.

## Live sync

`VaultStore.events` emits `note-changed` on every mutation → `routes/ws.ts`
broadcasts to connected clients **after a per-recipient `canRead` check**.
Clients (`apps/web/src/ws.ts`) reconnect with backoff (2 s doubling to 30 s,
jittered); after a reconnect every view gets a `note-changed` with `resync:
true` and refetches; a 4001 close (the session ended) signs out instead of
retrying; Notes refetches the open note (the sync merges the text into what is
being typed) and reloads the tree once, 500 ms after the last event; Today
reloads debounced (the live inbox is not asked again on a note change). Presence
= `{type:"editing", noteId}` pings, rebroadcast only to users who can read that
note. Frames from a client are capped at 16 KiB (`WS_MAX_FRAME`, `main.ts`): a
client only sends its auth frame and presence pings, and the first frame is
parsed before it is known to be a valid auth.

## Conventions & gotchas

- **Every non-API response carries a Content-Security-Policy** (`CSP` in
  `main.ts`): scripts from our own origin only, so markup that slips past the
  .docx/mail scrubbers still cannot run. Adding anything loaded from another
  host (a font, a CDN script, an API called from the browser) means adding it
  there, or it is silently blocked in the built app — vite dev (:4625) sends no
  CSP, so it will look fine while iterating. The mail iframe *inherits* this
  policy, which is why `img-src`/`font-src` allow https:. So do the document
  reader's blob: PDFs — which is why `frame-ancestors` is `'self'`, not
  `'none'`: with `'none'` the desktop app (WebKit) refused to frame its own
  PDFs and every document went blank for three days while Chrome looked fine.
  **Check policy changes in WebKit**, not only Chrome: a WKWebView snapshot
  (`scripts/webkit-snap.swift`) is what found it.
- **The environment is validated at boot** (`envProblems` in `env.ts`, every
  problem listed at once): ports and the numeric knobs (`BASALT_DOC_CACHE`,
  `BASALT_PLAN_AI_TIMEOUT_MS`, `BASALT_AI_TIMEOUT_MS`,
  `BASALT_WEBHOOK_DEBOUNCE_MS`) are whole numbers, origins are bare origins,
  data/vault paths are directories, and real secrets are ≥ 32 characters. A new
  variable gets a rule there.
- **Outbound requests to user-typed URLs go through `safeFetch`** (calendar
  feeds, webhooks): http(s) only, every resolved address public (checked in the
  socket's own `lookup`, so DNS rebinding is caught), IPv6 ranges that wrap or
  reach an IPv4 address (IPv4-compatible, IPv4-translated, NAT64, 6to4, Teredo)
  refused whole, redirects re-checked hop
  by hop (GET only), and callers report a coarse outcome — never the far end's
  status or error text. A private target that is really wanted (a NAS, a tailnet
  host) is named in `BASALT_FETCH_ALLOW` (hosts or CIDRs). Anything new that
  fetches a URL a user supplied uses it too. A connection `safeFetch` cannot
  make itself (IMAP/SMTP to a user-typed mail server) checks the host with
  `assertPermittedHost` first — same rule and allow-list, checked before
  connecting rather than in the socket.
- **Untrusted input is read within a budget, off the event loop where it can't
  be bounded.** Office files go through `zip.ts`: every part inflated against
  `DOCX_CAPS`/`XLSX_CAPS` (an XML-part cap and a total) before mammoth or
  exceljs sees the bytes — the zip's declared sizes are never believed; over a
  cap is a 413, unreadable a 422. A .pptx reads each slide once and shares one
  XML budget (`SLIDE_CAPS.xmlBudget`). ICS expansion jumps to the window and
  stops at `MAX_EXPAND_STEPS` per feed (ics.ts). A payslip PDF is read in a
  worker (`pdfText.ts`, plain `.mjs`) with a page cap and a time limit: pdf.js
  parses a page in one synchronous stretch that no main-thread timer can
  interrupt. Anything new that parses a user's file or feed gets a cap, and a
  worker if its cost can't be capped.
- **The server answers only to its own names.** Every request — API, static
  files, the WebSocket upgrade — must carry a `Host` of `localhost`,
  `127.0.0.1`, `[::1]` or a host in `BASALT_PUBLIC_ORIGINS` (any port), or it
  gets a 421 before any route runs (`allowedHost`, `main.ts`). CORS cannot stop
  DNS rebinding: a page that re-points its own name at 127.0.0.1 is
  same-origin, but its browser still sends its own name as `Host`. So set
  `BASALT_PUBLIC_ORIGINS` (comma-separated, e.g.
  `http://localhost:4623,https://<mac>.<tailnet>.ts.net`) in the launchd plist
  for every name Basalt is reached by — a bare LAN or tailnet IP included.
  Touch ID trusts only those origins too; unset, the `Origin` must equal the
  address the request was sent to.
- **A task's status is its checkbox**: `[ ]` todo, `[/]` in progress, `[b]`
  blocked, `[x]` done (`ParsedTask.status`; the Obsidian Tasks convention).
  Every checkbox Obsidian draws is a task — `-`, `*`, `+`, `1.`, `1)`, and
  inside a blockquote or callout (`> - [ ]`) — through one grammar,
  `TASK_LINE_RE` in parse.ts, which the task edits share; an edit keeps the
  line's marker and quote. Every surface reads `status`, every route writes it
  with `setTaskStatus`, and `task_objects.status` only mirrors the file
  (`reconcileTaskObjects`, also run for every note at boot). The two middle
  states used to be DB-only and died with the database (audit B10);
  `migrations.ts` moved the old rows into their lines once — a `meta` row
  records it, because re-running it would overwrite a box cleared in Obsidian
  while the server was down.
- **A task is named, not pointed at.** Every task edit — `/api/tasks/check`,
  `/status`, `/dates`, `/promote`, `/schedule`, `/blocks`, the agent's and MCP's
  task tools — says which task by its `blockId`, or by its `text` (the display
  text or the raw line) with the line it was seen on as a hint. `locateTask`
  (`packages/core/src/tasks.ts`) reads the note with the index's own parser and
  returns the task or null: a block id never falls back to the line, a line
  alone names nothing (the schemas answer 400), and a text that matches no task
  or several is a 409. The note moves under a client — an Obsidian edit, a
  decision appended above — and an edit by line ticked whatever task slid into
  place. A `^t-` id copied onto a second line belongs to the first; the copy is
  a task of its own until promoting gives it its own id. Scheduling has one
  implementation, `bookTaskBlock` (routes/calendar.ts), used by `POST
  /api/tasks/blocks`, the agent's `schedule_block` and (through that route)
  MCP's. Dates have one, `applyTaskDates` (routes/tasks.ts), used by
  `/api/tasks/dates` and the agent.
- **Time blocks and events are Markdown** — one note per person per month,
  `01-Me/Calendar/2026-10.md` (`Personal/<u>/Calendar/` for a user who cannot
  edit 01-Me, or whose 01-Me another account could read — owners aside; a row in
  such a note moves out when it is next written, audit ACL-009), a table `| Date | Start | End | What | Task | id |`; a row with a
  `[[note#^t-id]]` Task is a block, one without is an event
  (`apps/server/src/calendarNotes.ts`). `task_blocks`/`events` are an index of
  them: routes edit the note through `write()`, and a `note-changed` listener
  re-reads its rows (so an Obsidian edit moves the calendar too); boot re-reads
  them all. Rows count only from a calendar folder, for the user the note's
  `calendar:` names, who must be able to edit it (and the task's note) — a
  `calendar: jules` note in a shared folder is ignored. A hand-typed row with no
  id gets a stable derived one, from the owner and the line — not the note, so
  a copied calendar note's rows are the same ids, skipped as taken, not
  doubled. Moving a row to another month drops it from the old note FIRST (the
  new note's re-read would otherwise see its id as taken).
- **DB-only task changes need edit** (`store.requireEditable`): dates, assignee
  and time blocks check edit on the task's note themselves (a block is also a
  write to your calendar note). Comments stay at read.
- **Finance files follow the folder ACL** of `02-Areas/finance/files`, like the
  notes beside them (`canReadFinanceFiles`); uploads need edit.
- **Files in the vault are replaced, never rewritten in place**
  (`writeFileAtomic`, `apps/server/src/atomicWrite.ts`): a hidden temp file in
  the same folder, fsync, rename. Anything new that writes into the vault
  (notes, uploads, boards) uses it — a bare `fs.writeFileSync` truncates first,
  and a crash in between leaves a note empty in the folder Obsidian has open.
  Because a save renames over the note, the watcher's `unlink` checks the file
  is really gone before dropping it.
- **A create never replaces.** `PUT /api/vault/note` with `create: true` answers
  409 when a note is at the path in any spelling; every New … flow sends it
  (`apps/web/src/newNote.ts`) — without it PUT is an upsert. Uploads go through
  `storeUpload` (`apps/server/src/uploads.ts`): the same bytes are that file, a
  different file with a used name becomes `name (2).ext`, and the answer names
  the file stored. A new file's name must be one every disk holds
  (`unportableName`, uploads.ts): no `" * : < > ? |`, no trailing dot or space,
  no Windows device name (CON, NUL, COM1…, with any extension). Both upload
  routes answer 400 with the reason, on every platform, as Obsidian does (Jules,
  14 Oct 2026); files already in the vault are served under their own name.
  `writeFileAtomic(…, { exclusive: true })` links instead of
  renaming, so a file that appeared since the check is not lost. Files are
  served under their own name with `contentDisposition` (same file): an ASCII
  fallback plus RFC 5987 `filename*` — a raw name above U+00FF in a header
  throws outside every handler and stops the process. A `.md` uploaded into a
  project's files is a note and is created through `store.write` like New note
  (routes/projects.ts), never stored as bytes the watcher would index past the
  ACL.
- **Never rewrite bytes that were not parsed.** `updateFrontmatter` edits only
  the lines of the keys it changes and reads its result back; if it would not
  read back as exactly the new data with the body byte-identical, the note is
  returned unchanged. Splices (`diffSplice`) are bounded on whole code points —
  Yjs turns a split surrogate pair into U+FFFD — and `updateDocContent` throws
  rather than leave a doc that reads otherwise. `mergeText` merges with every
  line terminated (Obsidian writes no final newline).
- **The agent's log rotates itself** (`rotateLogIfLarge`, `logging.ts`): past
  5 MB at boot or on the hourly check, `~/.basalt-run/server.log` moves to
  `server.log.1` (owner-only) and starts again (truncated by name after the
  inode check: Windows refuses to truncate through an append-only handle) —
  only when stdout really is
  that file. URLs in it are already redacted (no query strings or secret paths).
- **An Ask run stops with its request** (`routes/ai.ts`): the response closing early (the
  panel's Stop, closing the panel, leaving the page) aborts the run, so no later model call
  or tool call happens; `BASALT_AI_TIMEOUT_MS` (120 s) bounds it. A run stopped mid-answer errors the SDK's stream, and
  `pipeUIMessageStreamToResponse` rethrows that from a promise nobody awaits — Node ends
  the process on it — so the route pipes a stream that ends itself instead
  (`agent-abort-midstream.test.ts`). **Logged errors carry no bodies**: `errSerializer`
  (logging.ts) drops `requestBodyValues`, `responseBody`, `errors`, `lastError` and the
  like — the AI SDK's errors hold the whole prompt.
- **Fastify runs onClose hooks last-registered first.** The database's hook is
  registered before everything that uses it (main.ts), so it closes last;
  registered after them, it closed first and a pending vault watcher timer fired
  into a closed database (OPS-003).
- **A session is a row, not just a signature** (`apps/server/src/sessions.ts`).
  Every sign-in opens a `sessions` row and the JWT carries its `sid`; the
  auth hook and the live-sync socket refuse a token whose row is gone or
  revoked. Sign-out (`POST /api/auth/logout`) revokes on the server, Settings
  → Signed in revokes the others, and a revoked session's socket is closed at
  once. Anything new that issues a session token goes through `signIn` in
  `routes/auth.ts`. A token without a `sid` is refused.
- **Settings asks before anything it can't undo.** Removing, disconnecting,
  revoking, rotating or signing out goes through `Confirm` with the consequence
  in its body, and the trigger is labelled with what it does
  (`Settings.dom.test.tsx` lists each one). A new irreversible control in
  Settings gets a row there.
- **API tokens are the weaker credential.** A `bslt_` token may read and write
  what its owner can and stage mail drafts — what the MCP server does — but
  never write an agent's standing instructions (CLAUDE.md, AGENTS.md,
  `.claude/`, a project's `## Prompt`), create, change or reveal a credential,
  or decide where one is sent. A route says so in its config, `{ preHandler:
  [app.authenticate], config: sessionOnly("why") }` (`routes/auth.ts`), and
  `authenticate` refuses the token with that reason. Today: passcode, Touch ID,
  logout and sessions, revoke-all, tokens, webhooks, mail send and mail account,
  the ICS feed token, all of `/api/admin/*`. `test/token-gate.test.ts` lists
  them; a new credential route opts in and gets a row there. A password change
  and Settings → Sign out everywhere end every session, token and Touch ID
  device and clear the passcode and feed link (`revokeEverything`,
  `sessions.ts`).
- **Attempts are counted before they are checked.** Five wrong passwords from
  one address inside 15 minutes → 429 until the oldest ages out, even for the
  right password (`loginLimit.ts`, in memory). `LoginLimiter.attempt` checks and
  counts in one synchronous call BEFORE Argon2 — the old "check, await the hash,
  record the failure" let a burst sent at once all through. Sign-up has its own
  limiter and refuses a bad invite before hashing. The passcode spends an
  attempt in one `UPDATE … RETURNING` (5 then a minute's cooldown, 10 then
  password only). An unknown address is verified against a dummy hash, so
  timing does not say who has an account. Anything new that checks a secret
  counts first, then verifies.
- **The door** (`Login.tsx`, `Lock.tsx`, `Setup.tsx`, `door/`): before the
  server says yes it shows nothing of the vault, not a name, not a count; the
  halo's 520 dots are a fixed number. Once in, `door/shape.ts` asks the tree,
  projects and contacts for the gather's slices, and `useEnter` opens the app
  `HOLD_MS` (2 s, Jules's call) after the server's yes, at once with reduced
  motion. Errors go through `door/voice.ts`: the server's words are never
  shown, only its status and the wait it names. The shell's keys (App.tsx)
  stand down while signed out, so the lock's digits are only a passcode.
- **Addresses** (`apps/web/src/ui/router.ts`): every place and thing has a URL
  (structure.md §1.2), `parseRoute`/`routeHref` round-trip it, and the server
  answers any non-API path with the app, so reloads and deep links work.
  Screens still on the old `View` callbacks go through App's shim
  (`routeOfView`/`viewOfRoute`) until their wave reads the address.
- **The first frame**: `apps/web/public/boot-theme.js`, a plain script from our
  own origin (the CSP allows no inline script), puts the stored theme and
  colour-vision mode on `<html>` before anything paints; `ui/theme.ts` holds the
  same rule and a test runs the file against it. The account keeps light or
  dark; "Match this device" is a per-device key, `basalt-theme-device`. The
  rail's light ↔ dark button (`ThemeButton`, `ui/shell/Shell.tsx`) calls App's
  `changeTheme("light" | "dark")`, which also stops Match this device.
- **Storage**: read and write through `apps/web/src/storage.ts`. The browser can
  refuse storage (the getter throws), and `guardStorage()` in `main.tsx` gives
  the older direct callers an in-memory one.
- **The suite runs on macOS, Linux and Windows** (CI: Ubuntu and macOS on push,
  `windows.yml` by hand; audit OPS-003). A test that needs POSIX permission bits,
  symlinks or signal handlers says so through `test/helpers/platform.ts`
  (`POSIX_MODES`, `canSymlink`, `SIGNAL_HANDLERS`) and skips only that part;
  compare paths after `.split(path.sep).join("/")` or `path.resolve`; close
  every database handle before deleting its folder (`closeDb`,
  `test/helpers/db.ts`; `store.close()` does not close the database): the setup
  file `test/helpers/open-databases.ts` fails a server test file that leaves one
  open, on every platform. A volume's behaviour (case folding, ſ) is probed in a
  temp folder, never assumed from the platform; `import()` takes a
  `pathToFileURL(...)`, never a bare path. Package scripts never set
  variables as `VAR=1 cmd` (cmd.exe cannot); `.gitattributes` keeps every
  checkout LF.
- **Web tests**: `*.test.ts(x)` run in Node; `*.dom.test.ts(x)` run in happy-dom
  with Testing Library (`src/test/dom-setup.ts`). `src/test/app-harness.tsx`
  mounts the whole App with its screens stubbed, for shell, address, key and
  overlay tests. happy-dom follows a link clicked through a child element even
  when the click was prevented (a browser does not): in a DOM test, click the
  link itself.
- **Typing is never lost** (`apps/web/src/noteSync.ts`, `packages/sync/src/client.ts`):
  every editor saves through a NoteSync from `openNoteSync`. A failed save keeps its reason
  and retries on its own (2 s doubling to 30 s) unless the server refused it
  (403/409/413); `retire()` of a sync whose save is failing keeps it alive and retrying,
  and opening the note again picks that sync up; the unsaved buffer is mirrored to
  `basalt-draft:<noteId>` and offered back (three-way merged) when the note opens;
  `installLeaveGuard` (main.tsx) sends pending saves with `keepalive` on reload or close
  and asks first only when a save is already failing. A sync follows the note's path from
  the server's answers (a rename outside Basalt) and stops saving when the note is gone.
  Never save a note any other way.
- **A failed write is never silent** (`apps/web/src/ui/writes.ts`, audit WEB-010): a
  one-click write goes through `attempt(what, run)` (a toast with the reason, and Retry when
  the server didn't answer), a form through `useWrite()` (the reason beside it, busy always
  ends, nothing typed is cleared), and a Confirm's `onConfirm` may return the write's promise
  (the dialog waits and says why it failed). `api()` remembers failed writes and
  `installWriteNet` (main.tsx) says any nobody caught. ESLint's `basalt/async-handler-catches`
  refuses an async `on…=` handler that awaits outside a try/catch. The message is the page's,
  never Orr's: what didn't happen, then why ("The step wasn't ticked. The server didn't answer.").
- **A pin is front matter**: `pinned: true` in the note, written through
  `updateFrontmatter` and the note's sync; `GET /api/notes/overview` lists the readable
  pinned notes.
- **A contact's sector is written by the server** (`PATCH /api/contacts/:id`, core's
  `updateFrontmatter`), never by text surgery in the browser (audit WEB-022): a regex edit
  hit body lines beginning `sector:` and, in a note without front matter, a `---` rule in
  the body. Front matter that does not parse is a 409.

- Team **slugs** (not ids) are the `TeamId` in core ACL and what `#only/#share` match.
- Note ids live in front-matter (`id: n-…`), assigned on first index; renames are
  metadata ops so links never break. `VaultStore.write` preserves the existing id.
- A link resolves among the notes the reader can read (`resolveLink(…, among)`;
  backlinks and graph edges too): one whose only target is unreadable is the
  author's text alone, exactly like a link to nothing — `locked` is always false
  — and an unreadable note with a stronger key never captures a link meant for a
  readable one (§5.4, audit ACL-005). A save, create or move aimed at a note the
  caller cannot read is answered as one aimed at an empty path, before any hash
  is compared.
- Saves send the full text with the base it was edited from (`baseContent` +
  `baseHash`); the server 3-way merges it against the note as it is now
  (`mergeText`, `packages/sync/src/merge.ts`) and applies the result to the live
  Y.Doc as a splice (`VaultStore.write`). No client exchanges Y updates.
- **History** (`GET /api/vault/note/:id/history`, `apps/server/src/history.ts`)
  replays the Yjs log ONCE per request and pages newest first (`?limit=`,
  `?before=<seq>`, `?content=1` for text); one revision is
  `…/history/:seq`, which must belong to that note — seqs are global, so
  looking one up by id alone would serve another note's text. The log is
  compacted at boot and daily: updates older than a day merge per hour, older
  than 30 days per day, with `Y.mergeUpdates` over contiguous runs, so the note
  and every kept revision's text are unchanged (on the live DB in Sep 2026:
  417 rows → 161).
- DB bootstraps from plain SQL in `apps/server/src/db.ts` (no drizzle-kit). Keep the
  Drizzle table defs in `packages/schema/src/db.ts` in lockstep with it —
  `test/schema.test.ts` fails on any column or table only one side has. A schema
  change bumps `SCHEMA_VERSION` (stored in `PRAGMA user_version`); a database
  stamped by a newer build refuses to open.
- **What the server sends is typed once**: `packages/schema/src/responses.ts`
  has a schema per GET endpoint the web app reads (strict objects — every
  field listed), the web app's types are inferred from it, and
  `apps/server/test/contract.test.ts` calls each endpoint on a fixture-rich
  server (`contract-fixtures.ts`) and parses the answer. A new endpoint the web
  reads needs a schema and a `CASES` row, or the test that scans
  `apps/web/src` for GETs fails; one no fixture can answer (live IMAP, a
  ChatGPT account) goes in `SKIPPED` with the reason. Changing what a route
  returns means changing its schema in the same commit.
- Task objects are keyed `(noteId, blockId)`; file wins on conflict; deleted lines
  orphan the object (surfaced on the dashboard, never auto-deleted).

## Design rules

**Orrama's design language** (October 2026, replacing the flat violet one; the
boards in `~/orrama-redesign/mockups` are the reference). Warm paper by day, night
blue after dark: `:root`/`[data-theme="light"]` and `[data-theme="dark"]`
(accounts store dark as `command`, read as an alias). Content sits in white boxes
(`--surface`, `--card-line`, `--shadow-card`) on the deeper `--ground`; only what
floats (menus, the palette, sheets, a dragged block) takes `--shadow-pop` over
`--scrim`. One accent, Morpho ultramarine `--accent`, for links, focus and
selection only. Orr's orange (`--orr-*`) is the main button (his gradient, dark
text), progress, and the current rail item and tab; "now" is `--sun`. Five
category colours, `--c1`…`--c5` (work, personal, school, tools, knowledge), in
that order and never cycled. Status is `--ok`/`--warn`/`--late`, always with a
word and never a category, and a red fill is the key deadline's alone
(`--deadline`). Colour-vision profiles (`vision.css`) override the five and the
status trio. Type is Figtree (`--font`), served from `packages/ui` with no font
host, with tabular figures for times and money; the system mono (`--mono`) is for
code in notes only. Three radii (`--r-1` 6, `--r-2` 8, `--r-3` 12), spacing
`--s-1`…`--s-7`. **Token-first**: everything reads `var(--…)` from
`packages/ui/src/tokens.css`; retint there, never in components. The legacy names
at its end alias the old ones for screens not yet redrawn: delete each once
nothing reads it.

**Build from the system** in `apps/web/src/ui` (styles in `ui/ui.css`; every
piece is on `/dev/ui` in the dev server): Button, Tabs, Segmented, Chip,
DeadlineChip, Status, Checkbox, Ring/Square/ProgressRing, Bar, PageHeader, Crumbs,
Module, Card, Row/RowList, Field and its controls, EmptyState, Notice, Skeleton,
Progress, and the overlays. Icons are `ui/Icon` (70 line icons on a 20-unit grid,
in currentColor): no glyphs (✕ × ‹ ›) and no emoji. Orr is `<Orr pose size>` (16
poses; below 48 px he is Hello, below 20 px the head mark), your Orr is
`<Avatar>`, the logo's O is `<HeadMark>`; Orr never appears in an error. A
screen's own styles go in its area's file, `styles/<area>.css`, never in a shared
one. **One page width.** `.main > *` in `styles/shell.css` caps every page at
`--page-max` (`--page-content` 1,440 px between two `--page-gutter`s of 40 px) and
centres it beside the rail. A page pads by `var(--page-gutter)` and never sets its
own `max-width`. Reading columns keep their own measure inside it (a note 720,
Settings' section 820, a mail 760).

**One of each pattern.** Overlays go through one stack (`ui/overlays.tsx`):
palette over dialog over sheet over panel, popovers above; one of a kind at a
time; Escape closes the top one only; a modal layer takes focus, keeps Tab inside
and gives focus back; a panel sits beside the page and leaves it in use. Never
`window.prompt`, `alert` or `confirm`: use `Confirm`, `Dialog` or `NameDialog`.
A failed change is said with `ui/writes.ts`, never `console.error` or nothing.
Dates and times come from `ui/dates.ts` ("Fri 9 Oct", "Thu 8 Oct, 10:01",
24-hour), never `toLocale*` or a sliced ISO date. Every place and thing has an
address (`ui/router.ts`): go there with a link or `navigate()`, not with state.
Keys are decided in `ui/keys.ts`; no keycaps on screen (the ? sheet and tooltips
list them).

**Why a Basalt graph looks sparser than the same vault in Obsidian**: Obsidian's
graph draws *tags* as nodes by default (and attachments, and ghost nodes for
unresolved links). On Jules's vault the note→note links number ~198 while a tag
layer adds ~319 edges — most of the density is tags, not links. Links themselves are parsed from `[[wiki]]` *and* markdown
`[text](note.md)` form, and resolve by title, alias, filename, or vault path
(with or without `.md`, `%20`-decoded). A markdown link is tried relative to
its own note first (`[up](../Up.md)`, Obsidian's "Relative path to file";
`VaultIndex.resolveLinkOf`), a wiki link never is; keys fold case and Unicode
normalisation (NFC), so `[[Résumé]]` finds a name macOS stored decomposed.
When notes share a key, the strongest
kind wins — path, then filename, then title, then alias — and within one kind
the greatest path; which note was indexed last never matters (a copy's
`title:` used to take over links to its original).

**The Orrery** (`apps/web/src/orrery/`, `/orrery`, rail 4) is the vault's map: Orr's head
in the middle, every readable file around him. **Kind** puts files in rings by kind
(projects, then people and companies, then notes and conversations, reviews and templates on
the rim) and slices by life area, a slice growing by count^0.8; **Steps**
(`?center=<slug>`) puts one thing in the middle with everything one step away grouped by
relation and, beyond, what several of those share. `model.ts` builds it from
`/api/vault/graph`, `/api/vault/tree`, `/api/projects` and `/api/graph/schema`: a project is
a note the Projects board lists, a person a `#contact` note, a company a `#company` note (as
People shows them), a conversation a saved chat, and weekly reviews and templates are told
by folder, tag or name and hidden until the panel's switch. A topic is where notes gather: a
project's notes, else the first folder below the top one; a conversation sits with what its
`about` names. Inside its slice and ring each file is part of a live web (`physics.ts`: link
springs, short-range repulsion, soft walls, a faint pull home; a link to another ring pulls
along it), settled off screen before it is shown and cached per data fingerprint; a drag
reheats only the neighbourhood. Only the strongest ~1,200 links are drawn (typed relations
count more); a file's own links appear when you point at it or click it, typed solid, plain
links dashed. Nothing decorative moves (no Orbit, no breathing), dragged files are not
remembered, and with reduced motion every change is instant. **The engine is one object
the page calls** (`engine.ts`), never a closure a render captured: a frame never sizes the
canvas, reads CSS (colours are re-read when `data-theme`/`data-vision` change) or reads
layout (the page hands in its controls' boxes), and links go out in two strokes, dots in a
few batched fills — `engine.dom.test.ts` counts it (WEB-016, WEB-008). The address is the
level (`?area=`, `&topic=`, `?center=`); Esc, Back and Orr step out one level. Measured in
WebKit at 10,000 files: ~3 ms a frame while dragging.

**Saved conversations are their own kind of note.** A note with front matter
`type: claude-session` (or `type: conversation`) is a transcript: it is indexed,
searchable, linkable and readable by the agent and MCP like any note, but its
text adds no links, tags or tasks (`ParsedNote.kind`, `packages/core/src/parse.ts`)
— transcripts quote file paths, spreadsheet errors and colours, and once made
up 87% of the vault and almost all of its unresolved links and junk tags. The
Orrery shows them as open circles in the topic of what they are `about`. A note
whose title is only an id (`title: 394a1725`, a session's hex file name, the note's
own `n-…`) is named by `displayTitle` (`packages/core/src/describe.ts`): its kind,
date and gist, "Conversation, 4 Jun 2026: Tidying the reading list…".
`VaultIndex.upsert` applies it, so every surface gets the name; `writtenTitle` keeps
the title as written, for link keys and search only. Never show `writtenTitle`, and
never write the name back into a note.

**Life-areas (School / Work / Knowledge / Claude & tools / Personal) are vault
data.** A note tagged `#vault-categories` holds `| Category | Matches |` rows —
phrases or `/regex/` against a note's path and tags, first row wins; a `/regex/`
runs in `safeRegex.ts` (a Thompson NFA, time linear in the text — never a native
RegExp, which one backtracking pattern turned into a frozen server), so
backreferences and lookaround are refused, and a rule set's regexes share an
instruction budget and read a note's first 512 characters
(`packages/core/src/vaultCategories.ts`). The server applies the rules the
caller can read and sends `category` on every `/api/vault/tree` note; the web
only colours and counts. Without the note, only the PARA folders are known.

**The vault is also a knowledge graph**, defined by the vault itself: a note
tagged `#vault-ontology` holds Types / Relations / Statuses / Rules tables
(`packages/core/src/ontology.ts`; without it nothing is typed). `buildGraph`
(`graph.ts`) reads typed facts off the notes every time — front matter, `key::
value` fields, the `## People` section and `project/<key>` tags — with
provenance, inverses, derived relations and constraint warnings; nothing is
stored, so deleting the DB loses nothing. A project's note is the conventional
`04-Projects/<slug>.md`. The ACL applies to BOTH ends of a fact: a relation to a
note the reader cannot see does not exist for them. `GET /api/graph/{schema,
entities,relations,path,summaries}` (`routes/graph.ts`) and five tools of the
same names on the MCP server and the in-app agent (`vault_schema`,
`find_entities`, `get_relations`, `find_path`, `list_summaries`) answer from it;
their descriptions tell a model to query first and read last. Jules's live vault
has no ontology note yet: the note and the backfill (`~/basalt-kg`) wait for
Jules's go.

**Entity pages, Orr noticed and Find read the graph and degrade without it.** An entity page
(`entity/EntityPage.tsx`) lists relations in words both ways, each note once under its
strongest word (`relationGroups`), "works with" from shared projects, and "How you know
them" from `find_path` starting at your own person note (the one with your address, else
your name), only for a 2–4 step path. What a note is follows the app's pages first
(`entity/links.ts`: a `#contact` is a person, a `#company` a company, a board project a
project, a saved chat a conversation) and the ontology's `document` after, so an untyped
vault still opens people at their pages; without typed relations a page shows "mentioned in"
and "links to" and draws no empty box. Orr noticed (`GET /api/graph/warnings`,
`noticed/model.ts`) says each problem once with one fix and writes nothing until it is
clicked; a fix with no safe server write opens the note. Find ranks the group with the best
match first, puts notes a step below a person, company or project matched as well, and a
company found by name brings its people and projects; notes still come from
`/api/vault/search`, so its `tag:`/`path:` filters work.

**Today** (`Today.tsx`, the default place, `/today`; its pieces in `apps/web/src/today/`) is
the timetable and seven modules (structure.md §2.1). The timetable's window is 08–20, widened
to whole hours around the day and around now; Orr stands on the present minute and his pose
follows the day (`today/day.ts` `poseAt`: Jump once for a key deadline met or a project
finished, Hello during an event, Point within 15 minutes of one, Read in a booked block, Wave
before the first item, Doze after the last, Sit in a free hour or an empty day). The modules,
in order: Due (the next key deadline, Today = due or booked today, Late least late first),
Mail (unread Primary and Orr's drafts), People today (a whole name in today's events or a
contact's address on today's unread mail: never a first name alone), Coming up (three weeks
of events, key deadlines, project dates), Projects, Money (this month against a typical
month), Orr noticed (the first problem Orr noticed lists, said as the page says it). Every request is in `Today.tsx` so the contract test
sees it; the rules are pure in `today/model.ts`. Nothing is invented: without an ontology
note there are no relation lines and Orr noticed says so. Customise hides modules per device
(`basalt-today-hidden`). A task row's checkbox and its link sit side by side, never nested.
The timetable's blocks (`/api/home`'s agenda, and "Booked") are the blocks in the
requester's own calendar notes (`calendar:` names them), on tasks they can read — not tasks
assigned to them.

The editor is live-preview (`livePreview.ts`), aimed at Obsidian's reading feel:
frontmatter collapses to a properties row, checkboxes/tags/links/metadata render
as widgets and chips, tables render as tables, `---` as a rule, fenced code as a
slab, and the active line always shows raw source. Bold, italic and code hide
their marks and a list's dash is a bullet; a due date reads as words
(`dueWords`: "today", "3 days late") and a done task is never late. The
line-level rules are pure functions (`wikiLinks`, `inlineMarks`, `dueWords`)
with tests; a cmd-click hands over the link's target, and Notes resolves it with
the server's own resolution first (`notes/links.ts`). **Block decorations must
come from a StateField, never a ViewPlugin** — CodeMirror throws otherwise,
which is why `frontmatterCollapse` and `blockPreview` are fields while the
per-line pass is a plugin. Esc (or the close button in the note header) closes
the note.

## Releases

`main` is what is running: after every `pnpm ship` from `sep-2026-redesign`,
fast-forward it (`git push origin sep-2026-redesign:main`). A release is a tag
on a shipped commit, with an entry in `CHANGELOG.md`:

1. Move the `## [Unreleased]` notes under `## [X.Y.Z] — YYYY-MM-DD`, leave an
   empty `[Unreleased]` above, and add the compare/tag links at the bottom.
2. Bump the version in all thirteen places — every `package.json`,
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`
   and its `Cargo.lock` (`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`
   rewrites it), and the MCP server's handshake in `apps/mcp/src/index.ts`.
   `test/release.test.ts` fails until they agree and the changelog has the entry.
3. Commit, `pnpm ship`, then `git tag -a vX.Y.Z -m "Basalt X.Y.Z"` and push the
   tag and `main`.

Note anything users must do (a schema bump, signing in again) under
"Upgrading" in that version's entry.

**Dependencies are audited**: `pnpm audit --prod --audit-level=high` must pass
(CI blocks on it); an advisory judged unreachable goes into
`auditConfig.ignoreGhsas` in pnpm-workspace.yaml with its reason, and comes out
when the package is bumped past the fix. Pick a fixing release at least a week
old when one exists (`--config.minimum-release-age`).

## Dev loop

On this machine `apps/server/data` and :4623 are the live instance (Start here).
Nothing in the dev loop touches either: `dev` and `seed` run with `--dev`
(`env.ts`), which defaults the data folder to `apps/server/data-dev` and the port
to 4627, and `seed` refuses a vault that already holds a note.

```sh
pnpm install
pnpm --dir apps/server seed   # demo into apps/server/data-dev: jules/erin/mara @basalt.dev, pw basalt-demo
pnpm --dir apps/server dev    # :4627, apps/server/data-dev — never the live DB
BASALT_API_PORT=4627 pnpm --dir apps/web dev   # :4625, proxies /api (ws included) to the dev server
# /dev/ui on :4625 shows every component of the design system (dev server only)
pnpm test                     # every package, in temp folders — permission tests are release-blocking
```

To start the demo over, delete `apps/server/data-dev` (only that) and seed again.
For a throwaway elsewhere, set both folders and a port:
`BASALT_DATA_DIR=$(mktemp -d) BASALT_VAULT_DIR=… PORT=… pnpm --dir apps/server dev`.
Never export the agent's `BASALT_VAULT_DIR` in a shell you run `seed` or `dev`
from. `pnpm --dir apps/web dev` without `BASALT_API_PORT` proxies to the live
agent on :4623 — the real vault, so what you click writes to it.

Ports 4623/4625/4627 are deliberate (4620/4621 are taken on this machine). When testing
the web UI programmatically: React controlled inputs need native-setter + `input`
event dispatch, and forms need `requestSubmit()`.
