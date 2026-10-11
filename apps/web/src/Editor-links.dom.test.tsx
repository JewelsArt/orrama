/**
 * The real editor, cmd-clicked (WEB-007): the click hands over the link's target, never its
 * alias, so the Notes screen can open the note the server resolved.
 */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "./Editor.js";

const mount = (content: string) => {
  const follow = vi.fn();
  const { container } = render(
    <Editor noteId="n" content={content} readOnly={false} completions={{ titles: [], users: [], tags: [] }} onChange={() => {}} onFollowLink={follow} />,
  );
  return { follow, container };
};

const cmdClick = (el: Element) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, metaKey: true }));

describe("cmd-click on a wiki link", () => {
  it.each([
    ["[[Graduation Thesis|thesis]]", "thesis", "Graduation Thesis"],
    ["[[02-Areas/finance/Budget]]", "02-Areas/finance/Budget", "02-Areas/finance/Budget"],
    ["[[Target#Plan|the plan]]", "the plan", "Target"],
  ])("%s opens its target", (link, label, target) => {
    const { follow, container } = mount(`first line\n\nsee ${link} here\n`);
    const mark = [...container.querySelectorAll(".cm-wikilink")].find((m) => m.textContent === label);
    expect(mark).toBeTruthy();
    cmdClick(mark!);
    expect(follow).toHaveBeenCalledWith(target);
  });
});
