/**
 * Money (R10): the pages its addresses name, the overview's month, and what "Looks recurring"
 * does now that it asks (Jules, 11 Oct: Add it writes the row; It's not recurring hides it on
 * this device). The figures are the server's; the fixture is fictional (the boards' shops).
 */
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryDetail, FinanceData, MerchantDetail, MonthDetail } from "@orrama/schema/responses";
import { Money } from "./Finance.js";
import fixture from "./test/money-fixture.json";

const FIX = fixture as unknown as { finance: FinanceData; month: MonthDetail; catMonth: MonthDetail; category: CategoryDetail; merchant: MerchantDetail };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function stubMoney(over: { finance?: FinanceData; category?: CategoryDetail; upload?: unknown } = {}) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const path = decodeURIComponent(url.split("?")[0]!);
      if (method === "GET" && path === "/api/finance") return json(copy(over.finance ?? FIX.finance));
      if (method === "GET" && path.startsWith("/api/finance/month/")) {
        const month = path.split("/").pop()!;
        return json({ ...copy(url.includes("category=") ? FIX.catMonth : FIX.month), month });
      }
      if (method === "GET" && path.startsWith("/api/finance/category/")) return json(copy(over.category ?? FIX.category));
      if (method === "GET" && path.startsWith("/api/finance/merchant/")) return json({ ...copy(FIX.merchant), merchant: path.split("/").pop()! });
      if (method === "POST" && path === "/api/finance/subscriptions") return json({ ok: true, noteId: "n-subs", path: "02-Areas/finance/subscriptions.md" });
      if (method === "POST" && path === "/api/finance/payslip") return json(over.upload ?? {});
      return json({ error: "not here" }, 404);
    }),
  );
  return { sent };
}

const at = (href: string) => history.replaceState(null, "", href);
const here = () => location.pathname + location.search;
const gets = (sent: Sent[], prefix: string) => sent.filter((r) => r.method === "GET" && r.url.startsWith(prefix)).map((r) => r.url);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-11T12:00:00") });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Money: what looks recurring", () => {
  it("Add it writes the charge into the #subscriptions note, dated from its last charge, and reloads", async () => {
    const { sent } = stubMoney();
    at("/money");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    const found = await screen.findByText(/charged €29\.99 monthly/);
    await user.click(within(found.closest(".oprop") as HTMLElement).getByRole("button", { name: "Add it" }));
    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
    const post = sent.find((r) => r.method === "POST")!;
    expect(post.url).toBe("/api/finance/subscriptions");
    // The bank's own name, so the new line claims exactly this charge; the last time it was
    // charged, which the ledger rolls forward to the next.
    expect(post.body).toEqual({ service: "BASIC-FIT", amount: "29.99", cadence: "monthly", next: "2026-09-20", note: "" });
    await waitFor(() => expect(gets(sent, "/api/finance").filter((u) => u === "/api/finance")).toHaveLength(2));
  });

  it("It's not recurring hides it on this device; the Subscriptions page lists it with an Undo", async () => {
    stubMoney();
    at("/money");
    const user = userEvent.setup();
    const { unmount } = render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "It's not recurring" }));
    expect(screen.queryByText(/charged €29\.99 monthly/)).toBeNull();
    unmount();

    at("/money/subscriptions");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByText(/you said it isn't recurring/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add it" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByRole("button", { name: "Add it" })).toBeTruthy();
  });
});

