/**
 * The Overview project head must not nest one control inside another.
 *
 * It was a single <button> wrapping the Sleep/Cancel/Wake buttons (and a
 * role="link" name and a role="switch" Gantt toggle): invalid HTML, a React
 * DOM-nesting warning on every board render, and controls a screen reader
 * cannot reach on their own. Rendered to static markup in every state the
 * board can show, then walked tag by tag.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverviewHead } from "./OverviewHead.js";

const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea"]);
const INTERACTIVE_ROLES = /\brole="(button|link|switch|checkbox|menuitem|option|tab)"/;

/** Every interactive element that sits inside another one, as "outer > inner". */
function nestedControls(html: string): string[] {
  const stack: { tag: string; interactive: boolean; label: string }[] = [];
  const found: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs = "", selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const interactive = INTERACTIVE_TAGS.has(tag!) || INTERACTIVE_ROLES.test(attrs) || /\btabindex=/i.test(attrs);
    const label = `${tag}${/class="([^"]*)"/.exec(attrs)?.[1]?.replace(/^/, ".") ?? ""}`;
    const outer = stack.find((s) => s.interactive);
    if (interactive && outer) found.push(`${outer.label} > ${label}`);
    if (!selfClosing) stack.push({ tag: tag!, interactive, label });
  }
  return found;
}

const base = {
  name: "Thesis",
  pct: 40,
  donePct: 40,
  workPct: 10,
  nextDue: "2026-10-19",
  onToggle: () => {},
  onToggleGantt: () => {},
  onLifecycle: () => {},
  onCancel: () => {},
};

describe("OverviewHead", () => {
  const states = {
    active: { ...base, open: true, parked: false, sleeping: false, gantt: false, onOpenProject: () => {} },
    "active, gantt on, folded": { ...base, open: false, parked: false, sleeping: false, gantt: true, onOpenProject: () => {} },
    sleeping: { ...base, open: true, parked: true, sleeping: true, gantt: false, onOpenProject: () => {} },
    cancelled: { ...base, open: true, parked: true, sleeping: false, gantt: false, onOpenProject: () => {} },
    "no workspace": { ...base, open: true, parked: false, sleeping: false, gantt: false },
  };

  for (const [state, props] of Object.entries(states)) {
    it(`nests no control inside another (${state})`, () => {
      expect(nestedControls(renderToStaticMarkup(<OverviewHead {...props} />))).toEqual([]);
    });
  }

  it("still offers every action, each as its own control", () => {
    const active = renderToStaticMarkup(<OverviewHead {...states.active} />);
    expect(active).toContain('aria-expanded="true"');
    expect(active).toMatch(/<button[^>]*class="ov-pname link"/);
    expect(active).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"/);
    expect(active).toMatch(/>Sleep<\/button>/);
    expect(active).toMatch(/>Cancel<\/button>/);

    const cancelled = renderToStaticMarkup(<OverviewHead {...states.cancelled} />);
    expect(cancelled).toMatch(/>Wake<\/button>/);
    expect(cancelled).not.toMatch(/>Cancel<\/button>/);
    expect(renderToStaticMarkup(<OverviewHead {...states.sleeping} />)).toMatch(/>Cancel<\/button>/);
  });

  it("the walker does catch a nested control", () => {
    expect(nestedControls('<button class="a"><span><button class="b">x</button></span></button>')).toEqual(["button.a > button.b"]);
    expect(nestedControls('<button class="a"><span role="link" tabindex="0">x</span></button>')).toEqual(["button.a > span"]);
  });
});
