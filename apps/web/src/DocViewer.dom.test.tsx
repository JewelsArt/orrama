/**
 * The document reader, rendering (OPS-008's web half, handed over by R0): a .docx arrives as
 * scrubbed HTML and is shown as a page; anything else that is text is shown as text, never as
 * markup; a deck is built from its strings, so a slide's "<img onerror>" stays words; a
 * workbook's sheets are tabs over dense rows; a file that can't be read says so in plain words
 * (the system's Notice, not the old .form-error) and offers the download; a document chosen
 * while another was loading never shows the first. It sits in the overlay stack as a Sheet.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  replies: new Map<string, unknown>(),
  /** Requests held until the test lets them go. */
  held: new Map<string, () => void>(),
  hold: new Set<string>(),
}));

vi.mock("./api.js", async (orig) => {
  const real = await orig<typeof import("./api.js")>();
  const answer = async (url: string, signal?: AbortSignal) => {
    if (net.hold.has(url)) await new Promise<void>((r) => net.held.set(url, r));
    if (signal?.aborted) throw new DOMException("superseded", "AbortError");
    const r = net.replies.get(url);
    if (r instanceof real.ApiError) throw r;
    if (r === undefined) throw new real.ApiError(404, "not found");
    return r;
  };
  return {
    ...real,
    api: (_m: string, url: string, _b?: unknown, opts: { signal?: AbortSignal } = {}) => answer(url, opts.signal),
    apiBlob: async (url: string, opts: { signal?: AbortSignal } = {}) => new Blob([String(await answer(url, opts.signal))]),
  };
});

// happy-dom would really fetch a frame's src (the page route): these tests check the frame, not a page.
(window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings.disableIframePageLoading = true;
const { DocViewer } = await import("./DocViewer.js");
const { ApiError } = await import("./api.js");
const BASE = "/api/projects/thesis/files";
const flush = async () => {
  await act(async () => {});
  await act(async () => {});
};

beforeEach(() => {
  net.replies.clear();
  net.held.clear();
  net.hold.clear();
});

describe("the document reader", () => {
  it("shows a .docx as its page, from the server's scrubbed HTML", async () => {
    net.replies.set(`${BASE}/brief.docx/html`, { html: "<h1>Brief</h1><p>Two <strong>markets</strong>.</p>" });
    render(<DocViewer base={BASE} name="brief.docx" onClose={() => {}} />);
    await flush();
    const page = document.querySelector(".doc-docx") as HTMLElement;
    expect(within(page).getByRole("heading", { name: "Brief" })).toBeTruthy();
    expect(page.querySelector("strong")?.textContent).toBe("markets");
    expect(screen.getByRole("dialog", { name: "brief.docx" })).toBeTruthy(); // a Sheet, named by the file
  });

  it("shows a text file as text, never as markup", async () => {
    net.replies.set(`${BASE}/notes.md`, "# Notes\n<img src=x onerror=alert(1)><b>bold?</b>");
    render(<DocViewer base={BASE} name="notes.md" onClose={() => {}} />);
    await flush();
    const pre = document.querySelector(".doc-text") as HTMLElement;
    expect(pre.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(pre.querySelector("img, b")).toBeNull();
  });

  it("builds a deck from its strings: a slide's markup stays words, pictures come only from the deck's media", async () => {
    net.replies.set(`${BASE}/deck.pptx/slides`, {
      slideCount: 1,
      truncated: false,
      omittedImages: 0,
      media: { m1: "data:image/png;base64,iVBORw0KGgo=" },
      slides: [{ n: 1, title: "<script>alert(1)</script>Plan", hidden: false, blocks: [{ kind: "p", level: 0, text: '<img src=x onerror="alert(1)">' }], images: [{ ref: "m1", alt: "chart" }, { ref: "gone", alt: "x" }], notes: "" }],
    });
    render(<DocViewer base={BASE} name="deck.pptx" onClose={() => {}} />);
    await flush();
    const slide = screen.getByRole("region", { name: "Slide 1" });
    expect(slide.textContent).toContain("<script>alert(1)</script>Plan");
    expect(slide.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(slide.querySelector("script")).toBeNull();
    const imgs = slide.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.getAttribute("src")).toMatch(/^data:image\/png/);
  });

  it("shows a workbook's sheets as tabs over dense rows", async () => {
    net.replies.set(`${BASE}/budget.xlsx/sheet`, {
      sheets: [
        { name: "2026", totalRows: 3, truncated: false, rows: [["Month", "Spent"], ["Jan", "120"], ["Feb", null]] },
        { name: "2025", totalRows: 2, truncated: false, rows: [["Month", "Spent"], ["Dec", "99"]] },
      ],
    });
    render(<DocViewer base={BASE} name="budget.xlsx" onClose={() => {}} />);
    await flush();
    expect(screen.getByRole("cell", { name: "Jan" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "2025" }));
    expect(screen.getByRole("cell", { name: "Dec" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "Jan" })).toBeNull();
  });

  it("a file that can't be read says why in plain words, with the download, and no server text", async () => {
    net.replies.set(`${BASE}/gone.docx/html`, new ApiError(404, "ENOENT: no such file, open '/Users/x/vault/04-Projects/thesis/files/gone.docx'"));
    render(<DocViewer base={BASE} name="gone.docx" onClose={() => {}} />);
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't open “gone.docx”.");
    expect(alert.textContent).toContain("It isn't in the folder any more.");
    expect(alert.textContent).not.toContain("ENOENT");
    expect(within(alert).getByRole("button", { name: "Download it instead" })).toBeTruthy();
    expect(document.querySelector(".form-error")).toBeNull();
  });

  it("a document chosen while another was loading never shows the first", async () => {
    net.replies.set(`${BASE}/a.md`, "first file");
    net.replies.set(`${BASE}/b.md`, "second file");
    net.hold.add(`${BASE}/a.md`);
    const { rerender } = render(<DocViewer base={BASE} name="a.md" onClose={() => {}} />);
    await flush();
    rerender(<DocViewer base={BASE} name="b.md" onClose={() => {}} />);
    await flush();
    await act(async () => net.held.get(`${BASE}/a.md`)!());
    await flush();
    expect(document.querySelector(".doc-text")?.textContent).toBe("second file");
  });

  it("a project's .html opens as the page it is, in a sealed frame, and nothing is fetched for it", async () => {
    render(<DocViewer base={BASE} name="Process map.html" onClose={() => {}} />);
    await flush();
    const frame = document.querySelector<HTMLIFrameElement>(".doc-body iframe")!;
    expect(frame.getAttribute("src")).toBe("/api/projects/thesis/files/Process%20map.html/page");
    const sandbox = frame.getAttribute("sandbox")!.split(" ");
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(screen.queryByText(/No reader for/)).toBeNull();
  });

  it("Money's .html has no page route: it offers the download, as before", async () => {
    net.replies.set("/api/finance/files/statement.html", "<p>bytes</p>");
    render(<DocViewer base="/api/finance/files" name="statement.html" onClose={() => {}} />);
    await flush();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/No reader for .html yet/)).toBeTruthy();
  });

  it("Escape closes it, through the overlay stack", async () => {
    net.replies.set(`${BASE}/a.md`, "text");
    const onClose = vi.fn();
    render(<DocViewer base={BASE} name="a.md" onClose={onClose} />);
    await flush();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
