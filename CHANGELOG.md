# Changelog

What changed in each release of Orrama (called Basalt until October 2026),
newest first. The commit messages carry the detail — the why, how it was
verified, what was left out; this file is the map. Releases are git tags (`v0.1.0`) on the commit that was shipped; how to cut
one is in CLAUDE.md, "Releases".

## [Unreleased]

### Added

- First run asks where your notes are: start with a small example, start empty, or use a
  folder of notes you already have (Orrama says how many notes it holds and what it adds before
  you choose). A new install also gets the note that says what things are
  (`Orrama/What things are.md`), so people, companies and projects are related from the start
  and Orr noticed has something to check.
- Settings → Notes → Change… picks another notes folder; Orrama restarts to read it. Remove the
  example puts the example's notes in the trash.
- Change your password in Settings → You. This device stays signed in; every other device is
  signed out.
- A step's card changes the step: its words, due and start dates (typed), priority, key
  deadline and status, each written into its line in the note. Move a step to another
  project's section or to your inbox from its card (booked time follows a step that has some),
  or delete it after a confirm that names it. Add a step takes a priority and the key-deadline
  tag too.
- Notes can be renamed, moved and put in the trash from the note's ⋯ and the tree's ⋯; links
  that name a renamed note follow it. Folders can be made, renamed, moved and put in the trash,
  and a note or folder dragged onto another folder on a desktop.
- The Trash (Notes → Trash, `/notes/trash`): everything put in the trash, kept in the notes
  folder's `.trash`, with Restore and Empty trash.
- A note's History (its ⋯): earlier versions, what changed since each, Restore this version.
- Money's ledgers are edited on screen. Add, change and remove subscriptions, income lines and
  payslips; add, rename, remove and reorder spending categories and the words that file shops
  under them; put a shop in another category from its page; keep a list of your own accounts on
  Savings. On an empty vault the first add makes the ledger's note in the finance area.
- Projects: a Reader tab shows a project's .html documents (saved claude.ai artifacts,
  reports) as the pages they are, with their own scripts, one at a time beside the list, and
  "Open on claude.ai" when the project note links the file to its artifact. The tab is there
  only when a project has such a page. The pages also open from Documents. Each runs sealed
  off from Orrama: it sees no sign-in, none of Orrama's storage and nothing of the app around it.
- Projects: one area at a time is split into groups, a box each (Work: Scooperz, Websites,
  Personal branding…), the biggest first and projects without one under Other. A project's
  group is its note's `group:` front matter, set from the project page's header: pick a group
  other projects use, make a new one, or take it out.
- A subscribed calendar's event (Google's secret iCal address, Outlook, Teams, Zoom) shows
  more than its time in Planning: a Join button for its Google Meet, Teams or Zoom call, its
  place (an address opens in Google Maps) and its description as plain text with its links,
  without the join and dial-in text Google adds to it, in any language. The feed is
  read as text: a description's HTML is read down to its words, only http(s) addresses
  become links, and a long one is cut at 2,000 characters.
- **Clay**, a second look next to Paper (Settings → Appearance → Look): cool grey and burnt
  orange by day, near black after dark, in Inter, with the places on the left and a page's
  sections at the top, one orange card for the page's big number, grey tiles, and motion (none
  if your device asks for less). Switching day and night spreads from the sun or moon with a
  softly wavy edge.
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
- **Today** replaces the Dashboard (wave C of the redesign). People today:
  who's in today's calendar or wrote to you today, and how you know them.
  Coming up: the next three weeks of events, key deadlines and project dates.
  Orr noticed: how many things in your notes' graph need a look, the first
  said in words. New on Today: a task, a note, an event, a project, a
  subscription or income.
- Planning's week, month and day have addresses (`/planning/week/2026-10-12`,
  `/planning/month/2026-11`, `/planning/day/2026-10-09`); ← and → step through
  them.
- Drag a block, an event or a due step to another day in Planning's lanes or
  month; its note changes with it.
- An empty day in a Planning lane or the month adds a step due that day to
  your inbox.
