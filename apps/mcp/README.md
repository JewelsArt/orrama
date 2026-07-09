# @basalt/mcp

Basalt MCP Server for Claude Code integration.

## Setup

1. Build the server: `pnpm --dir apps/mcp build`
2. Create an API token in your Basalt user settings (requires an owner account for full functionality in the embedded terminal).
3. Add the following to your `~/.claude.json` or `.mcp.json` in the vault root:

```json
{
  "mcpServers": {
    "basalt": {
      "command": "node",
      "args": ["path/to/basalt/apps/mcp/dist/index.js"],
      "env": {
        "BASALT_TOKEN": "bslt_your_api_token_here",
        "BASALT_URL": "http://localhost:4623"
      }
    }
  }
}
```
