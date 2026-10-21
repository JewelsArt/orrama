/**
 * Money (R10): the pages its addresses name, the overview's month, and what "Looks recurring"
 * does now that it asks (Jules, 11 Oct: Add it writes the row; It's not recurring hides it on
 * this device). The figures are the server's; the fixture is fictional (the boards' shops).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryDetail, FinanceData, MerchantDetail, MonthDetail } from "@orrama/schema/responses";
import { Money } from "./Finance.js";
import { Toaster } from "./ui/overlays.js";
import { aheadOfTypical } from "./money/Overview.js";
import fixture from "./test/money-fixture.json";

const FIX = fixture as unknown as { finance: FinanceData; month: MonthDetail; catMonth: MonthDetail; category: CategoryDetail; merchant: MerchantDetail };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function stubMoney(over: { finance?: FinanceData; category?: CategoryDetail; upload?: unknown; merchant?: Partial<MerchantDetail>; writes?: Record<string, { status: number; body: unknown }> } = {}) {
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
      if (method === "GET" && path.startsWith("/api/finance/merchant/")) return json({ ...copy(FIX.merchant), merchant: path.split("/").pop()!, ...over.merchant });
      const w = over.writes?.[`${method} ${path}`];
      if (w) return json(w.body, w.status);
      if (method === "POST" && path === "/api/finance/subscriptions") return json({ ok: true, noteId: "n-subs", path: "02-Areas/finance/subscriptions.md" });
      if (method !== "GET" && path.startsWith("/api/finance/") && path !== "/api/finance/payslip") return json({ ok: true, noteId: "n-x", path: "02-Areas/finance/x.md", from: "Shopping", to: "Groceries", term: "x" });
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
  cleanup(); // before the stubs go: a late request from the page must not reach happy-dom's real fetch
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Money: what looks recurring", () => {
  it("Add it opens the commitment sheet filled in from the charge, dated from its last charge; Add writes it and reloads", async () => {
    const { sent } = stubMoney();
    at("/money");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    const found = await screen.findByText(/charged €29\.99 monthly/);
    await user.click(within(found.closest(".oprop") as HTMLElement).getByRole("button", { name: "Add it" }));
    const sheet = await screen.findByRole("dialog", { name: "Add a subscription" });
    expect((within(sheet).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("BASIC-FIT");
    expect(sent.some((r) => r.method === "POST")).toBe(false);
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
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

  it("a category past its typical month is marked ahead (Clay draws its bar orange), and only those", async () => {
    stubMoney();
    at("/money?month=2026-09");
    render(<Money onOpenNote={vi.fn()} />);
    await screen.findByRole("heading", { name: "Spent in September" });
    const rows = () => [...document.querySelectorAll<HTMLAnchorElement>("a.mcat")];
    // the comparison comes with the month's detail, a second request
    await waitFor(() => expect(rows().some((a) => a.querySelector(".vs")?.textContent)).toBe(true));
    const all = rows();
    const over = all.filter((a) => a.querySelector(".vs")?.textContent?.startsWith("+"));
    expect(over.length).toBeGreaterThan(0);
    expect(over.length).toBeLessThan(all.length);
    for (const a of all) expect(a.classList.contains("ahead"), a.querySelector(".nm")?.textContent ?? "").toBe(over.includes(a));
    expect([aheadOfTypical(80, 64), aheadOfTypical(64, 64), aheadOfTypical(80, undefined), aheadOfTypical(80, 0)]).toEqual([true, false, false, false]);
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

/* ---- Money in screens (stage 1, 1G): every ledger row added, changed and removed here ---- */

const fin = (edit?: (f: FinanceData) => void): FinanceData => {
  const f = copy(FIX.finance);
  edit?.(f);
  return f;
};
const writes = (sent: Sent[]) => sent.filter((r) => r.method !== "GET");