- A calendar feed that failed is named at the top of Planning, with Retry.
- On a phone, Planning's week stands up, days down the screen, and the month
  is a compact grid.
- Pin a note to Notes home from its ··· menu; the pin is a `pinned: true` line
  in the note's own front matter, so it shows on every device and in Obsidian.
- Show in the Orrery on every note.
- A tag in a note's side panel filters the tree to the notes carrying it.
- Each project tab has its own address
  (`/projects/graduation-thesis/timeline`), and the Projects board's area
  filter too (`/projects?area=school`).
- Add a step, from the project's header, its To-do tab or an empty week on its
  Timeline, with a typed due date.
- People & companies on a project shows who supervises it, from the knowledge
  graph, and the project's conversations.
- Orr points out a project with no status, or a status outside the vault's
  words; when every step is done he offers to archive it.
- Every person and company has an address (`/people/ines-vermaat`,
  `/companies/kade-social`); searches and the sector filter are in the address
  too.
- People and companies sort A–Z or by most recently mentioned.
- A company your contacts work at but that has no note yet is listed in
  People, and one click creates it.
- On the phone, People is one list with a People / Companies switch and an A–Z
  rail.
- Money's "Looks recurring" asks: Add it writes the charge into your
  subscriptions note; It's not recurring hides it on this device (Undo on the
  Subscriptions page).
- Drop a bank export or payslip anywhere on Money to add it.
- ↑ ↓ move between rows on Money; Enter opens one.
- Orr can read a whole note (`read_note`), add lines to one (`append_to_note`)
  or rewrite one section (`replace_section`) without resending the rest.
- People, companies, saved conversations and documents have their own pages:
  who or what they are, how they relate (in words, both ways), who they work
  with, how you know them through your notes, what is going on with them
  (mail, coming events, open steps), and the note itself.
