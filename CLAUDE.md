# Basalt — codebase guide

Jules's personal knowledge tool on plain Markdown files. Product spec (locked
decisions, do not re-litigate): `~/basalt-prompt.md`.

## Start here (read this first in a new session)

- **The vault is `~/Obsidian Vault`** — the same folder Obsidian opens, not a
  copy. Basalt reads and writes those files live. `apps/server/data/` holds only
  the SQLite index (and `vault-old-copy/`, a pre-merge backup you can ignore).
- **The app is already running.** A launchd agent
  (`~/Library/LaunchAgents/dev.basalt.server.plist`, KeepAlive) serves the API on
  **:4623** *and* the built web bundle from `apps/web/dist`. The desktop app is a
  Tauri window pointed at :4623. `pnpm --dir apps/web dev` (:4625) is for
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
  with `BASALT_ALLOW_DEV_SECRETS=1`. Changing `BASALT_SECRET_KEY` orphans every
  stored credential (mail password, AI key, ChatGPT sign-in, webhook secrets,
  calendar feed URLs) — run `pnpm --dir apps/server rotate-secret-key` with the
  server stopped.
- **Log in as** `you@example.com` (single user; the team model underneath
  still exists but has no UI). The seeded `jules@basalt.dev` / `basalt-demo`
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
this). Still DB-only: task comments and descriptions, an assignee set through
`PATCH /api/tasks/:id` over the line's `@user`, the legacy `planned_date`, a
project's hidden flag, and accounts/settings. `pnpm --dir apps/server export`
(`src/export.ts`) writes all of it out: a restorable `basalt.db` snapshot, a
readable `export.json` with every secret left out, and a README — to
`<data dir>/exports/` by default, never into the vault. Run it with the agent's
`BASALT_VAULT_DIR` so the never-into-the-vault check knows the real vault.

## Layout

| Path | Contents |
|---|---|
| `packages/core/src/parse.ts` | Markdown → links/tags/tasks/headings. Line-based; skips code fences |
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
| `apps/server/src/routes/` | auth, vault, tasks, dashboard, home (personal aggregates for the Dashboard), admin, ai, ws, plan, calendar, contacts, ics (ICS feeds in/out), integrations (API tokens + webhooks), settings (the notes folder for Settings → Notes) — one file each |
| `apps/server/src/ics.ts` | Minimal RFC 5545 parse/expand/build (RRULE subset, TZID via Intl) — no Google API |
| `apps/server/src/webhooks.ts` | Outgoing webhook dispatcher; HMAC-signed, ACL-filtered per hook owner |
| `apps/web/src/` | React. `App.tsx` maps addresses to screens inside the shell (`ui/shell/Shell.tsx`: rail, phone tabs, More); `ui/` is the design system (components, icons, Orr, overlays, router, keys, dates, theme); `styles/<area>.css` holds the older screens' styles, one file per area. Screens: `Dashboard` (default tab, `/api/home`), `Architecture` (scoped files + `Editor`), `orrery/` (the Orrery: `model.ts`, `layout.ts`, `physics.ts`, `engine.ts`, `Orrery.tsx`), `Planning` (week/month calendar: dated band + grid time-blocks, events, ICS overlay, auto-schedule; `/api/plan`, `/api/calendar/markers`), `Overview` (project board by life-area, `Gantt.tsx`) → `Project.tsx` (per-project workspace), `Contacts` (split view: people list left, `Companies.tsx` right — A–Z card wall with a phone-style letter rail; one search + sector filter drives both halves), `Mail` (`Mail.tsx` holds the state and every request; the pieces are in `mail/`; addresses `/mail`, `/mail/<uid>`, `/mail/waiting`, the composer as `?write=…` or `?draft=<id>`), `Settings` (a page, `/settings/<section>`; the eight sections are in `settings/`, each says where it lives — this device, your account or this server; Orr & AI is owners only; `settings/parts.tsx` holds the sections, the where-marks and `SETTINGS_INDEX`), the door (`Login`, `Lock`, `Setup`, `door/`: the dots, the gather, the boot), `AskPanel`, `ui/Icon.tsx` (line icons; no glyphs, no emoji), `ws.ts` |
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

