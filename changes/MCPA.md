# MCPA: the MCP tools brought to stage 1's model (stage 2, wave 3)

Branch `stage2/MCPA-mcp-audit` from `sep-2026-redesign` e17c3b5. Only `apps/mcp` and two
server test files change; no server route, schema or web code.

## Built

- `apps/mcp/src/tools.ts`: 24 tools → 28. Every tool checked against the routes and data
  stage 1 left; stale ones fixed, five merged or replaced, nine added (Jules's choices below).
- `apps/mcp/test/requests.test.ts`: a row per tool pinning the request it sends (every
  declared argument reaches it), plus each new tool's refusals and edge cases; a check that
  no tool names a route a token is refused (tokens, auth, webhooks, mail account and send,
  settings, admin, the feed link, Empty trash).
- `apps/server/test/mcp-tools.test.ts` rewritten: every tool against a real server, a
  `does` with Jules's token and a `refuses` with Mara's (what she can't read, or can read
  but not change); the last test fails if a tool lacks either.
- `apps/server/test/agent-instructions.test.ts`: `log_decision` → `add_to_project`, plus
  `update_project`, and the prompt still unchanged after them.
- `apps/mcp/README.md` (the tools, what a token can't do), package description.
- **Bug found live, fixed** (`apps/mcp/src/http.ts`, out of `index.ts`): the MCP server sent
  `Content-Type: application/json` on every request, so a DELETE with no body was a 400
  from Fastify ("Body cannot be empty…"): deleting an event over MCP never worked. The
  header now goes with a body only. The server tests' helper (`test/helpers/mcp.ts`) now
  calls the MCP server's own client with `fetch` handed to `app.inject`, so its headers
  are what the tests exercise (they used their own client before and missed this);
  `apps/mcp/test/http.test.ts` pins it.

### The audit (what was stale)

| Tool | Stage 1 changed | Now |
|---|---|---|
| `create_project` | `domain` enum (personal/professional/academic) → your own life areas | `area` (name or id); says a taken name gets the next free slug |
| `list_projects` | said "life-area domain"; Claude couldn't see the areas | `{ areas, projects }`: the area list (id, name, catch-all, project count) and each project's area, group, status, dates, next due, overdue (no `domain`, `noteId`) |
| `get_dashboard` | needed a team; a new install has none (teams come back in stage 5) | replaced by `get_today` (`/api/home`) |
| `check_task`, `set_task_status`, `set_task_dates` | the step card (`/api/tasks/edit`, `/move`, `/delete`) added words, priority, key deadline, move, delete; a date couldn't be cleared (null) | one `edit_task` |
| `log_decision` | projects gained inbox → step, goals one line at a time | `add_to_project` (step with due/priority/key, inbox, decision, goal) |
| `create_event` | events gained place, notes, all-day, repeat | all of them; plus `list_events`, `edit_event` |
| `get_contacts` | companies are first-class (works at = `companyId`) | `{ people, companies }` |
| descriptions | "Dashboard and Timeline", "notes tagged", "the vault tree" | Today and Planning; list_tree says the trash isn't listed; edit_note/append_to_note point at move_note, save_contact, add_to_project |

Unchanged and current: the five graph tools, `search_notes` (filters now named: tag, path,
task, assignee; 50 hits), `read_note`, `edit_note`, `append_to_note`, `schedule_block`,
`get_project`, `list_email`, `read_email`, `draft_email`.

### New tools

`move_note` (rename/move with links following; or `trash: true`), `get_today`, `edit_task`,
`update_project` (name, status, area, group, start, deadline; never the prompt),
`add_to_project`, `save_contact` (person or company: make with the New person/company
template create-only, then the page's own PATCH; works-at by a company's name or id, never
a name no note has), `list_events` (≤ a year), `edit_event` (one day or the series; change
or delete), `get_money` (read-only, `/api/finance` less its ledger tables, file list,
per-row activity and per-shop lists).

### Verified

- `apps/mcp`: 71 tests (requests 61, http 3, auth, env, graph). `apps/server/test/mcp-tools.test.ts`:
  57 (28 × does/refuses + the coverage check). `agent-instructions`, `agent-notes`,
  `agent-schedule` green through the new helper.
- Sabotage (`sab_multi.py`, sab.py with several edits per run; script and list in the
  session's scratchpad, results below): 20 tool-side breaks, each red in the request test and
  (where the server sees it) the server test; 9 server-side ACL breaks — viewers can edit,
  anyone reads `Personal/`, folders with no grant readable, anyone edits `Personal/`, events
  without the owner check, events listed for every owner, drafts listed for everyone, drafts
  staged on anyone's account, money from anyone's `Personal/` — each red in
  `mcp-tools.test.ts`; "anyone edits `Personal/`" went red only after a read-only shared
  contact was added to `save_contact`'s refusal (before, every `Personal/` note in the test
  was unreadable to Mara, so the read check answered first), and "events without the owner
  check" alone stays green because the calendar note's own ACL refuses Mara's write too
  (red with both removed). The HTTP fix: header always JSON → red in `http.test.ts` and
  `mcp-tools.test.ts`; errors without the server's words → red in both. All files restored
  byte-identical.
- Live: the real MCP process over stdio (`tsx src/index.ts`, `initialize`, `tools/list` = 28,
  then 17 calls) against a `--dev` server on seeded scratch data at :4849
  (`~/basalt-scratch/MCPA`) with a token minted there: create/update a project in an area,
  a step with due/priority/key edited, a company and a person who works there, a weekly
  event listed per day and one day deleted, Today, money, a note to the trash, mail without
  an account, an old tool name refused. That run found the DELETE bug above; re-run green.
  Server stopped by its PID, token file deleted. Never :4623 or the real vault.

## Changelog lines

- Changed: Orrama's MCP tools follow stage 1: `create_project` takes one of your life areas,
  `list_projects` lists the areas too, `get_contacts` lists companies, events can have a
  place, notes, all day and repeat. One `edit_task` changes a step as its card does
  (status, words, dates, priority, key deadline, move to a project or the inbox, delete),
  replacing `check_task`, `set_task_status` and `set_task_dates`; `add_to_project` adds a
  step, inbox line, decision or goal, replacing `log_decision`; `get_today` replaces
  `get_dashboard`, which needed a team.
- Added: MCP tools `move_note` (rename, move, or to the trash), `update_project`,
  `save_contact`, `list_events`, `edit_event`, `get_money` (read-only).

## CLAUDE.md changes to apply

- "The project workspace is the note", last paragraph: "the MCP tools `list_projects` /
  `get_project` / `log_decision` hand the same payload" → "the MCP tools `list_projects` /
  `get_project` hand the same payload".
- "Projects are bound by tag", end: "(no team: every project the requester can see;
  `/api/dashboard/<team>` stays for MCP's `get_dashboard`)" → "(no team: every project the
  requester can see; `/api/dashboard/<team>` stays for the permission tests)".
- "A step is changed in its card", end: "`/api/tasks/schedule` stays for old data and MCP." →
  "`/api/tasks/schedule` stays for old data. MCP's `edit_task` is the card over a token:
  `/edit`, then `/move` naming the step as the edit left it, or `/delete` alone."
- "API tokens are the weaker credential", add after the first sentence: "The MCP tools
  (`apps/mcp/src/tools.ts`) only call routes the screens use; `apps/server/test/mcp-tools.test.ts`
  holds each tool to a test of what it does and of what a second account's token can't do
  with it, and a new tool gets both."

## Not done (and why) / follow-ups

- **The in-app agent (`routes/ai.ts`) is unchanged**: its `create_project` still takes
  `domain` and still refuses a taken key (stage 1 Z note), and it has its own
  `set_task_status`/`set_task_dates`. Same audit for Orr belongs with 2L.
- **A token can still empty the trash** (`POST /api/vault/trash/empty` is not
  `sessionOnly`). No tool calls it (the request test pins that), but a leaked token could
  delete for good. Making it session-only is a one-line server change plus a token-gate row:
  Jules's call.
- No tool for life-area edits (Settings → Notes stays the place), project delete/trash,
  money writes, note history or restoring from the trash (Jules, 27 Oct: keep it small).
- `apps/mcp` version stays 0.1.0 (the release bumps all thirteen places together).
- Registration and Jules's MCP config untouched; 2M ships the server in the app.

## Jules's answers (27 Oct, question tool)

- Steps: one `edit_task` replacing the three (recommended).
- Projects: `update_project` + `add_to_project` (replaces `log_decision`); areas in
  `list_projects`; no trash from MCP (recommended).
- Notes and people: `move_note` and `save_contact` (both recommended).
- Calendar (`list_events`, richer `create_event`, `edit_event`), `get_today` replacing
  `get_dashboard`, `get_money` read-only; no money writes (all recommended).

## Files touched outside my ownership

- `apps/server/test/mcp-tools.test.ts`, `apps/server/test/agent-instructions.test.ts`,
  `apps/server/test/helpers/mcp.ts` (tests only; no server source changed).