- Orr noticed (Notes → Orr noticed, or Today's module): what in your notes'
  graph needs a look, said in words, each with one fix, and your notes at a
  glance.
- Find (⌘K) finds people, companies, projects, notes, conversations, places,
  settings and actions, grouped and described; Tab narrows to one kind, and
  "person ines" does too.
- Stop while Orr works.
- Earlier questions: your last 20 conversations with Orr, on this device; the
  one you had open comes back when you open Ask again.
- New on Today and on the phone's +: a task, a note, an event or a project,
  already set for the page you are on (a step on a project, the day in
  Planning, the folder in Notes).
- Orr reads the note, project, person or company you have open along with your
  question.
- Each shelf under the Projects board has its own address
  (`/projects?shelf=done`), next to the area filter's.
- A light ↔ dark button at the foot of the rail, above Find. On the phone, the
  theme stays in Settings.
- Every build writes `THIRD_PARTY_NOTICES_SERVER.txt` next to the web app's
  notices: every package the server and the MCP server run on, with its licence
  text.

### Changed

- In a step's card, a day alone now sets the step's due date (it used to plan it for a day
  nothing showed).
- A Notes folder with no notes says "No notes yet" with New note, instead of pointing at a
  Settings part that couldn't change the folder.
- "Looks recurring → Add it" opens the commitment filled in, to check before adding.
- Today's New → Subscription and Income use Money's sheet, with all eight rhythms, and say what
  Money says ("Spotify is in your commitments.").
- This machine's install no longer carries the Obsidian or Basalt name: the vault is
  `~/Orrama Vault`, the launchd agents are `dev.orrama.server` and `dev.orrama.vault-backup`, and
  logs go to `~/.orrama-run` (the server rotates `~/.orrama-run/server.log`). The plist template
  is `scripts/dev.orrama.server.plist`.
- Settings → Appearance asks for the look first (Paper or Clay), then light or dark (Day,
  Night, Match this device). Match this device works for either look.
- The rail's light ↔ dark button is now a sun and a moon at the top of the rail, in both looks;
  the lit one is the mode you're in.
- The rail holds the eight places (Today, Planning, Notes, Orrery, Projects,
  People, Mail, Money) with Find, Ask Orr and your Orr at the foot. Reload
  and Back left it: use ⌘R and the browser's Back.
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
- The Dashboard is now **Today**: today's timetable on top, with Orr standing
  on the present minute (he reads while you work, points when a meeting is
  near, sits in a free hour, dozes when the day is done), then Due, Mail,
  People today, Coming up, Projects, Money and Orr noticed.
- Due on Today leads with the next key deadline, then what's due or booked
  today, then what's late (least late first); ticking a box ticks the line in
  its note.
- Money on Today shows what this month has cost so far against a typical
  month; it opens that month under Spending.
- Customise (at the foot of Today) switches modules on and off; cards no
  longer drag or wobble.
- On a phone, Today's top bar shows the date, with New beside Find.
- The Mail dot in the rail now means Orr's drafts are waiting for you, not
  unread mail.
- Planning is redrawn: the week runs as lanes, one per life area, with
  deadlines and money above a horizon where Orr stands at now, and the next
  three weeks down the right. Hours shows the same week by the hour, with To
  plan beside it to drag from; the choice is remembered. Month and a single
  Day are tabs beside Week.
- One look for every time item in Planning: booked time, events, subscribed
  calendars (dashed), due days (a diamond), key deadlines (red) and Orr's
  proposals (hatched, with his head). Only late items are red.
- The task card opens beside what you clicked and takes a day, a time and a
  length by keyboard: type "sat 11:00" and press Enter. People are rings,
  companies squares.
- Planning's hour grid opens on the day's first item, and Plan my week says
  what it proposes in Orr's words, with Book and Not now.
- Notes is redrawn: the tree on the left with Pinned, Recent and your folders,
  the note in a white box, and beside it what the note is about, starting with
  its relations in words.
- With no note open, Notes shows Notes home: recent notes, pinned notes, your
  inbox, your counts (notes, conversations, open and done tasks) and your life
  areas. Notes opens on the note you had open last until you close it.
- The editor reads like the boards: bold and italic without their stars,
  bullets for list dashes, due dates as "today" or "3 days late", wide tables
  scroll sideways.
- Make this a project is offered on ordinary notes only, in the note's ···
  menu.
- The document reader slides in from the right like the other sheets.
- Overview is now **Projects**: one row per project with its next step,
  status, next date, key deadline and people; filter by life area; paused,
  cancelled, completed and archived projects sit on shelves under the board.
- A project's status uses the vault's seven words (planned, on track, at risk,
  paused, completed, archived, cancelled). Older words in a note (sleeping,
  planning, done, blocked…) are read as the word they mean.
- The project page has a new header: status as a menu, dates as text you can
  type ("19 Jan 2027"), the days left, the area and the steps, Add a step, and
  a ⋯ menu with Show in the Orrery.
- A project's Overview is one scroll: the note on the left; decisions, inbox,
  next steps, goals, people, conversations, documents and the prompt on the
  right.
- The Gantt moved from the Projects board into each project's Timeline ("Show
  the Gantt").
- Orr's suggested links on a project's Documents board are asked about one at
  a time: Link or No.
- Contacts is now **People**: people and companies side by side as rows, each
  with their role, company and how they relate to you ("supervises Graduation
  thesis"), and the last note that mentions them.
- One sector menu replaces People's row of sector chips, and lists only the
  sectors your contacts use.
- New person and New company say what went wrong under the form, and keep what
  you typed.
- Finance is now **Money**, in the new look: the overview shows this month's
  spending against a typical month, this month by category, saving, the
  month's commitments and income, with arrows (and ← →) to other months.
- Money's pages are tabs: Overview, Spending, Subscriptions, Income, Savings,
  Documents. Payslips are on Income.
- A spending category shows its year as columns; click a month to see where it
  went, shop by shop, and its purchases below.
- Spending categories take the five category colours in the order your
  spending-categories note lists them; the rest are grey "Other". The note's
  Colour column is no longer read.
- Months read "Sep 2026", not "Sep 26".
- Picking a project in Find opens the project, not its note.
- Today's Orr noticed names the first thing that needs a look instead of
  counting by kind.
- A person's or company's page replaces the sheet People used to open; the
  company's card is edited from its page.
- Ask is now Ask Orr: a panel beside the page (the centre tab on a phone).
  Answers are formatted, every note, person, company and project he names
  opens, and "How I found this" says each step he took and what it found.
- Capture is a small sheet; it says when the line is in your inbox, with a way
  to open it.
- Projects has one shelf for finished work, **Done**: completed and archived
  projects sit on it together, the most recently worked on first. A project's
  status in its note is unchanged.
- On a project's page, a person's or company's name opens their own page, as
  everywhere else. Taking them off the project is in the ⋯ menu at the end of
  their row (on a phone it always shows), behind the same confirmation.
- Every page shares one width (1,440 px of content) and sits centred beside the
  rail. On a big screen there is room on both sides, and pages line up with each
  other.
- A new note, or a note moved to a new name, must have a name every disk can
  hold: no `" * : < > ? |`, no trailing dot or space, no Windows device name
  (CON, NUL, COM1…). The New note dialog says why. Notes that already have such
  a name keep working.
- On a project's page, removing someone who is also linked in the note's text
  says that they stay listed, and why.

- Basalt is Orrama in the code as well as on screen: package names, the MCP
  server (`orrama-mcp`), the desktop app's name and window title (once
  rebuilt), the demo accounts (`@orrama.dev`, `orrama-demo`) and the export
  (`orrama-export-<time>/`).
- The settings variables are `ORRAMA_*` (`ORRAMA_VAULT_DIR`, `ORRAMA_DATA_DIR`,
  `ORRAMA_JWT_SECRET`, `ORRAMA_SECRET_KEY`, `ORRAMA_URL`, `ORRAMA_TOKEN`, …).
  The old `BASALT_*` names are no longer read, and a `BASALT_` variable left
  without its `ORRAMA_` twin stops the server, its scripts, the MCP server and
  the web dev server with a message naming it.
- AI estimates are kept per task, so ticking or editing one step no longer
  re-estimates every step.
- Orrama's licence is the GNU Affero General Public License v3.0 or later
  (`AGPL-3.0-or-later`, copyright Jules Timothy Sekelj), in place of Apache 2.0.
  You may use, change and share it; a changed copy you share, or run for other
  people over a network, must offer its source under the same licence. (The
  proprietary Personal and Company licences of 16 October were never released.)
- Live sync signs in when it connects, from the session cookie, and only from
  Orrama's own pages.

### Removed

- "How to change it?" and "also by Obsidian" in Settings → Notes; the terminal lesson for the
  password in Settings → You.
- Money's sentences that explained ledger tables and tags.
- The 2 October audit's write-up and tickets (`docs/audit/`) are no longer in the
  repository.
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
- The Dashboard's Vault overview, In focus, By category (the donut), Notes
  written, Saving and Money in and out cards (Money keeps saving and the
  ledgers; the counts moved to Notes home and Orr noticed).
- Planning's five stat tiles; "N due · N late" in the header opens To plan
  instead.
- The map's "Show" category select and its five chips in Notes (one life-area
  menu instead).
