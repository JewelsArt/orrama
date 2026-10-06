# KG — Knowledge graph
## Added (Phase 2, so far)
- `packages/core/src/ontology.ts`, `graph.ts` — the ontology as a `#vault-ontology` note (Types / Relations / Statuses / Rules tables) and `buildGraph`: typed entities, subject–relation–object facts with provenance, inverses, derived relations, constraint warnings. Pure; nothing stored. (commit: see git log)
- `packages/core/src/describe.ts` — `describeNote`, moved out of `routes/vault.ts`; a conversation's gist is Jules's opening message, not its header line; `Entity.summary`. (commit dedb6bb)
- Phase 4: `packages/core/src/graphQuery.ts` (vaultSchema, findEntities, getRelations, findPath, listSummaries); `apps/server/src/routes/graph.ts` (`GET /api/graph/{schema,entities,relations,path,summaries}`, ACL-first); schemas in `packages/schema/src/responses.ts` + 5 rows in `contract.test.ts`; MCP tools `vault_schema`, `find_entities`, `get_relations`, `find_path`, `list_summaries` (`apps/mcp/src/graphQuery.ts`); the same five on the in-app agent, and the agent's guide says query first. (commit: see git log)
## Changelog lines (user-facing, for [Unreleased] → Added)
- The vault can now be read as a knowledge graph: a `#vault-ontology` note defines types, relations and statuses, and Basalt derives typed facts from front matter, `key:: value` fields, the `## People` section and `project/<key>` tags. The MCP server and the in-app agent get five query tools — vault_schema, find_entities, get_relations, find_path, list_summaries — that answer from the graph in a fraction of the tokens a search-and-read takes; descriptions tell a model to query first and read last.
## CLAUDE.md changes to apply (exact text, and where)
- Layout table: add rows for `packages/core/src/ontology.ts` ("The vault's ontology as data: parses the `#vault-ontology` tables; `typeOfNote`") and `packages/core/src/graph.ts` ("`buildGraph`: typed facts with provenance, inverses, derived relations, warnings. Pure index; takes a `readable` filter that restricts BOTH ends of a fact").
- After "Life-areas … are vault data": a paragraph "The vault is also a knowledge graph" — ontology note, where relations are read from, project note = conventional `04-Projects/<slug>.md`, ACL on both ends.
## Not fixed (and why) / needs Jules
- Summaries: `list_summaries` of all ~100 conversations is ~32k characters (~8k tokens) — the first-pass estimate of 5k was low.
- `active` is an alias of `on-track`, so a project with only an `#active` tag reads as on-track (School Resits, LinkedIn).
## Files touched outside my ownership
- `apps/server/src/main.ts` (one import + one register line), `apps/server/src/routes/ai.ts` (five tools + guide lines), `apps/mcp/src/index.ts` (five tool definitions, one handler, two descriptions; audit S07 owns the MCP server), `packages/schema/src/responses.ts` (graph schemas, before the type exports), `apps/server/test/contract.test.ts` + `contract-fixtures.ts` (5 rows; an ontology note and three notes).
- `apps/server/src/routes/vault.ts` — the local `describe` replaced by core's `describeNote` (one hunk + import).
- Known flake: `new-folder-watch.test.ts` failed once under the full parallel run (passes alone, 3/3); not mine.
- `packages/core/src/index.ts` (two export lines). `parse.ts` / `vault.ts` untouched so far.