describe("Money in screens: commitments and income", () => {
  it("a line opens its sheet; Save sends only what changed, named by its row and the table's version", async () => {
    const { sent } = stubMoney();
    at("/money/subscriptions");
    const user = userEvent.setup();
    render(
      <>
        <Money onOpenNote={vi.fn()} />
        <Toaster />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: /^Spotify, €11\.99 monthly: change or remove$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Spotify" });
    expect((within(sheet).getByRole("textbox", { name: "Amount" }) as HTMLInputElement).value).toBe("11.99");
    expect((within(sheet).getByRole("combobox", { name: "Every" }) as HTMLSelectElement).value).toBe("monthly");
    // All eight rhythms are offered.
    expect(within(sheet).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["weekly", "biweekly", "4-weekly", "monthly", "2-monthly", "quarterly", "half-yearly", "yearly"]);
    const amount = within(sheet).getByRole("textbox", { name: "Amount" });
    await user.clear(amount);
    await user.type(amount, "12.99");
    await user.selectOptions(within(sheet).getByRole("combobox", { name: "Every" }), "yearly");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    expect(writes(sent)[0]).toEqual({ method: "PATCH", url: "/api/finance/subscriptions/2", body: { version: FIX.finance.tables.subscriptions!.version, name: "Spotify", set: { amount: "12.99", cadence: "yearly" } } });
    expect(await screen.findByText("Spotify is saved.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Spotify" })).toBeNull());
  });

  it("Remove asks first, then removes the row", async () => {
    const { sent } = stubMoney();
    at("/money/income");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /^Study grant, .*: change or remove$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Study grant" });
    await user.click(within(sheet).getByRole("button", { name: "Remove" }));
    const ask = await screen.findByRole("alertdialog", { name: "Remove Study grant?" });
    expect(writes(sent)).toEqual([]);
    await user.click(within(ask).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(writes(sent)).toEqual([{ method: "DELETE", url: "/api/finance/income/0", body: { version: FIX.finance.tables.income!.version, name: "Study grant" } }]));
  });

  it("a table changed elsewhere since: the sheet says so and keeps what was typed", async () => {
    stubMoney({ writes: { "PATCH /api/finance/subscriptions/0": { status: 409, body: { error: "This list changed since you opened it, so nothing was saved. Open it again and redo the change." } } } });
    at("/money/subscriptions");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /^Rent, / }));
    const sheet = await screen.findByRole("dialog", { name: "Rent" });
    await user.type(within(sheet).getByRole("textbox", { name: "Note" }), "with service costs");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByText(/Not saved\. This list changed since you opened it/)).toBeTruthy();
    expect((within(sheet).getByRole("textbox", { name: "Note" }) as HTMLInputElement).value).toBe("with service costs");
  });

  it("a row the ledger cannot read is named, with Fix it opening its sheet to pick a rhythm", async () => {
    const f = fin((x) => {
      x.subscriptions.unreadable = [{ service: "Club", line: 15, field: "cadence", text: "every so often" }];
      x.tables.subscriptions!.rows.push({ index: 6, line: 15, name: "Club", cells: { service: "Club", amount: "60", cadence: "every so often", next: "", match: "", category: "", note: "" } });
    });
    stubMoney({ finance: f });
    at("/money/subscriptions");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Fix it" }));
    const sheet = await screen.findByRole("dialog", { name: "Club" });
    expect((within(sheet).getByRole("combobox", { name: "Every" }) as HTMLSelectElement).value).toBe("");
    expect((within(sheet).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("with no ledger notes at all, the pages offer Add, and no sentence teaches a table or a tag", async () => {
    const empty = fin((x) => {
      x.notes = { income: null, subscriptions: null, payslips: null, area: null };
      x.subscriptions = { ...x.subscriptions, items: [], count: 0, totals: [], activity: {} };
      x.income = { ...x.income, items: [], count: 0, totals: [], activity: {} };
      x.payslips = [];
      x.tables = { subscriptions: null, income: null, payslips: null, categories: null, "own-accounts": null };
    });
    stubMoney({ finance: empty });
    for (const page of ["/money", "/money/subscriptions", "/money/income", "/money/spending", "/money/savings", "/money/documents"]) {
      at(page);
      const { unmount, container } = render(<Money onOpenNote={vi.fn()} />);
      await screen.findByRole("heading", { level: 1, name: "Money" });
      await waitFor(() => expect(container.querySelector(".ui-skel, [aria-busy='true']")).toBeNull());
      expect(container.textContent).not.toMatch(/tagged|#income|#subscriptions|#payslips|Markdown|table|02-Areas/);
      unmount();
    }
    at("/money/income");
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Add income" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a payslip" })).toBeTruthy();
  });
});