- The Projects board's per-project Gantt switch and its Sleep, Wake and Cancel
  buttons (now the ⋯ menu on a row and on the project page), and the P1 chip
  on a project's steps.
- The A–Z letter rail on the desktop People page (it stays on the phone).
- Finance's purple card and its own colours.
- The old search palette (note titles and paths only).
- "Ask your vault" and "a workspace owner" in Ask.
- "Today's summary" on Projects (Orr's digest of the board), and the server's
  digest behind it. Today already says what's due.
- The sheet a person or company opened in on a project's page (their own page
  has what it showed).
- The one-time move of an old sign-in into the secure cookie (from the 16 October
  release). A browser, window or phone not opened since then asks you to sign in
  again. A sign-in token left in its storage is deleted, never sent.

### Fixed

- The Projects board loads on a new install (it no longer needs a team).
- A new project starts as Planned, without the "No status yet" banner or an `active` tag.
- A step ticked on Today or on a person's page can be unticked (Undo in the toast).
- On a person's page, a step card's "from the note" opens the note.
- On a phone, switches were drawn as a large blob.
- Moving a note whose front matter couldn't be stamped kept its id (it got a new one, and lost
  its tasks and history).
- A narrower desktop window (roughly 800–1100 px) no longer breaks pages: Money goes to one
  column, Today to two, Projects keeps each project's name (the key deadline and people
  columns go), Planning's week keeps its seven days readable (the next three weeks go), box
  headings wrap whole instead of mid-phrase, and Planning no longer scrolls sideways.
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
- Asking Orr to add to a long note no longer cuts everything after its first
  2,000 characters. He reads the whole note before replacing it, and adds
  lines or rewrites one section without resending the rest. Claude Code's
  `edit_note` follows the same rules.
