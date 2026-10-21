/**
 * What every list of steps shares (1B): a step's four states as the To-do's menu and the card
 * offer them, priority in words, and the tick with Undo that lists of open steps use.
 */
import { api, ApiError } from "./api.js";
import { toast } from "./ui/overlays.js";
import { attempt } from "./ui/writes.js";

/** A step's four states, as its card and the project To-do's menu offer them. */
export const STATUS_MENU: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];
export type TaskStatus = "todo" | "in-progress" | "blocked" | "done";

/**
 * Priority in words a person reads, for `!p1`–`!p3`. Kept quiet on purpose: the thesis marks
 * nearly every step `!p1`, so it is a choice on the card, never a colour. "None" is no token.
 */
export const PRIORITY_WORDS = [
  { id: "0", label: "None" },
  { id: "1", label: "High" },
  { id: "2", label: "Medium" },
  { id: "3", label: "Low" },
] as const;

/**
 * Tick a step from a list that shows open steps only (Today's Due, a person's page), or untick
 * one that is done: its box in its line. A ticked row leaves the list, so the tick says so with
 * Undo, which unticks it. A step that moved in its note since the list was drawn is said, and
 * the list is drawn again either way.
 */
export function tickStep(
  t: { noteId: string; line: number; blockId?: string | null; text: string; checked?: boolean; status?: string },
  said: { notTicked: string; moved: string; changed: () => void },
): Promise<boolean> {
  const done = !!t.checked || t.status === "done";
  return attempt(done ? said.notTicked.replace("ticked", "unticked") : said.notTicked, async () => {
    try {
      await api("POST", "/api/tasks/check", { noteId: t.noteId, line: t.line, ...(t.blockId ? { blockId: t.blockId } : {}), text: t.text, checked: !done });
      if (!done) toast(`Done: ${t.text}.`, { action: { label: "Undo", run: () => void tickStep({ ...t, checked: true, status: "done" }, said) } });
    } catch (e) {
      // Anything else (the server down, a 500) is said by attempt, with Retry (WEB-010).
      if (!(e instanceof ApiError && e.status === 409)) throw e;
      toast(said.moved);
    } finally {
      said.changed();
    }
  });
}

