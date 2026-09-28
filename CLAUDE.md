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
  boot on the shipped placeholders regardless of `NODE_ENV`; `pnpm --dir
  apps/server dev` opts out with `BASALT_ALLOW_DEV_SECRETS=1`. Changing
  `BASALT_SECRET_KEY` orphans the stored mail password and AI key — run
  `pnpm --dir apps/server rotate-secret-key` with the server stopped.
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
delete the DB, re-index the Markdown, and it rebuilds (only promoted-task metadata
lives DB-only).

## Layout

| Path | Contents |
|---|---|
| `packages/core/src/parse.ts` | Markdown → links/tags/tasks/headings. Line-based; skips code fences |
| `packages/core/src/sections.ts` | `##` headings as addressable slots (`readSection`/`writeSection`/`appendToSection`) — how the project workspace stores goals, prompt, decisions, inbox |
| `packages/core/src/acl.ts` | **THE permission implementation.** `canRead`/`canEdit`/`validateEdit`/`filterReadable` + `personalOwner`. Never filter anywhere else |
| `packages/core/src/vault.ts` | `VaultIndex`: link resolution, backlinks, tag index, project progress, search |
| `packages/core/src/tasks.ts` | Text transforms: toggle checkbox, promote (`^t-xxxxxx` block id), append |
| `packages/core/src/related.ts` | "Suggested links" TF-IDF scorer (embeddings will replace scorer, same interface) |
| `packages/sync/` | Y.Doc helpers, splice diffs, `computeManifest` (partial checkout) |
| `packages/schema/` | Zod API schemas (`api.ts`) + Drizzle tables (`db.ts`) |
| `apps/server/src/vaultStore.ts` | Files-on-disk + index + Y.Doc cache + `events` EventEmitter (live sync bus) |
| `apps/server/src/routes/` | auth, vault, tasks, dashboard, home (personal aggregates for the Dashboard), admin, ai, ws, plan, calendar, contacts, ics (ICS feeds in/out), integrations (API tokens + webhooks) — one file each |
| `apps/server/src/ics.ts` | Minimal RFC 5545 parse/expand/build (RRULE subset, TZID via Intl) — no Google API |
| `apps/server/src/webhooks.ts` | Outgoing webhook dispatcher; HMAC-signed, ACL-filtered per hook owner |
| `apps/web/src/` | React, left-rail shell in `App.tsx`: `Dashboard` (default tab, `/api/home`), `Architecture` (scoped files + `GraphCanvas` + `Editor`), `Planning` (week/month calendar: dated band + grid time-blocks, events, ICS overlay, auto-schedule; `/api/plan`, `/api/calendar/markers`), `Overview` (project board by life-area, `Gantt.tsx`) → `Project.tsx` (per-project workspace), `Contacts` (split view: people list left, `Companies.tsx` right — A–Z card wall with a phone-style letter rail; one search + sector filter drives both halves), `Admin` (DnD grants), `Settings` (character `avatars.tsx`), `AskPanel`, `icons.tsx` (no emoji chrome), `ws.ts` |
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

## The project workspace is the note

Clicking a project on the Overview board opens `Project.tsx`: header (status,
start→deadline countdown, % ring), goals, Gantt, steps, the project note in the
live editor, documents, linked people, the agent prompt, a decision log and a
quick-capture inbox. **None of it is a database row.** Goals/Prompt/Decisions/
Inbox are `##` sections of the project note (`packages/core/src/sections.ts`),
people are real `[[links]]` the picker writes into `## People`, steps are the
note's checkboxes, and `status`/`start`/`deadline` are front-matter. Delete the
DB, re-index, and the workspace comes back — same rule as the dashboard.

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
table.

`GET /api/projects/:slug` returns the whole workspace in one call; the MCP tools
`list_projects` / `get_project` / `log_decision` hand the same payload — prompt
included — to Claude Code, which is what makes "check the Thesis project" work
from a cold session.

## Projects are bound by tag, not by folder

A note joins a project through a `project/<key>` tag in its frontmatter. Folder location is irrelevant: a note under `04-Projects/thesis/` with only a `thesis` tag is indexed, searchable and visible in Documents, but does not belong to the Graduation Thesis project. `projects` rows in SQLite are keyed on that tag (`kind='tag'`, `key='project/thesis'`). Project progress counts checkbox tasks inside tagged notes, so tagging a checklist-heavy note changes the project's totals.

## One shared vault with Obsidian

The vault is `~/Obsidian Vault` — the *same folder* Obsidian opens, not a copy.
`BASALT_VAULT_DIR` (see `env.ts`) points the server at it; the SQLite DB stays in
`<dataDir>` because it is a cache of the files, not part of the notes. Both apps
read and write the same Markdown: Obsidian saves whole files and the chokidar
watcher re-indexes them; Basalt writes through `VaultStore.write`. Editing the
*same note* in both at once is the one thing to avoid — last writer wins on the
overlapping region.