- The "OpenAI-compatible" provider works with Chat-Completions servers
  (Gemini's OpenAI URL, Ollama, LM Studio, vLLM, Groq) instead of answering
  "Not Found".
- "Put it on Wednesday" from Claude Code now books a block you can see in
  Planning, on Today and on the project's Timeline.
- Closing the Ask panel stops Orr's run on the server, and a provider that
  hangs stops after 2 minutes with a message.
- A stored AI key that can no longer be read (after a secret-key change) turns
  AI off instead of breaking Planning.
- Orr's search finds your longest notes.
- Orr can no longer write "due:next friday" (or a line break) into a task.
- A note with a stray `%` in a markdown link (`growth%.png`, `Budget 100%
  final.pdf`) vanished from the index and could not be saved; it is indexed
  and saves normally.
- Front-matter `tags: a, b` (or `a b`), `tag:`, `aliases: A, B` and `alias:`
  are read like Obsidian reads them.
- Notes with Windows (CRLF) line endings show their tasks and headings, and
  task and section edits keep CRLF.
- Tasks, tags and headings inside nested code fences (a ```` ``` ```` example
  inside `~~~` or ```` ```` ````) are no longer indexed.
- Checkboxes in `*`/`+` bullets, numbered lists (`1.`, `1)`) and
  callouts/blockquotes are tasks, as in Obsidian.
- `[[Note\|alias]]` inside a table links to Note; a `[[link]]` inside inline
  code is no longer a link.
- Life-area rules with a `/…/g` regex or a comma inside a regex categorise
  correctly.
- Today's timetable shows every block in your calendar, including blocks on
  tasks without an @mention.
- "Plan my week" no longer proposes work inside subscribed-calendar events
  that cross midnight or began before the week.
- Planning's at-risk flags no longer treat your @-mentioned and unmentioned
  tasks as two people working in parallel.
- Every row on Today can be opened from the keyboard.
- Planning a step for a day from its task card did nothing for a step that had
  never been booked.
- Typing is no longer lost when a save fails (for instance while Orrama
  restarts after an update): it is retried on its own, kept if you move to
  another note, kept on the device if the page closes, and offered back the
  next time you open the note. Reloading sends what you just typed.
- A note renamed or deleted in Obsidian while open no longer comes back as a
  duplicate under its old name when you type.
- Cmd-click on a link with an alias (`[[Note|label]]`) or a path opens the
  right note.
- Find can always reopen a note, also the one you arrived on after you moved
  on or closed it.
- Saving a note no longer reloads the whole note list twice.
- A project's next date on the Projects board is its next open step's, not the
  earliest date of any step, done or not.
- On a phone, task checkboxes were stretched into ovals.
- Dates no longer show as 08/31/2026 in the desktop app.
- `[[Kade Social]]` in a contact's company shows as Kade Social.
- Changing a contact's sector no longer writes into the note's body when the
  note has no front matter, and says so when the front matter can't be read.
- "de" names get the right initials ("Bram de Wit" → BW).
- A spending category with nothing in it no longer draws a chart of "Invalid"
  months.
- A subscribed calendar with old repeating events (a daily meeting since 2012,
  a feed that starts in 1900) no longer freezes Basalt; a repeating event with
  a malformed rule shows once instead of hiding the whole calendar.
- A calendar feed too complex to show in full shows what fits, and Settings →
  Connections says "too many repeating events, some are not shown".
- Opening a huge or crafted Word, Excel or PowerPoint file says it is too big
  to show instead of freezing or crashing the server.
- A PDF uploaded as a payslip that is long or heavy is kept, not read, and the
  upload says why, instead of freezing Basalt.
- The install guide's quickstart works: it sets the two secrets the server
  needs before starting it.
- `pnpm --dir apps/server dev` and `seed` use their own folder
  (`apps/server/data-dev`) and port (4627), so they can never open or replace
  the live database; `seed` refuses a vault that already holds notes.
- Docker self-host: the container starts on a fresh Linux host (it no longer
  crash-loops on a root-owned `./data`), reports its health, and is less than
  half the size.
- The desktop app no longer shows whatever happens to answer on port 4623:
  until Basalt's server answers, it shows "Basalt isn't running".
- On Windows, the vault's own CLAUDE.md is no longer indexed and stamped, and
  `pnpm dev` starts.
- A schema upgrade that fails stops the server with the statement that failed,
  instead of starting and failing later on a missing column.
- The window title and the phone's top bar say a person's name as written
  ("Ines Vermaat"), not the address in words ("Ines vermaat").
- Closing Ask, or stopping it, really stops Orr: nothing he was doing carries
  on.
- Stopping Orr, or reloading the page, while he was answering no longer stops
  the server.
- A failed capture no longer loses what you typed.
- Picking an area on Projects no longer reloads the whole board.
- A change that doesn't save is never silent: a toast says what didn't happen
  and why, with Retry when the server didn't answer; forms keep what you typed
  and their button comes back.
- Confirm dialogs (delete a document, remove a project from the board) stay open
  and say why when the server refuses, instead of closing as if it had worked.
- Mail no longer says "isn't connected" when the server didn't answer; it says
  so, with Retry.
- The project note on a project page says it didn't open, with Retry, instead of
  "Opening the note…" for ever.
- Planning's new-event popover keeps its title when the event didn't save.
- Sending a staged draft whose clean-up fails says the draft is still listed, so
  it isn't sent twice.
- Uploading a document whose name has `" * : < > ? |`, ends in a dot or a space,
  or is a name Windows keeps for a device (CON, NUL, COM1…) is refused with the
  reason, on every computer, so a vault made on the Mac still opens on Windows.
  On Windows such an upload failed, or for a device name stored nothing. Files
  already in your vault keep opening.
- Stopping the server closes the database after the vault watcher, not before (a
  file changed in the last moment could hit a closed database).
- The server's log rotates on Windows too (it truncated through a handle Windows
  opens append-only).