Clicking a project on the Overview board opens `Project.tsx`: header (status,
start→deadline countdown, % ring), then four tabs (last one used is remembered,
`basalt-proj-view`). **Overview** — goals, the project note in the live editor,
notes, documents list, linked people, the agent prompt, a decision log and a
quick-capture inbox. **Timeline**, **Documents** and **To-do** live in
`ProjectViews.tsx` (from the Sep 2026 mock Jules approved):

- *Timeline* — one column per week, a card per dated step coloured by its
  section, `#deadline` cards solid red. Dragging a card to another week moves
  `due:` (and `start:`) by whole weeks through `POST /api/tasks/dates`; a click
  opens the same `TaskCard` Planning uses. (The Overview board keeps `Gantt.tsx`.)
- *To-do* — steps grouped by the project note's own `##` sections. The server
  sends each task's `section` (nearest `##` above it, or the note title for a
  step in another project note), so reordering the note regroups the list.
- *Documents* — the project's files as cards on a board, in boxes, joined by
  links. Stored as **JSON Canvas** in `04-Projects/<slug>/documents.canvas`
  (`GET/PUT /api/projects/:slug/board`, rules in `apps/server/src/board.ts`):
  files only — notes stay off the board by Jules's choice; a card whose file is
  gone is dropped, a file with no card gets one below the rest; reading never
  writes; saving needs edit. Links Claude proposes carry `basaltSuggested: true`
  and draw dashed until accepted (Shift-click, or "Accept N suggested"). Boxes
  are JSON Canvas groups: add, rename, move (carrying their cards), resize,
  delete. Labels show only for the card or line under the pointer.

**None of it is a database row.** Goals/Prompt/Decisions/Inbox are `##` sections of the project note (`packages/core/src/sections.ts`),
people are real `[[links]]` the picker writes into `## People`, steps are the
note's checkboxes, and `status`/`start`/`deadline` are front-matter. Delete the
DB, re-index, and the workspace comes back — same rule as the dashboard.

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

People and companies open in place: clicking one in the project's panel shows the
same card the Contacts page shows (`cards.tsx`, shared by both), with a back
button to where you came from and a Remove that deletes just that `[[link]]`
line (`DELETE /api/projects/:slug/people/:noteId`). Documents open in the app's
own reader (`DocViewer.tsx`) — PDFs and images through a blob URL, text inline,
`.docx` converted by mammoth and `.xlsx` by exceljs **on the server** (`GET
…/files/:name/html` and `…/files/:name/sheet`), because mammoth's browser build
never settles under our bundler and a workbook parser has no business in the web
bundle. The HTML is scrubbed of scripts and `on*` handlers before it reaches
`dangerouslySetInnerHTML`; the sheet endpoint caps at 12 sheets × 500 rows × 40
columns and returns **dense** string rows — exceljs's `row.values` is 1-based and
sparse, and `.map` skips holes, which then serialise as nulls and crash the
table. `.pptx` goes through `…/files/:name/slides` (`apps/server/src/slides.ts`):
slide text, tables, speaker notes and images as **data, not markup** — the
reader builds its own elements, and an image is sent only when its bytes say
PNG/JPEG/GIF/WebP (an SVG named `image1.png` is dropped). The zip is read with
`node:zlib` so every part inflates under `maxOutputLength`; caps are in
`SLIDE_CAPS`. Decks built from text boxes have no title placeholder, so a
first box holding one short unbulleted line is taken as the title.

`GET /api/projects/:slug` returns the whole workspace in one call; the MCP tools
`list_projects` / `get_project` / `log_decision` hand the same payload — prompt
included — to Claude Code, which is what makes "check the Thesis project" work
from a cold session.