describe("Money: the address names the page", () => {
  it("/money/spending?month= is that month in full, every category", async () => {
    const { sent } = stubMoney();
    at("/money/spending?month=2026-09");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByRole("heading", { level: 1, name: "September 2026" })).toBeTruthy();
    await waitFor(() => expect(gets(sent, "/api/finance/month/")).toContain("/api/finance/month/2026-09"));
  });

  it("/money/spending/<category>?month= is the category with that month open below its chart", async () => {
    const { sent } = stubMoney();
    at("/money/spending/Groceries?month=2026-09");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Where it went in September" })).toBeTruthy();
    expect(gets(sent, "/api/finance/category/")).toContain("/api/finance/category/Groceries?year=2026");
    expect(gets(sent, "/api/finance/month/")).toContain("/api/finance/month/2026-09?category=Groceries");
    // Each shop opens that shop, with the category in its address.
    const shop = (await screen.findAllByRole("link")).find((a) => a.classList.contains("mshop"))!;
    expect(shop.getAttribute("href")).toMatch(/^\/money\/spending\/Groceries\/[^?]+$/);
  });

  it("a column of the chart moves the month open below it, and the address follows", async () => {
    stubMoney();
    at("/money/spending/Groceries?month=2026-09");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await screen.findByRole("heading", { name: "Where it went in September" });
    await user.click(screen.getByRole("button", { name: /^Open August 2026 · €/ }));
    expect(here()).toBe("/money/spending/Groceries?month=2026-08");
    expect(await screen.findByRole("heading", { name: "Where it went in August" })).toBeTruthy();
  });

  it("/money/spending?merchant= is that shop", async () => {
    const { sent } = stubMoney();
    at("/money/spending?merchant=BASIC-FIT");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByRole("heading", { level: 1, name: "BASIC-FIT" })).toBeTruthy();
    expect(gets(sent, "/api/finance/merchant/")).toEqual(["/api/finance/merchant/BASIC-FIT"]);
  });

  it("a category nothing has cost says so, rather than a chart of 'Invalid' months", async () => {
    const empty: CategoryDetail = { ...copy(FIX.category), category: "Other", years: [], year: null, series: [], yearly: [], merchants: [], stats: { total: 0, count: 0, activeMonths: 0, average: 0, high: 0, low: 0 } };
    stubMoney({ category: empty });
    at("/money/spending/Other");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByText("Nothing has cost anything in Other yet.")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Invalid|null/);
  });
});

describe("Money: the overview's month", () => {
  it("← and → step the month, and the address says which", async () => {
    stubMoney();
    at("/money");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Spent in October" })).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    expect(here()).toBe("/money?month=2026-09");
    expect(await screen.findByRole("heading", { name: "Spent in September" })).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    // The latest month is the overview's own address.
    expect(here()).toBe("/money");
  });

  it("↑ and ↓ move between the rows of a box, and stop at its ends", async () => {
    stubMoney();
    at("/money?month=2026-09");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await screen.findByRole("heading", { name: "Spent in September" });
    const rows = [...document.querySelectorAll<HTMLAnchorElement>("a.mcat")];
    rows[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(rows[1]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(rows[0]);
  });

  it("each category row opens that category in that month; Other opens the month's spending", async () => {
    stubMoney();
    at("/money?month=2026-09");
    render(<Money onOpenNote={vi.fn()} />);
    await screen.findByRole("heading", { name: "Spent in September" });
    const rows = [...document.querySelectorAll<HTMLAnchorElement>("a.mcat")];
    const href = (name: string) => rows.find((a) => a.querySelector(".nm")?.textContent === name)?.getAttribute("href");
    expect(href("Groceries")).toBe("/money/spending/Groceries?month=2026-09");
    expect(href("Other")).toBe("/money/spending?month=2026-09");
  });

  it("an empty install asks for a bank export, with Orr carrying, and shows no €0.00 month", async () => {
    const f = copy(FIX.finance);
    f.spending.txnCount = 0;
    f.spending.months = [];
    f.spending.categories.months = [];
    stubMoney({ finance: f });
    at("/money");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByText("Drop a bank export (CSV) here to start.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /^Spent in/ })).toBeNull();
  });

  it("an upload says what the statement added", async () => {
    stubMoney({ upload: { name: "revolut-oct.csv", stored: true, filed: false, parsed: null, statement: { rows: 12, skipped: 1, first: "2026-10-01", last: "2026-10-11", reason: null } } });
    at("/money");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await screen.findByRole("heading", { name: "Spent in October" });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(["Type,Amount\n"], "revolut-oct.csv", { type: "text/csv" }));
    expect(await screen.findByText(/Read 12 transactions from revolut-oct\.csv, 1 Oct to 11 Oct \(1 row skipped/)).toBeTruthy();
  });
});
