/**
 * Standing instructions are the user's to write, never an agent's (audit AI-003).
 *
 * Some text becomes instructions for an agent: a `CLAUDE.md` / `AGENTS.md`
 * (Claude Code loads it as project instructions when run in the vault, and
 * Ask reads the vault's own as grounding), anything under `.claude/`, and a
 * project note's `## Prompt`, which MCP `get_project` hands to Claude Code as
 * the instructions its owner wrote. The agent reads text nobody vetted — mail,
 * notes anyone can write — so one prompt injection that got it to write there
 * would become a rule every later session obeys, Claude Code's included, with
 * a shell. Prompt text cannot be relied on to stop that (CLAUDE.md, "The agent
 * can draft mail, never send it"), so it is refused in code: the in-app agent
 * and API tokens (the MCP server) may not write those files or change that
 * section. The user still edits all of it in Basalt or Obsidian. Settings → AI
 * instructions is the third channel; `/api/admin/*` is session-only already.
 */
import { parseNote, projectSlugOf, readSection } from "@basalt/core";
import { HttpError, type WriteGuard } from "./vaultStore.js";

const INSTRUCTION_FILES = new Set(["claude.md", "claude.local.md", "agents.md"]);

/** A file an agent loads as its instructions, in any folder and any letter case (APFS folds case). */
export function isInstructionFile(rel: string): boolean {
  const parts = rel.split("/");
  return INSTRUCTION_FILES.has(parts[parts.length - 1]!.toLowerCase()) || parts.some((p) => p.toLowerCase() === ".claude");
}

const isProjectNote = (content: string) => parseNote(content).tags.some((t) => t.line === 0 && projectSlugOf(t.tag) !== null);

/** The guard for a writer that is not the user at the keyboard: `who` says which, in the refusal. */
export function untrustedWriter(who: string): WriteGuard {
  return ({ path, before, content }) => {
    if (isInstructionFile(path)) {
      throw new HttpError(403, `${path} holds standing instructions for an agent, so ${who} may not write it. The user can edit it in Basalt or Obsidian.`);
    }
    const project = isProjectNote(content) || (before !== null && isProjectNote(before.content));
    if (project && readSection(before?.content ?? "", "Prompt") !== readSection(content, "Prompt")) {
      throw new HttpError(403, `A project's ## Prompt is its standing instructions for agents, so ${who} may not change it. The user can edit it on the project page or in Obsidian.`);
    }
  };
}

export const agentWriter = untrustedWriter("the agent");
export const tokenWriter = untrustedWriter("an API token");

/** Both guards, in order; either may refuse. */
export const both =
  (a: WriteGuard, b: WriteGuard): WriteGuard =>
  (w) => {
    a(w);
    b(w);
  };