## Projects are bound by tag, not by folder

A note joins a project through a `project/<slug>` tag in its **front matter**; an inline `#project/x` in the body binds nothing. Folder location is irrelevant: a note under `04-Projects/thesis/` with only a `thesis` tag is indexed, searchable and visible in Documents, but does not belong to the Graduation Thesis project. There is one slug grammar, `PROJECT_SLUG_RE` / `projectSlugOf` in core `vault.ts` (a letter or digit of any script, then letters, marks, digits, `_` and `-`, at most 64 — one path segment), used by registration, the board and every route; a nested tag (`project/thesis/2026`) is no project. `projects` rows in SQLite are keyed on that tag (`kind='tag'`, `key='project/thesis'`), and every surface tells projects apart by key (`projectKeyOf`, `progress` keyed by key): a name is display only, and two projects may share one. A project is named by its project note's `title:` (`projectName(projectNoteFor(…))`), else by the name it was registered under — never by whichever tagged note was indexed first. Project progress counts checkbox tasks inside tagged notes, so tagging a checklist-heavy note changes the project's totals.

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

`Finance.tsx` (web) + `routes/finance.ts` (server) + four core modules
(`statement.ts`, `spending.ts`, `subscriptions.ts`, `payslip.ts`, `savings.ts`).
Same rule as everywhere else: **nothing lives only in the database.** The
ledgers are Markdown tables in notes found by tag (`#income`,
`#subscriptions`, `#payslips`, `#spending-categories`, `#own-accounts`), and
statements and payslips are real files in `02-Areas/finance/files/`.

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

**One route, several pages**, narrowing at each step and all reachable from each
other — overview → all spending → one category → one month of it → one merchant
→ the transactions. The `View` carries `category`, `merchant`, `page` and
`month`; `month` wins over `category`, because a month opened from inside
Shopping keeps `category` set and that is what filters it. Every chart column,
every chart point, every category row, every merchant row and every month band
is a button. Adding a surface here means adding a link out of it.

**The savings model** (`packages/core/src/savings.ts`) is the one piece of real
analysis, and it is deliberately derived from Jules's own months rather than
from a rule of thumb: `target = surplus + Σ(typical month − good month)` over
discretionary categories, where "good" is the 25th percentile of the months on
record — a number he has already lived through, not an aspiration. Two traps it
is built around. **Money in comes from the BANK**, not from payslips: where the
statement carries balances, whatever came in is whatever went out plus the
change in balance, and payslips see only one employer (on the real file the
payslip median said €500/month while the balance was climbing €300 on top of
€1,000 of spending — the payslip version reported a deficit for an account that
was visibly growing). And **committed categories are never "trimmable"** —
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
all four endpoints and the Dashboard on purpose: three copies of a
de-duplication rule is three chances for two pages to disagree about what a
month cost. **One quantity, one function**: what a month cost is `costOf`
through `monthlyByCategory` (the hero, the month page, the category page and the
Dashboard all read it); the savings plan is `planSavings`; "this month against
typical" is `typicalAround` (the complete months around it, itself excluded —
the month page, the top cards and the Dashboard card); whether a ledger line
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

Charts are hand-drawn SVG with no chart library, and they sit on the page
ground rather than inside a card (`.fin-plot`), with rounded gridlines
(`niceTicks`) whose labels are dropped when they would collide with the
typical/average datum. The palette is scoped to `.fin`; see the long comment in
`packages/ui/src/tokens.css` for why the category colours are what they are, and
why green is status-only rather than a category.

**Finance is a documented exception to the flat design language** — elevation,
gradient surfaces and larger radii are allowed inside `.fin` and nowhere else.
The block in `styles/money.css` says so; do not "fix" it to match the rest of the app,
and do not copy it outward.

## The Planning tab

