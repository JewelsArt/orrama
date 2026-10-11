/**
 * The agent never rebuilds a note from an excerpt (audit AI-001).
 *
 * search_vault showed each note cut to 2,000 characters with nothing saying
 * so, and write_note replaced the whole file. "Add X to my thesis note" made
 * the model write back the 2,000 characters it saw plus its line, and the
 * rest of the note was gone from the vault. Now search_vault says it cut,
 * read_note gives the whole text and its hash, replacing an existing note
 * needs that hash, and append_to_note / replace_section never resend text.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bootAi } from "./helpers/aiServer.js";
import { ask, lastToolResult, toolOutputs } from "./helpers/fakeChat.js";
import { mcpClient } from "./helpers/mcp.js";

const s = await bootAi("agent-notes");
afterAll(() => s.close());

const jules = s.aclUser("jules");
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i}: the thesis compares forecasting methods for NL and FR markets.`).join("\n\n");
const onDisk = (rel: string) => fs.readFileSync(path.join(s.vault, rel), "utf8");

describe("updating a long note through the agent", () => {
  const LONG = `# Thesis log\n\n${filler(70)}\n\nTAIL-MARKER: the last paragraph.\n`;

  it("writing back search_vault's excerpt plus a line is refused, and the tail survives", async () => {
    const note = s.built.store.write(jules, "Shared/Thesis log.md", LONG);
    expect(note.content.length).toBeGreaterThan(5000);
    let excerpt: any;
    s.queue.push(
      { tool: "search_vault", args: { query: "thesis log forecasting" } },
      (body) => {
        excerpt = (lastToolResult(body) as any[]).find((r) => r.path === "Shared/Thesis log.md");
        return { tool: "write_note", args: { path: "Shared/Thesis log.md", content: `${excerpt.excerpt}\n- added by the agent` } };
      },
      { text: "Done." },
    );
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("add 'added by the agent' to my thesis log"));
    expect(r.status).toBe(200);
    // What it was shown says it was cut, how long the note is, and which note.
    expect(excerpt).toMatchObject({ id: note.id, truncated: true, length: note.content.length });
    expect(excerpt.excerpt.length).toBe(2000);
    expect(excerpt.hash).toBeUndefined();
    const [, write] = toolOutputs(r.body);
    expect(write.success).toBe(false);
    expect(write.error).toMatch(/read_note/);
    expect(onDisk("Shared/Thesis log.md")).toContain("TAIL-MARKER");
    expect(onDisk("Shared/Thesis log.md")).not.toContain("added by the agent");
  });

  it("read_note gives the whole note and its hash, and a write with that hash keeps everything", async () => {
    s.queue.push(
      { tool: "read_note", args: { note: "Shared/Thesis log.md" } },
      (body) => {
        const read = lastToolResult(body);
        return { tool: "write_note", args: { path: read.path, content: `${read.content}- added with the hash\n`, hash: read.hash } };
      },
      { text: "Done." },
    );
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("add 'added with the hash'"));
    const [read, write] = toolOutputs(r.body);
    expect(read.content).toContain("TAIL-MARKER");
    expect(read.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(write.success).toBe(true);
    const text = onDisk("Shared/Thesis log.md");
    expect(text).toContain("TAIL-MARKER");
    expect(text).toContain("- added with the hash");
  });

  it("a hash from before the note changed is refused, and the change made since survives", async () => {
    s.queue.push(
      { tool: "read_note", args: { note: "Shared/Thesis log.md" } },
      (body) => {
        const read = lastToolResult(body);
        // Meanwhile, the user edits the note in Obsidian or the editor.
        s.built.store.write(jules, "Shared/Thesis log.md", `${onDisk("Shared/Thesis log.md")}EDITED-MEANWHILE\n`);
        return { tool: "write_note", args: { path: read.path, content: `${read.content}- stale write\n`, hash: read.hash } };
      },
      { text: "Done." },
    );
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("add 'stale write'"));
    const [, write] = toolOutputs(r.body);
    expect(write.success).toBe(false);
    expect(onDisk("Shared/Thesis log.md")).toContain("EDITED-MEANWHILE");
    expect(onDisk("Shared/Thesis log.md")).not.toContain("stale write");
  });

  it("replacing a note with much shorter text needs shrink: true", async () => {
    const shortened = (read: any) => `${read.content.slice(0, 1500)}\n[rest of the note unchanged]\n`;
    s.queue.push(
      { tool: "read_note", args: { note: "Shared/Thesis log.md" } },
      (body) => {
        const read = lastToolResult(body);
        return { tool: "write_note", args: { path: read.path, content: shortened(read), hash: read.hash } };
      },
      { text: "Done." },
    );
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("tidy my thesis log"));
    const [, write] = toolOutputs(r.body);
    expect(write.success).toBe(false);
    expect(write.error).toMatch(/shrink/);
    expect(onDisk("Shared/Thesis log.md")).toContain("TAIL-MARKER");
  });

  it("append_to_note adds a line, at the end or to a section, and changes nothing else", async () => {
    const before = onDisk("Shared/Thesis log.md");
    s.queue.push(
      { tool: "append_to_note", args: { note: "Shared/Thesis log.md", text: "- appended at the end" } },
      { tool: "append_to_note", args: { note: "Thesis log", text: "- a next step", section: "Next steps" } },
      { text: "Done." },
    );
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("note two things"));
    expect(toolOutputs(r.body).map((o) => o.success)).toEqual([true, true]);
    const after = onDisk("Shared/Thesis log.md");
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain("- appended at the end\n");
    expect(after).toMatch(/## Next steps\n\n- a next step\n/);
  });

  it("replace_section rewrites one section only", async () => {
    s.built.store.write(jules, "Shared/Plan.md", "# Plan\n\n## Goals\n\n- old goal\n\n## Notes\n\nkeep me\n");
    s.queue.push({ tool: "replace_section", args: { note: "Shared/Plan.md", section: "Goals", body: "- new goal" } }, { text: "Done." });
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("change the goal"));
    expect(toolOutputs(r.body)[0].success).toBe(true);
    expect(onDisk("Shared/Plan.md")).toBe("---\nid: " + s.built.store.index.getByPath("Shared/Plan.md")!.id + "\n---\n# Plan\n\n## Goals\n\n- new goal\n\n## Notes\n\nkeep me\n");
  });

  it("a note too long for one read comes in parts, without a hash", async () => {
    s.built.store.write(jules, "Shared/Huge.md", `${"x".repeat(70_000)}\nHUGE-END\n`);
    s.queue.push({ tool: "read_note", args: { note: "Shared/Huge.md" } }, (body) => ({ tool: "read_note", args: { note: "Shared/Huge.md", offset: lastToolResult(body).nextOffset } }), { text: "Done." });
    const r = await s.call("jules", "POST", "/api/ai/ask", ask("read the huge note"));
    const [first, second] = toolOutputs(r.body);
    expect(first.hash).toBeUndefined();
    expect(first.content.length).toBe(60_000);
    expect(second.content).toContain("HUGE-END");
    expect(second.nextOffset).toBeUndefined();
  });

  it("read_note answers 'no such note' for a note the asker cannot read", async () => {
    s.queue.push({ tool: "read_note", args: { note: "Engineering/Incident Runbook.md" } }, { text: "Done." });
    const r = await s.call("mara", "POST", "/api/ai/ask", ask("read the runbook"));
    const [out] = toolOutputs(r.body);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/not found|no such note/);
    expect(JSON.stringify(out)).not.toContain("Runbook\n");
  });
});

describe("MCP edit_note (Claude Code)", async () => {
  const mcp = await mcpClient(s.built.app, s.tokens.jules!);
  const BODY = `# Meeting log\n\n${filler(60)}\n\nMCP-TAIL\n`;
  const note = s.built.store.write(jules, "Shared/Meeting log.md", BODY);

  it("replacing an existing note without the hash read_note gave is refused", async () => {
    const r = await mcp.tool("edit_note", { idOrPath: "Shared/Meeting log.md", content: `${BODY.slice(0, 2000)}\n- added` });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read_note/);
    expect(onDisk("Shared/Meeting log.md")).toContain("MCP-TAIL");
  });

  it("with the hash, the whole note is replaced; a much shorter text needs shrink", async () => {
    const read = (await mcp.tool("read_note", { idOrPath: note.id })).json;
    expect(read.hash).toBeTruthy();
    const short = await mcp.tool("edit_note", { idOrPath: note.id, content: `${read.content.slice(0, 1000)}\n[rest unchanged]\n`, hash: read.hash });
    expect(short.isError).toBe(true);
    expect(short.text).toMatch(/shrink/);
    const ok = await mcp.tool("edit_note", { idOrPath: note.id, content: `${read.content}- added over MCP\n`, hash: read.hash });
    expect(ok.isError).toBeUndefined();
    expect(onDisk("Shared/Meeting log.md")).toMatch(/MCP-TAIL\n- added over MCP\n$/);
  });

  it("a stale hash is refused, and the change made since survives", async () => {
    const read = (await mcp.tool("read_note", { idOrPath: "Shared/Meeting log.md" })).json;
    s.built.store.write(jules, "Shared/Meeting log.md", `${onDisk("Shared/Meeting log.md")}MEANWHILE\n`);
    await expect(mcp.tool("edit_note", { idOrPath: "Shared/Meeting log.md", content: `${read.content}- stale\n`, hash: read.hash })).rejects.toThrow(/409/);
    expect(onDisk("Shared/Meeting log.md")).toContain("MEANWHILE");
    expect(onDisk("Shared/Meeting log.md")).not.toContain("- stale");
  });

  it("a path spelled differently from the note's is never a blind replace", async () => {
    await expect(mcp.tool("edit_note", { idOrPath: "shared/meeting log.md", content: "overwritten" })).rejects.toThrow(/409/);
    expect(onDisk("Shared/Meeting log.md")).toContain("MCP-TAIL");
  });

  it("a new path creates the note", async () => {
    const r = await mcp.tool("edit_note", { idOrPath: "Shared/New from MCP.md", content: "hello\n" });
    expect(r.isError).toBeUndefined();
    expect(onDisk("Shared/New from MCP.md")).toContain("hello");
  });
});

