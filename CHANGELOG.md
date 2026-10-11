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
- **Orrama, the new look (wave A of the redesign).** The app is called Orrama
  on screen — window title, sign-in, lock, first run, home-screen icon — on
  warm paper by day and night blue after dark, with Figtree type served by the
  app itself. The screens themselves are redrawn in the next waves; until then
  they keep their old layouts on the new colours.
- Every place and thing has an address: reload keeps your place, Back and
  Forward work, and links can be shared.
- The vault can now be read as a knowledge graph: a `#vault-ontology` note
  defines types, relations and statuses, and Basalt derives typed facts from
  front matter, `key:: value` fields, the `## People` section and
  `project/<key>` tags. The MCP server and the in-app agent get five query
  tools — vault_schema, find_entities, get_relations, find_path,
  list_summaries — that answer from the graph in a fraction of the tokens a
  search-and-read takes; descriptions tell a model to query first and read
  last. On the map, typed relations draw heavier (dashed when only implied),
  are named when you point at a note, and are listed in its readout; a
  Relations switch in the map settings turns them off.
- Settings → Signed in: **Sign out everywhere** ends every session, API token
  and Touch ID device, and clears the passcode and the calendar feed link.
- **The Orrery** (key 4; on the phone under More): everything you keep around
  Orr, in rings by kind (projects, then people and companies, then notes and
  conversations) and slices by life area, as a live web you can drag. Click a
  file for all of its links and its relations in words; double-click, Enter
  or "Put in the middle" for Steps, with that thing in the middle. Zoom into a
  life area or a topic; Find flies to a file; weekly reviews and templates are
  a switch away. Every level has its address (`/orrery?area=work`,
  `/orrery?center=…`), so Back and links work.
- Every message has an address (`/mail/<id>`), and so does Waiting for you
  (`/mail/waiting`): reload, Back and links work.
- Orr's reply to a message waits right under it, whole, with Send, Edit and
  Discard.
- Forward, in Mail.
- Theme: Match this device, which follows this device's light or dark setting
  while your other devices keep yours.
- Settings → Notes shows which folder the notes are read from, the life areas
  and what Orr noticed.
- Find a setting, at the top of Settings.
- Settings → This device says whether a passcode is set.

### Changed

- The rail holds the eight places (Today, Planning, Notes, Orrery, Projects,
  People, Mail, Money) with Find, Ask Orr and your Orr at the foot. Reload,
  Dark and Back left it: use ⌘R, Settings → Appearance and the browser's Back.
- On a phone: a top bar and five tabs (Today, Planning, Ask Orr, Notes, More).
  More holds the other places and Settings.
- Number keys follow the rail: 1 Today, 2 Planning, 3 Notes, 4 Orrery,
  5 Projects, 6 People, 7 Mail, 8 Money. Press ? to see every key.
- Your avatar is one of eight Orrs. If you had picked a rock face, you see its
  Orr until you pick again.
- Dates read "Fri 9 Oct" and times use the 24-hour clock everywhere.
- New note asks for its path in a dialog, and says under the field what was
  wrong.
- Settings is a page with eight sections (You, Appearance, Orr & AI, Notes,
  Connections, This device, Signed in, Developer), each at its own address and
  each saying whether it lives on this device, your account or this server.
  On a phone, More → Settings lists the sections with where each stands, and
  each section is its own screen.
- Orr & AI saves with one button and says what you changed; a stored key
  shows as stored, and Replace asks for a new one.
- Mail is redrawn: the list and the message side by side, Orr's drafts in his
  warm box with his head. On a phone the list, the message and the reply are
  each their own screen, with Back.
- In Mail, the sender's name opens their page in People, with a line saying
  how you know them.
- Mail's category tabs that don't fit go into a More menu; the tab you're on
  always stays visible.
- Block images moved to the message's ··· menu; while images are blocked a
  line above the message says so, with Show images.
- Mail's errors say what failed and offer Retry; with no mail account,
  Connect Gmail opens Settings.
- A new door: sign-in, lock and first run show Orr's head in a halo of dots
  that answer your pointer and your keys. Getting in gathers them into your
  notes, one slice per life area, and Today (or wherever you were) opens two
  seconds later. With reduced motion it opens at once.
- The lock shows the time and no name: Touch ID on a computer that has it, the
  keypad on a phone or a computer without it, and your password one click
  away, in place.
- First run asks for your name, email and password (with Show instead of a
  second password field), then counts what it found in your notes and offers
  the Orrery or Today.
- Starting up shows Orr rising over the horizon.
- Wrong passwords, passcodes and lockouts are said plainly, with how long to
  wait.