- A note titled only by an id (an old Claude session's "394a1725") is shown by
  its kind, date and first words, e.g. "Conversation, 4 Jun 2026: Tidying the
  reading list…", in Orr noticed, Today, Notes, Find, the Orrery, entity pages
  and the window title. The note itself is unchanged, and links and search still
  know it by its id.
- A project's To-do bar ends where its list ends; an entity page's note keeps a
  readable line length on wide screens.
- Planning, Today's task card and the project Timeline's card no longer wait
  on the AI estimate: the plan opens at once with the quick estimate, and the
  AI's numbers replace it quietly when they arrive (6 s → about 10 ms per load
  on a 100-task vault).
- A note created, renamed, moved or deleted outside Orrama at the moment a folder appeared or
  went anywhere in the vault (or just after the server started) could be missed until a
  restart. The vault is now read again a second after any such moment.
- Picking day or night, or Paper or Clay, right after the app opens is no longer undone.
  Before, the page showed your choice but your account and the next load kept the old one.
- On the lock screen, digits typed on the keyboard the moment the keypad appears are no
  longer lost.

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
- Orr and API tokens (Claude Code over MCP) can no longer write CLAUDE.md,
  AGENTS.md or `.claude/`, or change a project's Prompt: the instructions
  agents follow are yours to write.
