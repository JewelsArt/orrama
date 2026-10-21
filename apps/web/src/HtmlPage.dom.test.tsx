/**
 * The frame an .html page runs in. Its sandbox must match the one the server sends with the
 * page (`apps/server/src/pageSandbox.ts`): scripts yes, its own origin never, so the page has
 * no session, none of Orrama's storage and no reach into the window around it.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HtmlPage, PAGE_SANDBOX } from "./HtmlPage.js";

// happy-dom would really fetch a frame's src (the page route): these tests check the frame, not a page.
(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
describe("HtmlPage", () => {
  it("frames the page route under the same sandbox the server sends", () => {
    const server = fs.readFileSync(path.join(import.meta.dirname, "../../server/src/pageSandbox.ts"), "utf8");
    const list = /PAGE_SANDBOX = \[([^\]]*)\]/.exec(server)![1]!.match(/"([^"]+)"/g)!.map((t) => t.slice(1, -1));
    expect(PAGE_SANDBOX.split(" ")).toEqual(list);
    expect(list).not.toContain("allow-same-origin");
  });

  it("says Opening… until the page has loaded, and draws a frame per page", async () => {
    const { rerender } = render(<HtmlPage slug="harbour guide" name="Map & plan.html" />);
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/projects/harbour%20guide/files/Map%20%26%20plan.html/page");
    expect(frame.getAttribute("sandbox")).toBe(PAGE_SANDBOX);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText("Opening…")).toBeTruthy();
    await act(async () => {
      fireEvent.load(frame);
    });
    expect(screen.queryByText("Opening…")).toBeNull();
    rerender(<HtmlPage slug="harbour guide" name="Other.html" />);
    expect(screen.getByText("Opening…")).toBeTruthy();
    expect(document.querySelector("iframe")!.getAttribute("src")).toBe("/api/projects/harbour%20guide/files/Other.html/page");
  });
});
