import { describe, expect, it } from "vitest";
import { GRAPH_TOOLS, graphPath, isGraphTool } from "../src/graphQuery.js";

describe("graph tools → /api/graph", () => {
  it("each tool is its own endpoint", () => {
    expect(Object.keys(GRAPH_TOOLS)).toEqual(["vault_schema", "find_entities", "get_relations", "find_path", "list_summaries"]);
    expect(graphPath("vault_schema")).toBe("/api/graph/schema");
    expect(graphPath("list_summaries", { type: "conversation" })).toBe("/api/graph/summaries?type=conversation");
  });
  it("lists repeat the key, empty values go, values are escaped", () => {
    expect(graphPath("find_entities", { type: "company", where: ["location=Rotterdam", "sector=A&B"], status: "", text: undefined, limit: 5 })).toBe(
      "/api/graph/entities?type=company&where=location%3DRotterdam&where=sector%3DA%26B&limit=5",
    );
  });
  it("only the five names are graph tools", () => {
    expect(isGraphTool("find_path")).toBe(true);
    expect(isGraphTool("read_note")).toBe(false);
    expect(isGraphTool("toString")).toBe(false);
  });
});
