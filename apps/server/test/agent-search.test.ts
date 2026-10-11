/**
 * search_vault finds long notes (audit AI-007).
 *
 * The packer charged each candidate's FULL length against a 24,000-character
 * budget and skipped any that did not fit, then sent only 2,000 characters
 * of each anyway. A note past 24k — a thesis, a running log, a yearly
 * ledger — was invisible to the agent however well it matched.
 */
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask, toolOutputs } from "./helpers/fakeChat.js";

const s = await bootAi("agent-search");
afterAll(() => s.close());
const jules = s.aclUser("jules");

const search = async (query: string) => {
  s.queue.push({ tool: "search_vault", args: { query } }, { text: "Done." });
  const r = await s.call("jules", "POST", "/api/ai/ask", ask(`search ${query}`));
  return toolOutputs(r.body)[0] as any[];
};

describe("search_vault", () => {
  it("returns a 30,000-character note that is the best match", async () => {
    const huge = s.built.store.write(jules, "Shared/Quokkaflux.md", `# Quokkaflux\n\n${"The quokkaflux measurements drift every winter. ".repeat(640)}\n`);
    expect(huge.content.length).toBeGreaterThan(30_000);
    const results = await search("quokkaflux");
    const hit = results.find((r) => r.path === "Shared/Quokkaflux.md");
    expect(hit).toMatchObject({ id: huge.id, truncated: true, length: huge.content.length });
    expect(hit.excerpt.length).toBe(2000);
  });

  it("charges the budget for what it sends, so twelve long matches all come back", async () => {
    for (let i = 0; i < 12; i++) s.built.store.write(jules, `Shared/Zebrafinch ${i}.md`, `# Zebrafinch ${i}\n\n${"zebrafinch song notes. ".repeat(400)}\n`);
    const results = await search("zebrafinch");
    expect(results.filter((r) => r.path.startsWith("Shared/Zebrafinch")).length).toBe(12);
    expect(results.reduce((n, r) => n + r.excerpt.length, 0)).toBeLessThanOrEqual(24_000);
  });
});
