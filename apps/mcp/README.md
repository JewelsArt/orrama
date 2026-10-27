# @orrama/mcp

Orrama's MCP server: your notes, steps, projects, people, calendar, money and
mail as tools for Claude (Claude Code, Claude Desktop), over Orrama's own API
with a personal token.

## Setup

1. Build the server: `pnpm --dir apps/mcp build`
2. Create an API token in Orrama under Settings → API tokens.
3. Register the server with Claude Code at user scope, so the token is stored
   in `~/.claude.json`:

```bash
claude mcp add orrama --scope user \
  --env ORRAMA_URL=http://localhost:4623 \
  --env ORRAMA_TOKEN=bslt_your_api_token_here \
  -- node /absolute/path/to/orrama/apps/mcp/dist/index.js
```

`ORRAMA_URL` is the address the server listens on (`PORT`, 4623 by default).

Keep the token out of the vault. Do not put it in a `.mcp.json` in the vault
root: that is the folder Obsidian Sync, iCloud or git copies elsewhere, and the
token reads and edits every note you can, and reads your mail. Orrama no longer
creates a `.mcp.json` there; if an older version left one, it holds only the
placeholder and can be deleted.

## The tools

Each tool calls a route the app's own screens use, so a token sees and changes
exactly what its owner can on screen: the server applies the same permissions
to every request (`apps/server/test/mcp-tools.test.ts` checks each tool with a
second account's token).

| | Tools |
|---|---|
| Finding things | `vault_schema` (start here), `find_entities`, `get_relations`, `find_path`, `list_summaries`, `search_notes`, `list_tree`, `read_note` |
| Notes | `edit_note` (create, or replace with the hash `read_note` gave), `append_to_note`, `move_note` (rename or move, links follow; or put in the trash) |
| Today and steps | `get_today` (the agenda, what's due, what to do next), `edit_task` (status, words, dates, priority, key deadline, move to a project or the inbox, delete), `schedule_block` (book time on a step) |
| Projects | `list_projects` (with your life areas), `get_project`, `create_project`, `update_project` (name, status, area, group, dates), `add_to_project` (a step, inbox line, decision or goal) |
| People | `get_contacts` (people and companies), `save_contact` (make or change a person or company, where someone works) |
| Calendar | `list_events`, `create_event` (place, notes, all day, repeating), `edit_event` (one day of a series or all of it; change or delete) |
| Money | `get_money` (read-only) |
| Mail | `list_email`, `read_email`, `draft_email` (a draft waits in Orrama for you to send) |

## What a token can't do

- **Send mail.** `draft_email` stages a draft; you read it and send it in Orrama.
- **Delete for good.** A note or person removed with `move_note` goes to the
  trash (Notes → Trash, where Restore brings it back); no tool empties it. A
  deleted step's line stays in the note's history.
- **Change your standing instructions**: a project's prompt, or CLAUDE.md,
  AGENTS.md and `.claude/` anywhere in the notes.
- **Change money.** `get_money` reads; ledgers are changed on Money's pages.
- **Touch credentials or settings**: sign-in methods, sessions, API tokens,
  webhooks, the mail account, the calendar feed link, the notes folder and
  workspace settings. Those routes answer 403 to a token, so a leaked token
  cannot turn itself into a session.