`Planning.tsx` + `routes/plan.ts` + `routes/calendar.ts`. A week/month calendar
over task time-blocks and events, and the only place the app will fill your
calendar for you.

**The grid was empty because the vault's dates were not in it.** It drew blocks
and events alone, so a week with no meetings was a blank 24-hour rectangle while
the same vault held 44 dated tasks, a thesis deadline and a subscription charge.
None of those own a time of day, so they are not grid items — they are the
**dated band** between the day heads and the hours (`GET
/api/calendar/markers`), carrying the same four sources the Dashboard agenda
unifies: `due` (an open task's `due:`), `milestone` (a project's
`start:`/`deadline:` front-matter), `charge` and `income` (the ledgers, expanded
across the range with `chargeDates` from the note's own date — `anchor`, not the
rolled-forward `next` — so a 31st stays the 31st and a range before `next` still
shows its charges; the Finance ledger calendar uses the same function). A due chip opens the task's own `TaskCard`, so the deadline
band is a way *into* the work rather than a label on it.

**The hour window follows the content.** The day opens on 07:00–23:00 and
`windowFor` widens it around anything outside — a 06:30 block moves the top of
the grid, it never falls off it. The mono label in the head gutter is the
toggle: it says which hours you are looking at, and clicking it forces the full
24h (`localStorage`, `basalt-plan-fullday`). Do not "fix" this back to a fixed
0–24 grid: two thirds of it is a picture of when nothing happens.

**Key deadlines are a tag, not a priority.** A task line carrying `#deadline`
(`ParsedTask.key`) is drawn as a solid `--danger` chip, first in its day, in
both Planning views, and in red on the Dashboard, whose Deadlines card also
lifts upcoming ones above older overdue work. Priority could not carry this:
the thesis marks nearly every task `!p1`. The tag is dropped from the title and
still indexed like any other.

**"Plan my week" proposes; it never writes** (`POST /api/plan/auto`). Most
urgent first — overdue, then at-risk, then by deadline and priority — into the
gaps that are actually free, 09:00–18:00 on weekdays, at most 2h a sitting and
`hoursPerDay` of task time a day *counting what is already booked*. Nothing
lands over an existing block, event or subscribed-calendar occurrence, nothing
lands in the past, and nothing lands after its own deadline unless it is already
overdue (every day is late by then). The response is a proposal the client draws
as dashed ghosts — click one to drop it — and **booking loops the ordinary `POST
/api/tasks/blocks`**, so one path still promotes the checkbox and writes the
block, and nothing reaches the calendar the user has not looked at first.

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

## Live sync

`VaultStore.events` emits `note-changed` on every mutation → `routes/ws.ts`
broadcasts to connected clients **after a per-recipient `canRead` check**. Clients
(`apps/web/src/ws.ts`) reconnect with backoff (2 s doubling to 30 s, jittered);
after a reconnect every view gets a `note-changed` with `resync: true` and
refetches; a 4001 close (the session ended) signs out instead of retrying;
Notes view refetches the open note (editor only swaps content when unfocused),
Dashboard reloads debounced. Presence = `{type:"editing", noteId}` pings,
rebroadcast only to users who can read that note. Frames from a client are
capped at 16 KiB (`WS_MAX_FRAME`, `main.ts`): a client only sends its auth frame
and presence pings, and the first frame is parsed before it is known to be a
valid auth.

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
  `BASALT_PLAN_AI_TIMEOUT_MS`, `BASALT_WEBHOOK_DEBOUNCE_MS`) are whole numbers,
  origins are bare origins, data/vault paths are directories, and real secrets
  are ≥ 32 characters. A new variable gets a rule there.