On this machine the server runs as a launchd agent
(`~/Library/LaunchAgents/dev.basalt.server.plist`, `KeepAlive`), which is where
`BASALT_VAULT_DIR` is set — changing the vault path means editing that plist and
`launchctl unload && load`, not just an export in a shell. The vault deliberately
lives outside `~/Documents`: that folder is iCloud-synced (rewriting ~600 files
would churn the sync, and evicted files download one at a time) and is a
TCC-protected location a background agent may not be allowed to read.

**First index stamps every note**: any note without `id: n-…` front-matter gets
one written into the file. That is what keeps renames link-safe (task objects key
on the note id), and it means pointing Basalt at a fresh vault modifies every
file in it once. `scripts/merge-vaults.mjs` is the one-off that folded Basalt's
old copy into the Obsidian vault (newest-wins per file, carrying ids across).

## The Finance area

`Finance.tsx` (web) + `routes/finance.ts` (server) + four core modules
(`statement.ts`, `spending.ts`, `subscriptions.ts`, `payslip.ts`, `savings.ts`).
Same rule as everywhere else: **nothing lives only in the database.** The
ledgers are Markdown tables in notes found by tag (`#income`,
`#subscriptions`, `#payslips`, `#spending-categories`, `#own-accounts`), and
statements and payslips are real files in `02-Areas/finance/files/`.

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

`loadTxns` (reached through `txnsFor`, which applies the reader's own-accounts
list) and `buildRules` are shared by all four endpoints and the Dashboard on purpose: three
copies of a de-duplication rule is three chances for two pages to disagree about
what a month cost. When a month view is filtered to a category, its "typical"
must be that category's median, not the whole month's — comparing €250 of
shopping against a €1,000 all-category median is the bug the finance tests
exist to catch.

Charts are hand-drawn SVG with no chart library, and they sit on the page
ground rather than inside a card (`.fin-plot`), with rounded gridlines
(`niceTicks`) whose labels are dropped when they would collide with the
typical/average datum. The palette is scoped to `.fin`; see the long comment in
`packages/ui/src/tokens.css` for why the category colours are what they are, and
why green is status-only rather than a category.

**Finance is a documented exception to the flat design language** — elevation,
gradient surfaces and larger radii are allowed inside `.fin` and nowhere else.
The block in `app.css` says so; do not "fix" it to match the rest of the app,
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
across the range with `advance`, because `next` is one date and a month view
spans six weeks). A due chip opens the task's own `TaskCard`, so the deadline
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
UI job, not a migration.

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
mail is a thin slice: Jules's last 60 contain zero Primary.

