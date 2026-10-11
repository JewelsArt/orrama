import { describe, expect, it } from "vitest";
import { callTool, TOOLS } from "../src/tools.js";

describe("the tool list and the handlers", () => {
  it("every listed tool has a handler, and an unknown name is refused", async () => {
    const api = async () => ({});
    for (const t of TOOLS) {
      await expect(callTool(t.name, {}, api).catch((e) => e), t.name).resolves.not.toMatchObject({ message: expect.stringContaining("Unknown tool") });
    }
    await expect(callTool("no_such_tool", {}, api)).rejects.toThrow(/Unknown tool/);
  });
});
