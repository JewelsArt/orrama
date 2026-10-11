import { describe, expect, it } from "vitest";
import { HISTORY_KEY, HISTORY_MAX, readHistory, saveConversation, type SavedMessage } from "./history.js";

const ask = (id: string, text: string): SavedMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

describe("earlier questions, on this device", () => {
  it("keeps the newest first, one copy each, at most twenty", () => {
    for (let i = 0; i < HISTORY_MAX + 3; i++) saveConversation(`c-${i}`, [ask(`m-${i}`, `Question ${i}`)], 1000 + i);
    saveConversation("c-21", [ask("m-21", "Question 21"), ask("m-x", "and more")], 5000);
    const all = readHistory();
    expect(all).toHaveLength(HISTORY_MAX);
    expect(all[0]).toMatchObject({ id: "c-21", title: "Question 21", at: 5000 });
    expect(all.filter((c) => c.id === "c-21")).toHaveLength(1);
    expect(all.some((c) => c.id === "c-0")).toBe(false);
  });

  it("keeps the names a step shows and leaves note text and mail bodies behind", () => {
    saveConversation("c", [
      ask("q", "What's in the plan?"),
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "tool-read_note", toolCallId: "t1", state: "output-available", input: { note: "Research plan" }, output: { id: "n-1", title: "Research plan", path: "p.md", content: "SECRET NOTE TEXT", hash: "h" } },
          { type: "tool-search_vault", toolCallId: "t2", state: "output-available", input: { query: "plan" }, output: [{ id: "n-1", title: "Research plan", excerpt: "SECRET EXCERPT" }] },
          { type: "tool-write_note", toolCallId: "t3", state: "output-available", input: { path: "x.md", content: "SECRET WRITTEN TEXT" }, output: { success: true, id: "n-2", path: "x.md" } },
          { type: "tool-read_email", toolCallId: "t4", state: "output-available", input: { uid: 4 }, output: { success: true, subject: "Hi", body: "SECRET MAIL BODY" } },
          { type: "step-start" },
          { type: "text", text: "It says [[Research plan]]." },
        ],
      },
    ]);
    const stored = localStorage.getItem(HISTORY_KEY)!;
    expect(stored).not.toMatch(/SECRET/);
    const [c] = readHistory();
    expect(c!.messages[1]!.parts).toHaveLength(5);
    expect(c!.messages[1]!.parts[0]).toMatchObject({ output: { id: "n-1", title: "Research plan" }, input: { note: "Research plan" } });
    expect(c!.messages[1]!.parts[4]).toEqual({ type: "text", text: "It says [[Research plan]]." });
  });

  it("does not keep a conversation without a question, and reads a broken store as none", () => {
    expect(saveConversation("c", [])).toEqual([]);
    expect(localStorage.getItem(HISTORY_KEY)).toBeNull();
    localStorage.setItem(HISTORY_KEY, "{not json");
    expect(readHistory()).toEqual([]);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{ id: 1 }, { id: "ok", title: "t", at: 1, messages: [] }]));
    expect(readHistory().map((c) => c.id)).toEqual(["ok"]);
  });

  it("puts away a step that was still running as stopped", () => {
    saveConversation("c", [ask("q", "Go"), { id: "a", role: "assistant", parts: [{ type: "tool-search_vault", toolCallId: "t", state: "input-available", input: { query: "x" } }] }]);
    expect(readHistory()[0]!.messages[1]!.parts[0]).toMatchObject({ state: "output-error", errorText: "stopped" });
  });
});
