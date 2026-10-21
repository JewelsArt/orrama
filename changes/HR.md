# HR: HTML reader for project documents

Jules, 21 Oct 2026: "I make quite a lot of artefacts. Are there any available artefacts reader we
could put in Orrama?" … "put these into a new tab. Overview, timeline, documents, to-do, reader or
something like that. you can add the html reader". Local copies of his claude.ai artifacts were filed
in each project's `files/` the same day (claude.ai can't be framed by other sites).

## Built
- `GET /api/projects/:slug/files/:name/page`: an .html/.htm document served as a page, under its own
  CSP with `sandbox` (no `allow-same-origin`: opaque origin, no session, no storage, no parent),
  scripts from the page itself and the five artifact CDNs, `eval` (Babel), `frame-ancestors 'self'`,
  `no-cache` + Last-Modified/304 (a canvas copy is 70 MB). Rules in `apps/server/src/pageSandbox.ts`.
- `HtmlPage.tsx`: the frame, with the same sandbox as an attribute (`HtmlPage.dom.test.tsx` reads the
  server's list and holds them equal).
- Project page: a **Reader** tab (`/projects/<slug>/reader?page=<file>`), shown only when the project
  has an .html document (or its address is open), counting them. `ProjectReader.tsx`: the pages by
  name beside the open one; "Open on claude.ai" when the note's Documents line links the file to an
  artifact (`projectPages.ts` `artifactLinks`); Full screen where the webview allows it.
- `DocViewer`: a project's .html opens as a page too (Documents board, Overview's Documents).
  Money's .html still offers the download (no page route there).

## Changelog lines
- Added: project pages. A project's .html documents (saved claude.ai artifacts, reports) open as the
  pages they are, in a new Reader tab and from Documents, sealed off from Orrama.

## CLAUDE.md changes to apply
- "The project workspace is the note", first paragraph: tabs list gains `…/reader`, and after the
  To-do bullet add:
  "- *Reader* (`ProjectReader.tsx`) — the project's .html documents, one at a time, the list beside
  it (`?page=<file>`); the tab shows only when there is one. Each runs in `HtmlPage`'s frame from
  `GET …/files/:name/page`, served under `PAGE_CSP` (`pageSandbox.ts`): a `sandbox` without
  `allow-same-origin`, so the page's scripts run in an opaque origin with no session (the cookie is
  SameSite=Strict), no storage and no reach into Orrama; scripts only from the page and the five
  artifact CDNs; framed by Orrama only. The frame's `sandbox` attribute must equal the server's list
  (`HtmlPage.dom.test.tsx`). "Open on claude.ai" comes from the note's Documents line naming the
  file in bold beside a claude.ai artifact link."
- Same section, the documents paragraph: "nothing scriptable is ever served inline" → "nothing
  scriptable is ever served inline, except an .html on its page route, sandboxed (Reader)".
- Conventions, the CSP bullet: add "The one exception is a project's .html page route, which sends
  its own policy (`pageSandbox.ts`)."

## Verified
- Server: `page-route.test.ts` (headers exact, sandbox has no same-origin or top-navigation, no
  `https:` or `'self'` in script-src, .htm, txt/svg refused, traversal/missing/no session, 304 and
  re-send after a change, raw route still downloads, read access on the project: mara, who cannot read
  Engineering/, gets 404 for a page that exists in an Engineering project, erin gets it). A row in
  `acl-second-account.test.ts` was tried first and dropped: its file did not exist, so it passed with
  the access check removed (sabotage S6 caught that).
- Web: `projectPages.test.ts`, `HtmlPage.dom.test.tsx`, `DocViewer.dom.test.tsx` (+2),
  `Project.dom.test.tsx` (+3), `ui/router.test.ts` (+2).
- Sabotage: 18 breaks, each caught (results in the commit message).
- Real engines, on a scratch vault (seed + a fictional project with copies of Orrama/Hollow artifacts
  and a probe page): WebKit (WKWebView, the desktop engine) and headless Chrome both show the probe
  page with script running, Chart.js from cdnjs loaded, origin `null`, and cookie, parent, storage,
  `/api` and other hosts all blocked. Hollow (React + Babel from jsDelivr) and the 68 MB redesign canvas
  (boards in nested frames) render in both. Phone width (390) checked in Chrome.
- The Claude desktop browser pane refuses any frame with a `sandbox` attribute that lacks
  `allow-same-origin` (ERR_BLOCKED_BY_CLIENT). That is the pane's own rule, not WebKit's or Chrome's;
  the attribute stays for defence in depth (it keeps the frame sealed across navigations inside it).

## Board vs app: differences left on purpose
- No mockup for this tab; built from the system (Row/RowList, LinkButton, EmptyState, the Sheet's
  head pattern). Tab named "Reader", Jules's word.

## Not done (and why) / needs Jules
- Not shipped: Jules's call (the control chat ships).
- Dark mode not screenshotted: the tab uses tokens only; the frame is white on purpose (a page's
  default canvas).

## Files touched outside my ownership
- `apps/server/src/routes/projects.ts` (one route), `apps/web/src/App.tsx` (passes `page`), `Project.tsx`, `DocViewer.tsx`, `ui/router.ts`,
  `styles/project.css`, `styles/reader.css`.
- `~/.claude/launch.json`: added `basalt-HR-server`/`basalt-HR-web` (4831/4832); the preview tool's
  per-folder limit was full, so the scratch server ran from a shell instead.