describe("Money in screens: categories and their words", () => {
  const open = async () => {
    const { sent } = stubMoney();
    at("/money/spending");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Edit categories" }));
    return { sent, user, sheet: await screen.findByRole("dialog", { name: "Categories" }) };
  };
  const version = () => FIX.finance.tables.categories!.version;
  /** A control of the sheet, once the last change has landed and the sheet takes clicks again. */
  const ready = async (sheet: HTMLElement, name: string) => {
    const b = within(sheet).getByRole("button", { name }) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(false));
    return b;
  };

  it("lists every category in its order, the first five with their colours, each with its words", async () => {
    const { sheet } = await open();
    const items = within(sheet).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("b")!.textContent)).toEqual(["Rent", "Groceries", "Eating out", "Transport", "Subscriptions", "Shopping", "Going out", "Health", "Education"]);
    const swatch = (i: number) => (items[i]!.querySelector(".mce-head") as HTMLElement).style.getPropertyValue("--cc");
    expect([0, 1, 2, 3, 4, 5].map(swatch)).toEqual(["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c-other)"]);
    expect(within(items[5]!).getByText("grey")).toBeTruthy();
    expect(within(items[1]!).getByText("ah (whole name)")).toBeTruthy();
  });

  it("a category only the commitments fill is shown after the rest, and not editable here", async () => {
    const f = fin((x) => {
      x.tables.categories!.rows = x.tables.categories!.rows.filter((r) => r.name !== "Subscriptions");
    });
    stubMoney({ finance: f });
    at("/money/spending");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Edit categories" }));
    const sheet = await screen.findByRole("dialog", { name: "Categories" });
    const last = within(sheet).getAllByRole("listitem").at(-1)!;
    expect(last.textContent).toBe("Subscriptionsfilled by your commitments");
    expect(within(last).queryByRole("button")).toBeNull();
  });

  it("a word is added to and removed from one category's list", async () => {
    const { sent, user, sheet } = await open();
    await user.type(within(sheet).getByRole("textbox", { name: "Add a word to Groceries" }), "lidl{Enter}");
    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    expect(writes(sent)[0]).toEqual({ method: "PATCH", url: "/api/finance/categories/1", body: { version: version(), name: "Groceries", set: { matches: "albert heijn, jumbo, =ah, lidl" } } });
    await user.click(await ready(sheet, "Remove the word jumbo from Groceries"));
    await waitFor(() => expect(writes(sent)).toHaveLength(2));
    expect(writes(sent)[1]!.body).toEqual({ version: version(), name: "Groceries", set: { matches: "albert heijn, =ah" } });
  });

  it("moves a category up, renames, removes after asking, and adds a new one", async () => {
    const { sent, user, sheet } = await open();
    await user.click(within(sheet).getByRole("button", { name: "Move Shopping up" }));
    await waitFor(() => expect(writes(sent)).toHaveLength(1));
    expect(writes(sent)[0]).toEqual({ method: "POST", url: "/api/finance/categories/5/move", body: { version: version(), name: "Shopping", to: 4 } });
    expect((within(sheet).getByRole("button", { name: "Move Rent up" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(await ready(sheet, "More for Health"));
    await user.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const rename = await screen.findByRole("dialog", { name: "Rename Health" });
    const field = within(rename).getByRole("textbox", { name: "Name" });
    await user.clear(field);
    await user.type(field, "Care");
    await user.click(within(rename).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(writes(sent)).toHaveLength(2));
    expect(writes(sent)[1]).toEqual({ method: "PATCH", url: "/api/finance/categories/7", body: { version: version(), name: "Health", set: { category: "Care" } } });

    await user.click(await ready(sheet, "More for Education"));
    await user.click(await screen.findByRole("menuitem", { name: "Remove…" }));
    const ask = await screen.findByRole("alertdialog", { name: "Remove Education?" });
    expect(within(ask).getByText("Its shops go to Other. Your statements are not changed.")).toBeTruthy();
    await user.click(within(ask).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(writes(sent)).toHaveLength(3));
    expect(writes(sent)[2]).toEqual({ method: "DELETE", url: "/api/finance/categories/8", body: { version: version(), name: "Education" } });

    await user.click(await ready(sheet, "Add a category"));
    const name = await screen.findByRole("dialog", { name: "New category" });
    await user.type(within(name).getByRole("textbox", { name: "Name" }), "Pets");
    await user.click(within(name).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(writes(sent)).toHaveLength(4));
    expect(writes(sent)[3]).toEqual({ method: "POST", url: "/api/finance/categories", body: { category: "Pets" } });
  });

  it("a category's page says which words bring shops in, and opens the sheet on it", async () => {
    stubMoney();
    at("/money/spending/Groceries?month=2026-09");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    const line = (await screen.findByText(/come here\./)).closest("p")!;
    expect(line.textContent).toMatch(/Shops whose name has albert heijn, jumbo or ah \(whole name\) come here\./);
    await user.click(within(line).getByRole("button", { name: "Change" }));
    const sheet = await screen.findByRole("dialog", { name: "Categories" });
    expect(within(sheet).getAllByRole("listitem").find((li) => li.classList.contains("on"))!.querySelector("b")!.textContent).toBe("Groceries");
  });
});

describe("Money in screens: put a shop in a category", () => {
  it("from the shop's page: the dialog says what moves before it moves", async () => {
    const { sent } = stubMoney();
    at("/money/spending?merchant=HEMA");
    const user = userEvent.setup();
    render(
      <>
        <Money onOpenNote={vi.fn()} />
        <Toaster />
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Put it in another category" }));
    const dialog = await screen.findByRole("dialog", { name: "Put HEMA in a category" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "Groceries");
    expect(within(dialog).getByText(/moves from Shopping to/).textContent).toBe("Every HEMA row moves from Shopping to Groceries, in every month.");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(writes(sent)).toEqual([{ method: "POST", url: "/api/finance/categories/shop", body: { merchant: "HEMA", category: "Groceries" } }]));
    expect(await screen.findByText("Every HEMA row is in Groceries now.")).toBeTruthy();
    // The shop's page is read again, with where it is filed now.
    await waitFor(() => expect(gets(sent, "/api/finance/merchant/").length).toBeGreaterThan(1));
  });

  it("a shop a commitment claims says so, and offers no move", async () => {
    stubMoney({ merchant: { filing: { category: "Subscriptions", commitment: "Netflix", own: null } } });
    at("/money/spending?merchant=NETFLIX.COM");
    render(<Money onOpenNote={vi.fn()} />);
    expect((await screen.findByText(/as your/)).closest("p")!.textContent).toBe("Counted under Subscriptions, as your Netflix commitment.");
    expect(screen.queryByRole("button", { name: "Put it in another category" })).toBeNull();
  });

  it("from a shop's row on its category's page", async () => {
    const { sent } = stubMoney();
    at("/money/spending/Groceries?month=2026-09");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await screen.findByRole("heading", { name: "Where it went in September" });
    const row = (await screen.findAllByRole("link")).find((a) => a.classList.contains("mshop"))!;
    const shop = row.querySelector(".t")!.textContent!;
    await user.click(screen.getByRole("button", { name: `Put ${shop} in another category` }));
    const dialog = await screen.findByRole("dialog", { name: `Put ${shop} in a category` });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Category" }), "\u0000new");
    await user.type(within(dialog).getByRole("textbox", { name: "Name of the new category" }), "Lunch");
    await user.click(within(dialog).getByRole("button", { name: "Move" }));
    await waitFor(() => expect(writes(sent)).toEqual([{ method: "POST", url: "/api/finance/categories/shop", body: { merchant: shop, category: "Lunch" } }]));
  });
});

describe("Money in screens: payslips and own accounts", () => {
  it("a payslip PDF kept but not read: Type the figures files them for that file", async () => {
    const f = fin((x) => {
      x.files = [{ name: "august.pdf", size: 1000, mtimeMs: Date.parse("2026-09-02"), ext: ".pdf" }, ...x.files];
    });
    const { sent } = stubMoney({ finance: f });
    at("/money/income");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    expect(await screen.findByText("kept, its figures not read")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Type the figures" }));
    const sheet = await screen.findByRole("dialog", { name: "A payslip's figures" });
    fireEvent.change(within(sheet).getByLabelText("Month it pays for"), { target: { value: "2026-08" } });
    await user.type(within(sheet).getByRole("textbox", { name: "Gross" }), "2.600,00");
    await user.type(within(sheet).getByRole("textbox", { name: "Net" }), "2000");
    await user.click(within(sheet).getByRole("button", { name: "File it" }));
    await waitFor(() => expect(writes(sent)).toEqual([{ method: "POST", url: "/api/finance/payslips", body: { month: "2026-08", gross: 2600, net: 2000, file: "august.pdf" } }]));
  });

  it("a filed payslip opens to change its net, or be removed", async () => {
    const { sent } = stubMoney();
    at("/money/income");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: /^Aug 2026, €650\.00: change or remove$/ }));
    const sheet = await screen.findByRole("dialog", { name: "Payslip, Aug 2026" });
    const net = within(sheet).getByRole("textbox", { name: "Net" });
    await user.clear(net);
    await user.type(net, "660");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes(sent)).toEqual([{ method: "PATCH", url: "/api/finance/payslips/1", body: { version: "v-slips", name: "2026-08", set: { net: "660.00" } } }]));
  });

  it("own accounts are listed on Savings, added and removed there", async () => {
    const { sent } = stubMoney();
    at("/money/savings");
    const user = userEvent.setup();
    render(<Money onOpenNote={vi.fn()} />);
    const box = await screen.findByRole("region", { name: "Your own accounts" });
    expect(within(box).getByText("brokerly")).toBeTruthy();
    await user.click(within(box).getByRole("button", { name: "Add an account" }));
    const sheet = await screen.findByRole("dialog", { name: "Add an account" });
    await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "Pot");
    await user.type(within(sheet).getByRole("textbox", { name: "On your statement as" }), "savings pot,  =pot ");
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(writes(sent)).toEqual([{ method: "POST", url: "/api/finance/own-accounts", body: { account: "Pot", matches: "savings pot, =pot" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add an account" })).toBeNull());
    await user.click(within(box).getByRole("button", { name: /Broker/ }));
    const edit = await screen.findByRole("dialog", { name: "Broker" });
    await user.click(within(edit).getByRole("button", { name: "Remove" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "Remove Broker?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(writes(sent)[1]).toEqual({ method: "DELETE", url: "/api/finance/own-accounts/0", body: { version: "v-own", name: "Broker" } }));
  });
});
