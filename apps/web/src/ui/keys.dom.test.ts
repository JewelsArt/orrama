/**
 * The key router (structure.md §1.5). WEB-003: ⌘← and ⌘[ went back even while typing, so line
 * start and outdent left the note and ⌘← in the Mail composer threw the message away.
 */
import { describe, expect, it } from "vitest";
import { isTyping, shellKey, type KeyLike } from "./keys.js";

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...mods });
const cmd = { metaKey: true };

describe("shellKey", () => {
  it("1–8 open the eight places, in rail order", () => {
    expect(["1", "2", "3", "4", "5", "6", "7", "8"].map((d) => (shellKey(k(d), false, false) as { place: string } | null)?.place)).toEqual([
      "today",
      "planning",
      "notes",
      "orrery",
      "projects",
      "people",
      "mail",
      "money",
    ]);
    expect(shellKey(k("9"), false, false)).toBeNull();
  });

  it("⌘[ and ⌘← go back from the page (Ctrl off a Mac)", () => {
    expect(shellKey(k("[", cmd), false, false)).toEqual({ kind: "back" });
    expect(shellKey(k("ArrowLeft", cmd), false, false)).toEqual({ kind: "back" });
    expect(shellKey(k("[", { ctrlKey: true }), false, false)).toEqual({ kind: "back" });
  });

  it("never while typing: ⌘← is line start and ⌘[ outdent (WEB-003)", () => {
    expect(shellKey(k("ArrowLeft", cmd), true, false)).toBeNull();
    expect(shellKey(k("[", cmd), true, false)).toBeNull();
    expect(shellKey(k("ArrowLeft", { ctrlKey: true }), true, false)).toBeNull(); // word left elsewhere
  });

  it("nor when the key was already handled, nor with Shift or Alt (select to line start)", () => {
    expect(shellKey(k("[", { ...cmd, defaultPrevented: true }), false, false)).toBeNull();
    expect(shellKey(k("ArrowLeft", { ...cmd, shiftKey: true }), false, false)).toBeNull();
    expect(shellKey(k("ArrowLeft", { ...cmd, altKey: true }), false, false)).toBeNull();
  });

  it("⌘K and ⌘J work from anywhere, typing included", () => {
    expect(shellKey(k("k", cmd), true, true)).toEqual({ kind: "find" });
    expect(shellKey(k("K", cmd), false, false)).toEqual({ kind: "find" });
    expect(shellKey(k("j", cmd), true, false)).toEqual({ kind: "ask" });
  });

  it("c captures, ? lists the keys, ⌘, opens Settings", () => {
    expect(shellKey(k("c"), false, false)).toEqual({ kind: "capture" });
    expect(shellKey(k("?", { shiftKey: true }), false, false)).toEqual({ kind: "keys" });
    expect(shellKey(k(",", cmd), false, false)).toEqual({ kind: "settings" });
  });

  it("single keys stand down while you type, and the shell's keys while an overlay is open", () => {
    expect(shellKey(k("c"), true, false)).toBeNull();
    expect(shellKey(k("3"), true, false)).toBeNull();
    expect(shellKey(k("3"), false, true)).toBeNull();
    expect(shellKey(k("[", cmd), false, true)).toBeNull();
    expect(shellKey(k("c", cmd), false, false)).toBeNull(); // ⌘C is copy
  });
});

describe("isTyping", () => {
  const el = (html: string, pick: string) => {
    document.body.innerHTML = html;
    return document.querySelector(pick);
  };
  it("is true in text fields, selects, contenteditable and the editor", () => {
    expect(isTyping(el("<input>", "input"))).toBe(true);
    expect(isTyping(el('<input type="search">', "input"))).toBe(true);
    expect(isTyping(el("<textarea></textarea>", "textarea"))).toBe(true);
    expect(isTyping(el("<select></select>", "select"))).toBe(true);
    expect(isTyping(el('<div contenteditable="true"><p>x</p></div>', "p"))).toBe(true);
    expect(isTyping(el('<div class="cm-editor"><div class="cm-line">x</div></div>', ".cm-line"))).toBe(true);
  });
  it("is false on buttons, checkboxes, links and the page", () => {
    expect(isTyping(el("<button>x</button>", "button"))).toBe(false);
    expect(isTyping(el('<input type="checkbox">', "input"))).toBe(false);
    expect(isTyping(el('<a href="#">x</a>', "a"))).toBe(false);
    expect(isTyping(document.body)).toBe(false);
    expect(isTyping(window)).toBe(false);
  });
});