- **Outbound requests to user-typed URLs go through `safeFetch`** (calendar
  feeds, webhooks): http(s) only, every resolved address public (checked in the
  socket's own `lookup`, so DNS rebinding is caught), redirects re-checked hop
  by hop (GET only), and callers report a coarse outcome — never the far end's
  status or error text. A private target that is really wanted (a NAS, a tailnet
  host) is named in `BASALT_FETCH_ALLOW` (hosts or CIDRs). Anything new that
  fetches a URL a user supplied uses it too. A connection `safeFetch` cannot
  make itself (IMAP/SMTP to a user-typed mail server) checks the host with
  `assertPermittedHost` first — same rule and allow-list, checked before
  connecting rather than in the socket.
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
  Every surface reads `status`, every route writes it with `setTaskStatus`, and
  `task_objects.status` only mirrors the file (`reconcileTaskObjects`, also run
  for every note at boot). The two middle states used to be DB-only and died
  with the database (audit B10); `migrations.ts` moved the old rows into their
  lines once — a `meta` row records it, because re-running it would overwrite
  a box cleared in Obsidian while the server was down.
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
  a task of its own until promoting gives it its own id.
- **Time blocks and events are Markdown** — one note per person per month,
  `01-Me/Calendar/2026-10.md` (`Personal/<u>/Calendar/` for a user who cannot
  edit 01-Me), a table `| Date | Start | End | What | Task | id |`; a row with a
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
  the file stored. `writeFileAtomic(…, { exclusive: true })` links instead of
  renaming, so a file that appeared since the check is not lost. Files are
  served under their own name with `contentDisposition` (same file): an ASCII
  fallback plus RFC 5987 `filename*` — a raw name above U+00FF in a header
  throws outside every handler and stops the process.
- **Never rewrite bytes that were not parsed.** `updateFrontmatter` edits only
  the lines of the keys it changes and reads its result back; if it would not
  read back as exactly the new data with the body byte-identical, the note is
  returned unchanged. Splices (`diffSplice`) are bounded on whole code points —
  Yjs turns a split surrogate pair into U+FFFD — and `updateDocContent` throws
  rather than leave a doc that reads otherwise. `mergeText` merges with every
  line terminated (Obsidian writes no final newline).
- **The agent's log rotates itself** (`rotateLogIfLarge`, `logging.ts`): past
  5 MB at boot or on the hourly check, `~/.basalt-run/server.log` moves to
  `server.log.1` (owner-only) and starts again — only when stdout really is
  that file. URLs in it are already redacted (no query strings or secret paths).
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
  never create, change or reveal a credential, or decide where one is sent. A
  route says so in its config, `{ preHandler: [app.authenticate], config:
  sessionOnly("why") }` (`routes/auth.ts`), and `authenticate` refuses the token
  with that reason. Today: passcode, Touch ID, logout and sessions, revoke-all,
  tokens, webhooks, mail send and mail account, the ICS feed token, all of
  `/api/admin/*`. `test/token-gate.test.ts` lists them; a new credential route
  opts in and gets a row there. A password change and Settings → Sign out
  everywhere end every session, token and Touch ID device and clear the
  passcode and feed link (`revokeEverything`, `sessions.ts`).
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
  dark; "Match this device" is a per-device key, `basalt-theme-device`.
- **Storage**: read and write through `apps/web/src/storage.ts`. The browser can
  refuse storage (the getter throws), and `guardStorage()` in `main.tsx` gives
  the older direct callers an in-memory one.
- **Web tests**: `*.test.ts(x)` run in Node; `*.dom.test.ts(x)` run in happy-dom
  with Testing Library (`src/test/dom-setup.ts`). `src/test/app-harness.tsx`
  mounts the whole App with its screens stubbed, for shell, address, key and
  overlay tests. happy-dom follows a link clicked through a child element even
  when the click was prevented (a browser does not): in a DOM test, click the
  link itself.

- Team **slugs** (not ids) are the `TeamId` in core ACL and what `#only/#share` match.
- Note ids live in front-matter (`id: n-…`), assigned on first index; renames are
  metadata ops so links never break. `VaultStore.write` preserves the existing id.
- Unreadable link targets render as locked stubs: author's text only, 404 on fetch —
  never confirm existence (§5.4).
- Web saves send full content + `baseHash`; server rebases as a splice against the
  live Y.Doc. Desktop clients will exchange raw Y updates instead.
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
one.

**One of each pattern.** Overlays go through one stack (`ui/overlays.tsx`):
palette over dialog over sheet over panel, popovers above; one of a kind at a
time; Escape closes the top one only; a modal layer takes focus, keeps Tab inside
and gives focus back; a panel sits beside the page and leaves it in use. Never
`window.prompt`, `alert` or `confirm`: use `Confirm`, `Dialog` or `NameDialog`.
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
Orrery shows them as open circles in the topic of what they are `about`.

**Life-areas (School / Work / Knowledge / Claude & tools / Personal) are vault
data.** A note tagged `#vault-categories` holds `| Category | Matches |` rows —
phrases or `/regex/` against a note's path and tags, first row wins
(`packages/core/src/vaultCategories.ts`). The server applies the rules the caller
can read and sends `category` on every `/api/vault/tree` note; the web only
colours and counts. Without the note, only the PARA folders are known.

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

The **Dashboard** (`Dashboard.tsx`, the default tab) is a card grid: white
(or near-black) cards, hairline borders, no tints. Six cards: hero stat, this-week/last-week activity line chart, In Focus
tasks, Schedule (mini calendar + agenda), Today's Tasks checklist, Analytics
(stat tiles + category donut). Scoped under `.home` via `--d-*` vars that alias the
global tokens, so it flips with the theme like every other surface — no bespoke
palette, no special rail. Fed by
`/api/home` (personal aggregates, ACL-filtered) + the donut computed client-side
from the tree via `categories.ts`. Charts are hand-drawn SVG, no chart lib.

The editor is live-preview (`livePreview.ts`), aimed at Obsidian's reading feel:
frontmatter collapses to a properties row, checkboxes/tags/links/metadata render
as widgets and chips, tables render as tables, `---` as a rule, fenced code as a
slab, and the active line always shows raw source. **Block decorations must come
from a StateField, never a ViewPlugin** — CodeMirror throws otherwise, which is
why `frontmatterCollapse` and `blockPreview` are fields while the per-line pass
is a plugin. Esc (or the close button in the note header) closes the note.

## Releases

`main` is what is running: after every `pnpm ship` from `sep-2026-redesign`,
fast-forward it (`git push origin sep-2026-redesign:main`). A release is a tag
on a shipped commit, with an entry in `CHANGELOG.md`:

1. Move the `## [Unreleased]` notes under `## [X.Y.Z] — YYYY-MM-DD`, leave an
   empty `[Unreleased]` above, and add the compare/tag links at the bottom.
2. Bump the version in all twelve places — every `package.json`,
   `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`
   and the MCP server's handshake in `apps/mcp/src/index.ts`.
   `test/release.test.ts` fails until they agree and the changelog has the entry.
3. Commit, `pnpm ship`, then `git tag -a vX.Y.Z -m "Basalt X.Y.Z"` and push the
   tag and `main`.

Note anything users must do (a schema bump, signing in again) under
"Upgrading" in that version's entry.

## Dev loop

```sh
pnpm install
pnpm --dir apps/server seed   # demo: jules/erin/mara @basalt.dev, pw basalt-demo
pnpm --dir apps/server dev    # :4623 (delete apps/server/data to reseed)
pnpm --dir apps/web dev       # :4625, proxies /api (ws included)
# /dev/ui on :4625 shows every component of the design system (dev server only)
pnpm test                     # core + sync + server — permission tests are release-blocking
```

Ports 4623/4625 are deliberate (4620/4621 are taken on this machine). When testing
the web UI programmatically: React controlled inputs need native-setter + `input`
event dispatch, and forms need `requestSubmit()`.
