# @basalt/mcp

Basalt MCP Server for Claude Code integration.

## Setup

1. Build the server: `pnpm --dir apps/mcp build`
2. Create an API token in Basalt under Settings → API tokens.
3. Register the server with Claude Code at user scope, so the token is stored
   in `~/.claude.json`:

```bash
claude mcp add basalt --scope user \
  --env BASALT_URL=http://localhost:4623 \
  --env BASALT_TOKEN=bslt_your_api_token_here \
  -- node /absolute/path/to/basalt/apps/mcp/dist/index.js
```

`BASALT_URL` is the address the server listens on (`PORT`, 4623 by default).

Keep the token out of the vault. Do not put it in a `.mcp.json` in the vault
root: that is the folder Obsidian Sync, iCloud or git copies elsewhere, and the
token reads and edits every note you can, and reads your mail. Basalt no longer
creates a `.mcp.json` there; if an older version left one, it holds only the
placeholder and can be deleted.

A token can read and write notes, tasks and projects, and stage mail drafts.
It cannot send mail, and it cannot manage sign-in methods, sessions, API tokens,
webhooks, the mail account or workspace settings. Those routes answer 403 to a
token, so a leaked token cannot turn itself into a session.