- Notes no longer opens on the map: with no note open it offers "Open the
  Orrery". "Back to the map" reads "Close note".

### Removed

- Plus Jakarta Sans and JetBrains Mono (loaded from Google Fonts).
- Glyph icons (✕ × ‹ › ✎ ↵) and keycaps on screen.
- Basalt no longer creates `.mcp.json` and `CLAUDE.md` in your vault on every
  start. Register the MCP server with `claude mcp add` instead (see
  `apps/mcp/README.md`); an old placeholder `.mcp.json` in the vault can be
  deleted.
- The map's settings panel: link distance, repel, centre pull, node size,
  local graph, tags as nodes, the Relations switch and the Conversations
  switch (conversations now sit in the topic of what they are about), and the
  map spotlight when pointing at the file list.
- Team words in Settings ("workspace owner", team names).
- The ↻ refresh glyphs in Settings and Mail (now a line icon; in Mail, "Check
  now").

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
- A slow answer can no longer overwrite a newer one: opening one note and
  then another quickly, flipping weeks in Planning, switching documents,
  Finance months or mail messages, and typing in search each cancel the
  request they replace.
- Saved Claude conversations (`type: claude-session`) are their own kind of
  note: still searchable and linkable, but their text no longer adds links,
  tags or tasks, and the map hides them unless "Conversations" is on.
- Colours like `#d93025` are no longer read as tags (only colours starting
  with a digit were kept out).
- A project without a `04-Projects/<slug>.md` no longer flips between two of
  its tagged notes: decisions, captures and people used to land in whichever
  note was "first" at that moment, and the page showed only one of them.
- Changing an emoji next to another one (🔴 → 🟢, 🔼 → 🔽, 😀 → 😃) in the
  editor no longer writes `��` into the note.
- Basalt no longer deletes a note's opening `---` block when that block is
  prose, a list or only comments; such a note is left as written.
- A note whose front matter has a YAML error (an unquoted colon), or whose
  `id:` is a number, keeps the same note id across edits, Obsidian saves and
  restarts — task comments, descriptions and assignees no longer come loose.
- Windows line endings are kept when Basalt adds an id or sets a property,
  and no `"\r"` is written into the last value.
- Adding an id or setting one property no longer reformats the rest of the
  front matter (long values folded, lists re-spaced), and a byte-order mark
  stays at the start of the file.
- A note saved in a legacy encoding (Windows-1252, UTF-16) is no longer
  rewritten with its accents destroyed. Basalt reads and indexes it, never
  writes to it, and says so (in the server log, and with a 409 on save) until
  it is saved as UTF-8.
- When an Obsidian edit to a note's last line and a Basalt append (quick
  capture, the agent) meet, the two lines stay separate instead of being
  joined into one.
- The server refuses to start when `BASALT_SECRET_KEY` or `BASALT_JWT_SECRET`
  is set but empty (it used to start and encrypt credentials under an empty
  key).
- `rotate-secret-key` now also re-encrypts the Sign in with ChatGPT
  credentials and webhook secrets, so rotating the key no longer quietly signs
  you out of your ChatGPT plan.
- "Spent in <month>" on the Finance tab now counts rent paid by transfer and
  nets returned purchases, so it matches the month page and the Dashboard.
- A merchant's page nets refunds against the purchases they refund, and no
  longer counts a refund as money arriving.
- With a Savings pocket in the export, the balance trend, burn, runway and the
  savings plan follow the current account instead of whichever pocket moved
  last.
- The month a statement starts inside is no longer counted as a complete
  month; months between two exports are no longer averaged over; a covered
  month with nothing spent counts as €0.
- A category's "Monthly average" leaves out the month in progress, and its
  counts leave out salary, top-ups and fully refunded purchases.
- A subscription matched as `=ns` or without accents ("pathe" for "PATHÉ")
  shows its charges on its own card and is no longer offered under "Looks
  recurring".
- The savings page's money in no longer drops when one month has a large
  transfer; "Average month in/out" now add up to what is left over.
- With three months of history the savings plan can show headroom;
  "Committed" and "Discretionary" are the typical month's own figures.
- The Finance top cards and the Dashboard compare a month against the same
  typical as the month page they open.
