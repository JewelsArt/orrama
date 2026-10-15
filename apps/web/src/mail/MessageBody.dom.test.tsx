/**
 * The sandboxed message frame (OPS-008, the web half; CLAUDE.md "Reading mail"). HTML mail is
 * untrusted markup inside our origin's page: it may never run a script, its links open outside
 * the app, and remote images load only while allowed. allow-same-origin is there to measure the
 * frame, which is safe only while allow-scripts is absent; these tests hold both.
 */
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MailMessage } from "@orrama/schema/responses";
import { frameCsp, frameDoc, MessageBody, SANDBOX } from "./MessageBody.js";

const html: MailMessage = {
  uid: 103,
  from: "news@oostrunners.example",
  fromName: "Oost Runners",
  to: "jules@basalt.dev",
  subject: "Taper week",
  date: null,
  text: "",
  html: '<p>Easy <b>6 km</b>.</p><img src="https://cdn.oostrunners.example/pixel.gif"><script>parent.stolen = 1</script>',
  messageId: null,
  references: null,
};
const frame = () => screen.getByTitle("Message content") as HTMLIFrameElement;
const tokens = (el: HTMLIFrameElement) => (el.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean).sort();

describe("the message frame", () => {
  it("is sandboxed without scripts: same origin only to measure it, popups only for links", () => {
    render(<MessageBody message={html} images onShowImages={() => {}} />);
    expect(tokens(frame())).toEqual(["allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin"]);
    expect(SANDBOX).not.toMatch(/allow-scripts|allow-forms|allow-top-navigation|allow-modals/);
    expect(frame().getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("carries its own policy: no script source at all, links open in a new window", () => {
    render(<MessageBody message={html} images onShowImages={() => {}} />);
    const doc = frame().getAttribute("srcdoc")!;
    expect(doc.startsWith(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(true)}">`)).toBe(true);
    expect(frameCsp(true)).toMatch(/^default-src 'none';/);
    expect(frameCsp(true)).not.toMatch(/script-src/);
    expect(doc).toContain('<base target="_blank">');
  });

  it("blocks remote images when asked, and says so with a way back", () => {
    let shown = 0;
    render(<MessageBody message={html} images={false} onShowImages={() => shown++} />);
    expect(frame().getAttribute("srcdoc")).toContain(`content="${frameCsp(false)}"`);
    expect(frameCsp(false)).toContain("img-src data:;");
    expect(frameCsp(false)).not.toMatch(/https?:/);
    screen.getByRole("button", { name: "Show images" }).click();
    expect(shown).toBe(1);
  });

  it("injects only the two width rules a mail's tables can live with", () => {
    const style = /<style>([^<]*)<\/style>/.exec(frameDoc("", true))![1]!;
    expect(style).toContain("img{max-width:100%;height:auto;}");
    expect(style).toContain("table{max-width:100%;}");
    expect(style).not.toMatch(/\*\s*\{|\bdiv\b|\btd\b/);
  });

  it("fits the frame to the message's body, not to the frame it already has", async () => {
    render(<MessageBody message={html} images onShowImages={() => {}} />);
    const el = frame();
    const doc = el.contentDocument!;
    // A document is never shorter than its frame: a frame 500 px tall around 333 px of mail.
    Object.defineProperty(doc.documentElement, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(doc.body, "scrollHeight", { configurable: true, get: () => 333 });
    await act(async () => {
      el.dispatchEvent(new Event("load"));
    });
    expect(el.style.height).toBe("333px");
  });

  it("falls back to the text, and says when there is none", () => {
    const { unmount } = render(<MessageBody message={{ ...html, html: null, text: "Easy 6 km.\n\nSee you." }} images onShowImages={() => {}} />);
    expect(screen.queryByTitle("Message content")).toBeNull();
    expect(screen.getByText("Easy 6 km.")).toBeTruthy();
    unmount();
    render(<MessageBody message={{ ...html, html: null, text: "  " }} images onShowImages={() => {}} />);
    expect(screen.getByText("This message has no text.")).toBeTruthy();
  });
});
