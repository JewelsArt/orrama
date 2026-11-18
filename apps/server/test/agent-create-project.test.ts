/**
 * Ask Orr's create_project does what New → Project does (2L, stage 1's leftover): a name
 * whose key is taken gets the next free key, `garden-2`, instead of "a project with that
 * name already exists". Both go through `createProject` (routes/projects.ts), so the same
 * name gives the same key from the screen, MCP and the agent.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask, toolOutputs } from "./helpers/fakeChat.js";

const s = await bootAi("agent-create-project");
afterAll(() => s.close());

const agentMakes = async (name: string) => {
  s.queue.push({ tool: "create_project", args: { name } }, { text: "Made." });
  const r = await s.call("jules", "POST", "/api/ai/ask", ask(`make a project called ${name}`));
  return toolOutputs(r.body)[0];
};

describe("Ask Orr's create_project", () => {
  it("a free name: the project note at its own key", async () => {
    const out = await agentMakes("Garden");
    expect(out).toMatchObject({ success: true, path: "04-Projects/garden.md", key: "project/garden" });
    expect(fs.existsSync(path.join(s.vault, "04-Projects", "garden.md"))).toBe(true);
  });

  it("a taken key: the next free one, as the screen gives, and the first project is untouched", async () => {
    const before = fs.readFileSync(path.join(s.vault, "04-Projects", "garden.md"), "utf8");
    const out = await agentMakes("Garden");
    expect(out).toMatchObject({ success: true, path: "04-Projects/garden-2.md", key: "project/garden-2" });
    expect(fs.readFileSync(path.join(s.vault, "04-Projects", "garden.md"), "utf8")).toBe(before);
    // The screen, asked for the same name now, moves on to the key after.
    const screen = await s.call("jules", "POST", "/api/projects", { name: "Garden" });
    expect(screen.json).toMatchObject({ ok: true, slug: "garden-3", key: "project/garden-3" });
  });

  it("a note already at the conventional path in another case is never replaced", async () => {
    fs.writeFileSync(path.join(s.vault, "04-Projects", "Shed.md"), "# My shed\n");
    // Just saved in Obsidian: on disk, maybe not indexed yet. The create is create-only either way.
    const out = await agentMakes("Shed");
    expect(out).toMatchObject({ success: true, key: "project/shed-2" });
    // Never replaced by the scaffold (an id stamped by the index is the only change it may see).
    const shed = fs.readFileSync(path.join(s.vault, "04-Projects", "Shed.md"), "utf8");
    expect(shed).toMatch(/^(---\nid: n-[a-z0-9]+\n---\n)?# My shed\n$/);
  });

  it("an empty name is told to the model, not thrown", async () => {
    const out = await agentMakes("   ");
    expect(out).toMatchObject({ success: false, error: expect.stringMatching(/name required/) });
  });
});