- Ledger totals in different currencies are shown side by side ("€19.66 ·
  US$12.00") instead of added into one euro figure.
- A hand-typed `balance: 1.234,56` in the finance note reads as 1,234.56, not
  1.234.
- ⌘← and ⌘[ no longer pull you out of a note, or throw away a mail draft,
  while you type.
- One broken page no longer blanks the whole window, and ⌘R still reloads.
- Starting or reloading in the light theme no longer flashes dark first.
- ⌘K opened from Settings appears on top; Escape closes the top overlay and
  only that one; Find and capture are proper dialogs.
- After the server restarts, open pages catch up by themselves; reconnects
  back off; a session ended elsewhere stops retrying.
- The app no longer goes blank when the browser refuses storage.
- Fixing a note's capitalisation in Obsidian or Finder no longer makes Basalt
  undo the rename and rewrite the note over and over; the note keeps its id
  and its bytes.
- A path that differs from an existing note only in letter case or Unicode
  form now means that note: a save to it edits it instead of replacing it.
- New note, New contact and New company no longer replace a note that already
  exists at that path; they say where it is. Names with `:` or quotes no
  longer break the note's front matter.
- Uploading a payslip, a statement or a project document whose name is
  already used keeps both files (`payslip (2).pdf`); a payslip refused as
  already filed is not stored.
- Opening a document named with a curly apostrophe, an en dash or a macOS
  screenshot's narrow space no longer stops the server.
- Notes in a folder linked into the vault from elsewhere are there after a
  restart, not only after their next edit.
- Markdown links written relative to their note (`[up](../Up.md)`) and links
  to names stored decomposed (`Résumé`) resolve in the map, backlinks and the
  note's links.
- A project tagged `project/my_thesis` (an underscore, another script) opens.
  Two projects whose notes share a title stay two projects. A note that only
  mentions `#project/x` in its text no longer adds its tasks to x, and the
  board and the project's page count the same tasks.
- Ticking, blocking, re-dating, scheduling or booking a task after the note
  changed elsewhere (an Obsidian edit, a decision logged above it) could
  change a different task. Every task edit now names the task by its block id
  or its text, and is refused when that task is no longer there.
- The side panel of an open note showed its tasks as they were when the note
  opened, so ticking one after typing above it ticked its neighbour. The panel
  now follows your saves.
- A promoted task line copied in Obsidian (with its `^t-` id) made both lines
  one task. The copy is now a task of its own and gets its own id when it is
  scheduled or promoted.
- Saving "Edit goals" without changing anything turned checkbox goals into
  plain bullets, flattened sub-items and bulletised prose. The editor now
  opens on the section's own text.
- Logging a decision, capturing a thought or linking a person collapsed blank
  lines everywhere in the project note, code blocks included.
- The project page read and wrote a `### Goals` (or Decisions, People) nested
  in another section, and missed `## Goals ##`, adding a second heading.
- Linking a person whose name matched another note's filename linked that
  note instead; the person never appeared, each click added another line, and
  Remove could not delete it.
- Renaming a box on the Documents board and switching tab straight away lost
  the rename.
- Typing a year into a project's start or deadline wrote every half-typed
  year (0002, 0020, 0202) into the note.
- Hand-typed amounts in the ledgers read as written: `€1.200` is twelve
  hundred (it was 1.2), `€29.99 (was 24.99)` is 29.99 (it was 299,924.99), and
  `−12.00`, `– 12,00` and `12.00-` are negative. A cell holding two numbers is
  not guessed.
- Ledger cadences beyond the four: biweekly/fortnightly, 4-weekly
  (vierwekelijks), every 2 months, half-yearly/per semester, and "every N
  weeks/months". A cadence or amount the ledger cannot read is listed on the
  Commitments/Income page ("2 rows are not counted") instead of being counted
  as monthly.
- Rent due on the 31st stays on the 31st in Planning and on the Finance ledger
  calendar (it drifted to the 30th, then the 28th), and Planning shows the
  charges before a ledger line's next date.
- `.xlsx` statements and CSVs re-saved by Excel (semicolons, decimal commas,
  day-month-year dates) are read. Uploading a statement says how many
  transactions it added, or why it adds none; statement files left out of the
  figures are listed on the Finance page.
- "€X more than expected" on yearly, quarterly and weekly ledger cards no
  longer invents overcharges.
- "Looks recurring" calls a weekly charge weekly with its real total, and no
  longer lists deposits into your own accounts.
- A category or merchant with "%" in its name opens instead of failing.
- With two notes carrying the same ledger tag, Finance always uses the same
  one (the one in `02-Areas/finance/` first) and says so, instead of
  alternating between them on every save.
- Removing a calendar, disconnecting mail, changing or stopping the published
  planning link, revoking a token, deleting a webhook, removing a Touch ID
  device, signing a device out and deleting a colour profile now ask first.
- Deleting a colour profile from its editor no longer closes the editor before
  you've decided.
- Opening a second draft Orr staged while the first was open kept the first
  one's text, then deleted the wrong draft on Send.
- Opening a message while writing threw the text away; now it asks first.
- Plain-text mail kept tracking-image lines after a line with a link.
- HTML mail no longer ends in a strip of white, and the frame shrinks again
  after Block images.
- Typing a passcode on the lock no longer moves you to another place behind
  it.
- After ten wrong passcodes the lock switches to your password by itself.
- Cancelling Touch ID in Safari no longer shows an error.

### Security

- The 4-digit quick-unlock passcode can no longer be brute-forced by sending
  many guesses at once; at most ten are ever checked before the password is
  required.
- Sending many sign-in or sign-up attempts at once no longer slips past the
  "five wrong passwords, then wait" limit, and a refused attempt no longer
  costs a password hash. Sign-up is rate-limited too.
- Basalt only answers requests addressed to `localhost`, `127.0.0.1`, `[::1]`
  or a host in `BASALT_PUBLIC_ORIGINS`, so a web page you visit cannot reach
  it by re-pointing its own name at your machine (DNS rebinding).
- An API token can no longer turn itself into a full session or manage
  credentials. It is refused on passcode, Touch ID, sessions, tokens,
  webhooks, mail sending and the mail account, the calendar feed link, and all
  workspace/AI settings.
- Changing the openai-compatible base URL in Settings → AI now needs the API
  key typed again, so the stored key cannot be redirected to another server.
- The mail account's IMAP/SMTP server must be a public address (or listed in
  `BASALT_FETCH_ALLOW`), and a failed connection no longer reports the remote
  error text.
- Changing your password signs you out everywhere — every session, API token
  and Touch ID device — and clears the passcode and the calendar feed link.
- The Touch ID sign-in no longer reveals which email addresses have an
  account or a passkey, and the password sign-in takes as long for an unknown
  address as for a wrong password.
- Webhook signing secrets are now stored encrypted, like the other
  credentials.
- A folder editor could overwrite an `#only/<team>` note, or a note in a
  subfolder whose grant excludes them, by changing one letter of its path's
  case. Writes now resolve to the note on disk and are judged by it; folder
  grants compare case- and Unicode-insensitively.
- A finance ledger is only ever a note you can edit, and never one in another
  user's Personal folder: new rows can no longer land in a note another
  account keeps.

### Internal

- Every answer the web app reads has one schema (`packages/schema/src/responses.ts`)
  and a contract test that checks the real server against it.
- Unauthenticated Touch ID challenges are cleaned up and capped; live-sync
  frames are capped at 16 KiB.
- Removed the unused `summary.avgSpend`, `summary.inPerMonth/outPerMonth` and
  `spending.fixed/variable/matched` from `/api/finance`, and `splitFixed` from
  core.
- The design system lives in `apps/web/src/ui` (components, 70 line icons,
  Orr, the overlay stack, router, keys, dates, theme; every piece on `/dev/ui`
  in the dev server); `app.css` is split into one file per area under
  `apps/web/src/styles/`, and 68 dead classes are gone.
- Web tests get a DOM: happy-dom with Testing Library (`*.dom.test.tsx`).
- `PUT /api/vault/note` takes `create: true` (409 when a note is at the path
  in any spelling). Both upload routes answer with the name the file was
  stored under.
- `POST /api/tasks/{check,status,dates,promote,schedule,blocks}` take `text`
  and refuse a request naming neither `blockId` nor `text` (400); the agent's
  and MCP's task tools take `text` too.
- Statement files are read asynchronously and parsed once per version of the
  file (memory cache keyed by inode, size and mtime); category matching folds
  each rules set once. /api/finance and /api/home no longer block the event
  loop for hundreds of milliseconds.
- `GET /api/settings/server` (owners): the notes folder, the note count and
  the version, for Settings → Notes. `GET /api/members` has a schema.
- The Orrery replaces `GraphCanvas`: one engine object that never resizes the
  canvas, reads CSS or reads layout in a frame, and strokes links in two
  passes; it loads lazily, when you first go there. About 3 ms a frame while
  dragging at 10,000 files in WebKit.

### Upgrading

- The first start of this version encrypts every stored webhook secret and
  stamps the database as schema 3; an older build then refuses to open it, so
  take a database backup before shipping.
- Reaching Basalt by a bare LAN or tailnet IP now needs that address in
  `BASALT_PUBLIC_ORIGINS`.
- A Touch ID passkey created as non-discoverable (unlikely on macOS) needs
  enrolling again.
- Project names now come from the project note's `title:` (unchanged when it
  has none). On the live vault three cards are renamed: Basalt → "Basalt —
  team knowledge tool", School Resits → "School Resits — June/July 2026",
  Graduation Internship → "Graduation Internship Search".

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