- The vault's CLAUDE.md reaches Orr only for someone who can read it, and as
  your note, not as system instructions.
- No error log carries what was sent to or received from an AI provider (your
  notes once reached server.log that way).
- An `#only/<team>` restriction is kept when the front matter has a YAML error
  (e.g. an unquoted colon in the title), uses `tags: a, only/x` or `tag:`, or
  follows a one-line ```` ```js``` ```` or an indented ```` ``` ````; a
  restriction that cannot be read limits the note to owners instead of opening
  it.
- A `/regex/` in the life-area rules note can no longer freeze the server (it
  runs in a matcher that takes time linear in the text; backreferences and
  lookaround are not supported and are ignored).
- Opening an e-mail with a crafted address header no longer stalls the server
  for seconds (nodemailer 10 via mailparser).
- Calendar feeds, webhooks and mail servers given as an IPv6 address that
  wraps a private IPv4 (6to4, Teredo, NAT64, IPv4-compatible) are refused.
- A .md uploaded into a project's documents is created as a note under the
  same rules as New note; it can no longer place a note in a folder its
  uploader may not write.
- Docker publishes the server on this machine only (127.0.0.1); reaching it
  from elsewhere goes through Tailscale or a proxy (INSTALL.md).
- `export.json` no longer contains webhook URLs (a Slack or Discord hook URL
  is its credential): only the host and a four-character hint.
- Personal data removed from source comments, the demo seed and CLAUDE.md (a
  history rewrite follows after the audit).
- CI actions are pinned to commits and the workflow token is read-only.
- A project whose note lives outside `04-Projects/` can no longer be opened —
  documents, board, name — by someone who tags a note of their own with its
  key; the project's note is fixed when it is registered (ACL-002).
- The team dashboard no longer names projects you cannot read (ACL-004).
- Saving, moving or linking to a note you cannot read answers exactly as if
  there were no note: no "changed since it was opened", no "already exists",
  no locked link — and no way to confirm a private note's text by guessing its
  hash (ACL-005).
- Webhooks check the note again when the delivery goes out, so a note moved or
  restricted in the debounce window is not sent with its new path and title
  (ACL-007).
- A removed or renamed account's username is retired: nobody can sign up as it
  and inherit `Personal/<username>/` (ACL-010).
- Your events and time blocks are written to a calendar note no other account
  can read — `Personal/<you>/Calendar/` when another account could read
  `01-Me/` (ACL-009).
- Search result order no longer depends on notes you cannot read (ACL-008).
- Your sign-in is now kept in a secure cookie the page itself can't read,
  instead of in the browser's storage (WEB-013). Nothing to do: the first time
  the app opens after the update, it moves your existing sign-in over by
  itself. A write sent with that cookie from another site is refused.
- The MCP server is on a version of the MCP SDK (1.32.1) with no known high advisories
  (CI's dependency audit is green again).

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
- Planning's AI estimates are cached per task (at most 2,000, for 6 hours),
  and `GET /api/plan?refined=1` waits for the model's refinement.
- The MCP server's tools live in `apps/mcp/src/tools.ts`, testable from the
  server's tests; a fake Chat-Completions provider
  (`test/helpers/fakeChat.ts`) stands in for a model. `BASALT_AI_TIMEOUT_MS`
  (120 s) bounds an Ask run.
- New reads for the redesigned screens, each with a schema and a contract row:
  `GET /api/tasks` is typed, `GET /api/notes/overview` (Notes home's pins and
  counts), `GET /api/people/context` (each person's and company's relations
  and newest mention). `PATCH /api/contacts/:id` sets a contact's sector
  through core's front-matter writer.
- The contract test's scan for the web app's GETs reads every folder of
  `apps/web/src`, not only its top level.
- Finance's own tokens (`--fin-ground/-surface/-pos/-neg`, the `--cat-*` ramp)
  and three blocks of CSS no screen reads any more are gone.
- fastify 5.12.5, @fastify/jwt 10 (fast-jwt 6), drizzle-orm 0.45, imapflow
  1.7, MCP SDK 1.31; reviewed advisories listed in pnpm-workspace.yaml with
  their reasons; CI's `pnpm audit --prod --audit-level=high` now blocks.
- CI also runs on macOS for pushes to sep-2026-redesign, builds and boots the
  Docker image, lints the web app; `desktop.yml` checks the Tauri crate;
  `windows.yml` runs the suite on Windows by hand.
- `pnpm typecheck` re-runs when an upstream package changes (no stale cache
  pass before `pnpm ship`).
- `pnpm ship` succeeds only when a new server process reports the build it
  just made.
- The launchd plist in `scripts/` is a complete template; the web build ships
  third-party licence notices; `tsx` is a production dependency; Node types
  are 22.
- ESLint with the React hooks rules (`pnpm lint`).
- `store.projects(user)` takes the reader; `VaultStore.projectNote(key)` is
  the one way to the note a project is authorised against.
- `VaultIndex.resolveLink/resolveLinkOf` take `among`, the notes a link may
  name.
- Account removal is `removeAccount.ts` (remove-user.ts is its prompt);
  retired usernames are `usernames.ts`.
- The server suite runs green on Windows (windows.yml also runs the webhook
  tests 20 times in a row and starts the dev server); a test file that leaves a
  database open fails on every platform.
- Every MCP tool has a test of the request it sends and of the server's answer.
- ESLint's `orrama/async-handler-catches` refuses an async event handler that
  awaits outside a try/catch (WEB-010).
- The vault store schedules nothing once it starts closing, and re-loading it
  closes the watcher it replaces (no more "The database connection is not
  open" after a test run).
- The test suite is green on Windows again after the rename. A test that
  starts the server waits for it to exit before deleting its folder, and tests
  that start processes through tsx have timeouts that fit them.
- Two flaky web tests and two flaky server tests (path-identity) on macOS
  fixed. DOM tests unmount the page before they un-stub fetch, so a late
  request can't reach the real network; the toast test waits for the toast.
- A licence guard: a test fails on any production dependency whose licence is
  not on the permissive allowlist (no copyleft).
- DOM tests find what an effect renders instead of reading it at once.
  `pnpm --dir apps/web test:slow` runs them with React's scheduler late, as on a loaded runner.

### Upgrading

- Stage 1 wave 1: nothing to do. An existing database never sees the notes chooser (no
  first-run row), and with `ORRAMA_VAULT_DIR` set the notes folder is shown as fixed. Nothing is
  written into an existing vault until someone chooses in the app.
- Rename every `BASALT_` variable to `ORRAMA_` (same value) in the launchd
  plist, Docker's `.env` and the MCP server's config before starting this
  version. Browsers keep you signed in: what they stored under `basalt-…`
  moves to `orrama-…` on first load.
- The first start of this version encrypts every stored webhook secret and
  stamps the database as schema 3; an older build then refuses to open it, so
  take a database backup before shipping.
- Schema 4 (`projects.note_id`): a database opened by this build refuses to
  open in an older one. Existing projects are anchored to their note on first
  use.
- Reaching Orrama by a bare LAN or tailnet IP now needs that address in
  `ORRAMA_PUBLIC_ORIGINS`.
- A Touch ID passkey created as non-discoverable (unlikely on macOS) needs
  enrolling again.
- Project names now come from the project note's `title:` (unchanged when it
  has none). On the live vault three cards are renamed: Basalt → "Basalt —
  team knowledge tool", School Resits → "School Resits — June/July 2026",
  Graduation Internship → "Graduation Internship Search".
- Optional: the installed `~/Library/LaunchAgents/dev.basalt.server.plist` may
  run node directly as the template in `scripts/` does (pnpm passes SIGTERM on
  macOS too, so nothing breaks if it stays).
- A session token sent as `Bearer` is no longer accepted and `/api/auth/exchange`
  is gone (21 October). A browser, window or phone not opened between 16 and 21
  October signs in again once.

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
