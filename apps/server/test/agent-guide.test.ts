/**
 * The vault's CLAUDE.md reaches the agent only for a user who can read it,
 * and never as system prompt (audit AI-002; Jules's call, 11 Oct: keep it,
 * through the ACL, as a marked note).
 *
 * It was read raw from disk into every asker's system prompt: a note under
 * `#only/marketing` that erin (engineering) gets a 404 for went whole into
 * her model context, where she could ask the agent to repeat it. Permission
 * rule 5: AI retrieval filters through the core ACL like every surface.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask } from "./helpers/fakeChat.js";

const s = await bootAi("agent-guide");
afterAll(() => s.close());

const guidePath = path.join(s.vault, "CLAUDE.md");
/** Ask as `who`; returns the system message and the first user message the provider received. */
const sent = async (who: string) => {
  const r = await s.call(who, "POST", "/api/ai/ask", ask("hi"));
  expect(r.status).toBe(200);
  const msgs: any[] = s.llm.requests.at(-1)!.body.messages;
  return { system: JSON.stringify(msgs.filter((m) => m.role === "system")), user: JSON.stringify(msgs.find((m) => m.role === "user")), all: JSON.stringify(msgs) };
};

describe("the vault's CLAUDE.md in Ask", () => {
  it("an #only/marketing CLAUDE.md stays out of a non-member's model context", async () => {
    fs.writeFileSync(guidePath, "---\ntags: [only/marketing]\n---\nMarketing-only: SECRET-MKT-PLAN-42 launch price is 9.99\n");
    const erin = await sent("erin");
    expect(erin.all).not.toContain("SECRET-MKT-PLAN-42");
    // A member and the owner get it.
    expect((await sent("mara")).all).toContain("SECRET-MKT-PLAN-42");
    expect((await sent("jules")).all).toContain("SECRET-MKT-PLAN-42");
  });

  it("an unrestricted CLAUDE.md is read by anyone the vault root is open to", async () => {
    fs.writeFileSync(guidePath, "I am Jules. GUIDE-MARKER: be brief.\n");
    expect((await sent("erin")).all).toContain("GUIDE-MARKER");
  });

  it("arrives as a marked note in the user's first message, not in the system prompt", async () => {
    fs.writeFileSync(guidePath, "GUIDE-MARKER: be brief.\n");
    const jules = await sent("jules");
    expect(jules.system).not.toContain("GUIDE-MARKER");
    expect(jules.user).toContain('<note path=\\"CLAUDE.md\\">');
    expect(jules.user).toContain("GUIDE-MARKER");
    // The user's own words are still there, after it.
    expect(jules.user.indexOf("GUIDE-MARKER")).toBeLessThan(jules.user.lastIndexOf("hi"));
  });

  it("no CLAUDE.md, no note block", async () => {
    fs.rmSync(guidePath);
    expect((await sent("jules")).all).not.toContain('path=\\"CLAUDE.md\\"');
  });
});