`MessageBody` prefers the **HTML** part and falls back to text — the other way
round (what it used to do) means every marketing mail renders as its plain-text
alternative, which is a wall of bracketed tracking URLs. HTML goes into an
iframe with `sandbox="allow-popups allow-popups-to-escape-sandbox"`: no scripts,
no access to our origin, but links still open in the real browser. `allow-same-origin` is present *only* so the parent can measure
`contentDocument.scrollHeight` and size the frame to the message — one scrollbar,
no dead box — which is safe because `allow-scripts` is absent, so nothing inside
can execute and use that origin. Images load by default like any mail client;
"Block images" flips the CSP to `img-src data:` and the preference sticks
(`basalt-mail-images`). Inject as little CSS as possible: `img`/`table` get
`max-width:100%`, and nothing else — a universal `max-width` forces email tables
into a stacked mobile layout (it quadrupled one message's height). The text
fallback drops image-only lines and labels links by host, keeping the full URL
on the href.

## The agent can draft mail, never send it

The agent reads text nobody vetted — inbox messages, notes any teammate can
write — while holding the vault's contents and a live SMTP session. So the send
is gated in code, not in the prompt: `draft_email` (in-app agent) and the MCP
`draft_email` both stage a `mail_drafts` row, `POST /api/mail/send` refuses API
tokens outright, and the Mail view surfaces staged drafts under "Waiting for
you" — opening one loads it into the normal composer, so what goes out is what
the user just read. There is deliberately no "send this stored draft" endpoint:
one send path means one place that requires a session. Adding another outbound
channel (Slack, SMS, a webhook the agent can aim)? It gets the same treatment.

## Live sync

`VaultStore.events` emits `note-changed` on every mutation → `routes/ws.ts`
broadcasts to connected clients **after a per-recipient `canRead` check**. Clients
(`apps/web/src/ws.ts`) auto-reconnect; Notes view refetches the open note (editor
only swaps content when unfocused), Dashboard reloads debounced. Presence =
`{type:"editing", noteId}` pings, rebroadcast only to users who can read that note.

## Conventions & gotchas

- **Every non-API response carries a Content-Security-Policy** (`CSP` in
  `main.ts`): scripts from our own origin only, so markup that slips past the
  .docx/mail scrubbers still cannot run. Adding anything loaded from another
  host (a font, a CDN script, an API called from the browser) means adding it
  there, or it is silently blocked in the built app — vite dev (:4625) sends no
  CSP, so it will look fine while iterating. The mail iframe *inherits* this
  policy, which is why `img-src`/`font-src` allow https:.
- **Touch ID trusts only known origins.** Set `BASALT_PUBLIC_ORIGINS` (comma-
  separated, e.g. `http://localhost:4623,https://<mac>.<tailnet>.ts.net`) in the
  launchd plist; unset, the `Origin` must equal the address the request was
  sent to, which blocks cross-site use but is the weaker of the two.
- **DB-only task changes need edit** (`store.requireEditable`): status, dates,
  assignee and time blocks never pass through `write()`, so they check edit
  themselves. Comments stay at read.
- **Finance files follow the folder ACL** of `02-Areas/finance/files`, like the
  notes beside them (`canReadFinanceFiles`); uploads need edit.
- **Sign-in is throttled** (`loginLimit.ts`): five wrong passwords from one
  address inside 15 minutes → 429 until the oldest ages out, even for the
  right password. In memory; a restart clears it.

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

**Flat, light-first design language** (replaced the frosted-glass one in Aug 2026;
the old `~/basalt-dash-mock` glass mocks are historical). Solid surfaces, 1px
hairline `--border` separators, generous whitespace, and colour only where it
carries information. No blur, no gradients, no glow: `--blur` is `none`,
`--card-shadow` is `none`, and `--glass*` survive only as aliases of the flat
surface tokens so older rules keep working — reach for `--surface` / `--panel` /
`--border` in new work. Two themes from one design: `:root`/`[data-theme="light"]`
is paper white (the design target, and the default), `[data-theme="command"]` is
the same language inverted onto near-black. Primary buttons are `--solid`
(near-black on light, near-white on dark), not accent-filled; the violet
`--accent` is for links, focus, selection and the active node in the map.
Floating things use `--shadow-pop` and sit on `--scrim`; everything else
separates by border alone. Radii: `--radius` 12 / `--radius-sm` 8 / `--radius-lg`
16. Type is Plus Jakarta Sans (`--font-ui`) + JetBrains Mono for numbers, paths
and micro-labels. No emoji as icons (use `icons.tsx`). **Token-first**:
everything reads `var(--…)` from `packages/ui/src/tokens.css` — retint there,
never in components.

**Why a Basalt graph looks sparser than the same vault in Obsidian**: Obsidian's
graph draws *tags* as nodes by default (and attachments, and ghost nodes for
unresolved links). On Jules's vault the note→note links number ~198 while a tag
layer adds ~319 edges — most of the density is tags, not links. Hence the "Tags
as nodes" switch in the graph panel, built client-side from the `tags` each node
already carries. Links themselves are parsed from `[[wiki]]` *and* markdown
`[text](note.md)` form, and resolve by title, alias, filename, or vault path
(with or without `.md`, `%20`-decoded).

The map (`GraphCanvas`) is a live d3-force graph on canvas, Obsidian-style:
repulsion + `forceCollide` (nodes never overlap), link springs, drag a node to
move it (pointer sets `fx/fy`, release settles), wheel-zoom, background-pan,
pointing at a row in the file tree spotlights it on the map — one node for a
file, the whole subtree for a folder (`FileTree`'s `onSpotlight` → `GraphCanvas`'s
`spotlight` prop), which is the same gesture as the category chips but per file;
hover lights the neighbourhood and labels **only** the node under the pointer
(a neighbourhood of labels is unreadable), with the full title, folder and a
one-line description in a readout bottom-right — `/api/vault/graph` sends a
`description` per node: the note's own `description:`/`summary:` front-matter if
it has one, else its first real sentence. It is **monochrome on
purpose** — a node's radius is `3 + √degree · 1.9`, so size is the only signal
and the shape of the vault is what you read. Colour still lives in the file list
and the category filter, where it labels things. A gear opens the settings panel
(link distance, repel, centre pull, node size — live-retuned on the running
simulation, not a rebuild) and **local graph**: the last-opened note plus
everything within N hops, `onShown` reporting the real count back so the hint
never lies. Settings persist in `localStorage` under `basalt-graph`.

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
is a plugin. Esc (or the ✕ in the note header) closes a note back to the map.

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
