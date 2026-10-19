/**
 * Money (structure.md §2.9, was Finance): where the money goes, with its working shown. Built from
 * the boards mockups/screens/money.html and money-drill.html on the shared system: no purple hero,
 * no tokens of its own (§8 #6).
 *
 * Every figure is the server's (routes/finance.ts), read out of the statements and the Markdown
 * ledgers in the vault; this screen changes how money looks, never what it adds up to.
 *
 * Addresses (money/links.ts): the overview, Spending, Subscriptions, Income, Savings and Documents
 * as text tabs, and the drill-down below Spending — a month, a category with its month open, a
 * shop. Everything visible opens what it names (§1.7).
 *
 * This file holds the state and every request the screen makes (the contract test scans the top
 * level of src/ for GETs); the pages it draws are in money/.
 */
import { monthKey } from "@orrama/core/dates";
import type { CategoryDetail, FinanceData, MerchantDetail, MonthDetail, Recurring } from "@orrama/schema/responses";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, unlessAborted } from "./api.js";
import { DocViewer } from "./DocViewer.js";
import { readJson, writeKey } from "./storage.js";
import { Button, Tabs } from "./ui/controls.js";
import { toast } from "./ui/overlays.js";
import { navigate, useRoute } from "./ui/router.js";
import { Notice, Skeleton } from "./ui/states.js";
import { CategoryPage, pickMonth } from "./money/Category.js";
import { DocumentsPage } from "./money/Documents.js";
import { monthLong, monthPace, statementFlash, type StatementRead } from "./money/format.js";
import { useMonthKeys } from "./money/hooks.js";
import { LedgerPage } from "./money/Ledger.js";
import { link, to, type MoneyRoute } from "./money/links.js";
import { MerchantPage } from "./money/Merchant.js";
import { recurringKey, recurringRow } from "./money/model.js";
import { Overview, shownMonth } from "./money/Overview.js";
import { paletteFor } from "./money/palette.js";
import { SavingsPage } from "./money/Savings.js";
import { MonthPage, SpendingPage } from "./money/Spending.js";
import { SectionBar } from "./ui/shell/SectionBar.js";

/** Today's money card and the colour-vision editor colour and draw categories the way Money does. */
export { iconFor, paletteFor } from "./money/palette.js";

type Tab = "overview" | "spending" | "subscriptions" | "income" | "savings" | "documents";
/** "It's not recurring", remembered on this device. */
const NOT_RECURRING_KEY = "orrama-money-not-recurring";

/* ---- requests ------------------------------------------------------------------------------ */

function useFinance() {
  const [d, setD] = useState<FinanceData | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setD(await api<FinanceData>("GET", "/api/finance"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { d, failed, load };
}

/** One category's year. Kept while the next year loads, so the page does not blank. */
function useCategory(name: string | null, year: string | null) {
  const [got, setGot] = useState<{ name: string; d: CategoryDetail } | null>(null);
  useEffect(() => {
    if (!name) return;
    const ac = new AbortController();
    const q = year ? `?year=${encodeURIComponent(year)}` : "";
    void api<CategoryDetail>("GET", `/api/finance/category/${encodeURIComponent(name)}${q}`, undefined, { signal: ac.signal }).then((d) => setGot({ name, d }), unlessAborted);
    return () => ac.abort();
  }, [name, year]);
  return got && got.name === name ? got.d : null;
}

/** One month in full, optionally narrowed to one category. */
function useMonth(month: string | null, category: string | null) {
  const [got, setGot] = useState<{ key: string; d: MonthDetail } | null>(null);
  const key = `${month}|${category ?? ""}`;
  useEffect(() => {
    if (!month) return;
    const ac = new AbortController();
    const q = category ? `?category=${encodeURIComponent(category)}` : "";
    void api<MonthDetail>("GET", `/api/finance/month/${month}${q}`, undefined, { signal: ac.signal }).then((d) => setGot({ key: `${month}|${category ?? ""}`, d }), unlessAborted);
    return () => ac.abort();
  }, [month, category]);
  return got && got.key === key ? got.d : null;
}

/** One shop's year. */
function useMerchant(name: string | null, year: string | null) {
  const [got, setGot] = useState<{ name: string; d: MerchantDetail } | null>(null);
  useEffect(() => {
    if (!name) return;
    const ac = new AbortController();
    const q = year ? `?year=${encodeURIComponent(year)}` : "";
    void api<MerchantDetail>("GET", `/api/finance/merchant/${encodeURIComponent(name)}${q}`, undefined, { signal: ac.signal }).then((d) => setGot({ name, d }), unlessAborted);
    return () => ac.abort();
  }, [name, year]);
  return got && got.name === name ? got.d : null;
}

/** The rows of a box, in order: what ↑ and ↓ move between (§1.7 #7). */
const ROWS = "a.row, button.row:not(:disabled), a.mcat, div.row[tabindex]";

/** ↑ and ↓ move between the rows of the box you are in; Enter opens one (it is a link). */
export function rowKeys(e: { key: string; target: EventTarget | null; preventDefault: () => void; altKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }) {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.metaKey || e.ctrlKey) return;
  const el = e.target as HTMLElement | null;
  if (!el?.matches?.(ROWS)) return;
  const box = el.closest(".mod");
  if (!box) return;
  const rows = [...box.querySelectorAll<HTMLElement>(ROWS)];
  const to = rows[rows.indexOf(el) + (e.key === "ArrowDown" ? 1 : -1)];
  if (!to) return;
  e.preventDefault();
  to.focus();
}

/** A file as base64, for the JSON upload (no multipart parser to keep). */
async function base64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* ---- the screen ---------------------------------------------------------------------------- */

export function Money({ onOpenNote }: { onOpenNote: (id: string) => void }) {
  const route = useRoute();
  const at = useMemo<MoneyRoute>(() => (route?.kind === "money" ? route : { kind: "money" }), [route]);
  const { d, failed, load } = useFinance();

  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => new Set(readJson<string[]>(NOT_RECURRING_KEY, [])));
  const fileInput = useRef<HTMLInputElement>(null);

  // Which page the address names: a shop wins, then a category, then one month, then a tab.
  const merchant = at.merchant ?? null;
  const category = !merchant && at.page === "spending" ? (at.category ?? null) : null;
  const monthPage = !merchant && !category && at.page === "spending" && at.month ? at.month : null;
  const tab: Tab | null = merchant || category || monthPage ? null : (at.page ?? "overview");

  // A category or shop's year: the tab you picked, else the year of the month you came in on.
  const [year, setYear] = useState<{ of: string; year: string } | null>(null);
  const yearOf = (of: string | null) => (of && year?.of === of ? year.year : of && at.month ? at.month.slice(0, 4) : null);
  const cat = useCategory(category, yearOf(category));
  const catMonth = cat ? pickMonth(cat, at.month) : null;
  const shop = useMerchant(merchant, yearOf(merchant));
  const overviewMonth = d && tab === "overview" ? (shownMonth(d, at.month) ?? monthKey(new Date())) : null;
  const detail = useMonth(monthPage ?? (category ? catMonth : overviewMonth), category);

  /* ---- uploads ---- */
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      setBusy(file.name);
      try {
        const res = await api<{ name: string; stored: boolean; filed: boolean; reason?: string; parsed: { month: string | null } | null; statement?: StatementRead | null }>("POST", "/api/finance/payslip", {
          name: file.name,
          dataBase64: await base64(file),
        });
        const left = res.statement !== undefined ? !!res.statement?.reason : !res.filed;
        setFlash({
          ok: !left,
          text:
            res.statement !== undefined
              ? statementFlash(res.name, res.statement)
              : res.filed
                ? `Filed the payslip for ${res.parsed?.month ? monthLong(res.parsed.month) : file.name}.`
                : res.stored
                  ? `Stored ${res.name}, but the figures were not filed: ${res.reason ?? "no reason given"}.`
                  : `Not stored: ${res.reason ?? "no reason given"}.`,
        });
      } catch (e) {
        setFlash({ ok: false, text: e instanceof Error ? e.message : `Could not upload ${file.name}.` });
      }
    }
    setBusy(null);
    await load();
  };
  const pick = () => fileInput.current?.click();
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    void upload(e.dataTransfer.files);
  };

  /* ---- what looks recurring ---- */
  const dismiss = (r: Recurring, off: boolean) => {
    const next = new Set(dismissed);
    if (off) next.add(recurringKey(r));
    else next.delete(recurringKey(r));
    setDismissed(next);
    writeKey(NOT_RECURRING_KEY, JSON.stringify([...next]));
  };
  /** Write the charge into the #subscriptions note, dated from the last time it was charged. */
  const add = async (r: Recurring) => {
    setAdding(r.merchant);
    try {
      const seen = await api<MerchantDetail>("GET", `/api/finance/merchant/${encodeURIComponent(r.merchant)}`);
      const last = seen.transactions.find((t) => !t.refund && Math.abs(t.amount - r.amount) < 0.005)?.date ?? null;
      const row = recurringRow(r, last);
      if (!row) return;
      await api("POST", "/api/finance/subscriptions", row);
      toast(`${r.merchant} is in your commitments now.`);
      await load();
    } catch (e) {
      setFlash({ ok: false, text: e instanceof Error ? `Could not add ${r.merchant}: ${e.message}` : `Could not add ${r.merchant}.` });
    } finally {
      setAdding(null);
    }
  };

  /* ---- the overview's month: ← → and the arrows ---- */
  const months = d?.spending.months.map((m) => m.month) ?? [];
  const mi = overviewMonth ? months.indexOf(overviewMonth) : -1;
  const latest = months[months.length - 1];
  const goMonth = (m: string) => navigate(to.overview(m === latest ? undefined : m), { replace: true });
  useMonthKeys(tab === "overview" && mi > 0 ? months[mi - 1]! : null, tab === "overview" && mi >= 0 && mi < months.length - 1 ? months[mi + 1]! : null, goMonth);

  const colourOf = useMemo(() => paletteFor(d?.spending.categories.rules ?? []), [d]);
  const input = (
    <input
      ref={fileInput}
      type="file"
      accept=".pdf,.csv,.xlsx"
      multiple
      hidden
      onChange={(e) => {
        void upload(e.target.files);
        e.target.value = "";
      }}
    />
  );
  const flashNotice = flash && (
    <Notice
      ok={flash.ok}
      title={flash.ok ? "Added" : "Not added to the figures"}
      text={flash.text}
      actions={
        <Button size="sm" kind="quiet" onClick={() => setFlash(null)}>
          Dismiss
        </Button>
      }
    />
  );
  const reader = reading && <DocViewer base="/api/finance/files" name={reading} onClose={() => setReading(null)} />;

  /* ---- the drill-down: a shop, a category, a month ---- */
  if (!tab)
    return (
      <div className="money" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onKeyDown={rowKeys}>
        {input}
        {flashNotice}
        {merchant ? (
          <MerchantPage name={merchant} category={at.category} d={shop} onYear={(y) => setYear({ of: merchant, year: y })} />
        ) : category ? (
          <CategoryPage
            name={category}
            d={cat}
            month={catMonth}
            detail={detail}
            colour={colourOf(category)}
            onYear={(y) => {
              setYear({ of: category, year: y });
              navigate(to.category(category), { replace: true });
            }}
          />
        ) : (
          <MonthPage month={monthPage!} d={detail} colourOf={colourOf} />
        )}
        {reader}
      </div>
    );

  /* ---- the tabs ---- */
  const pace = d && overviewMonth === latest ? monthPace(d.spending.dataThrough) : null;
  const tabs = [
    { id: "overview" as const, label: "Overview", href: link(to.overview()).href },
    { id: "spending" as const, label: "Spending", href: link(to.spending()).href },
    { id: "subscriptions" as const, label: "Subscriptions", count: d?.subscriptions.count || undefined, href: link(to.page("subscriptions")).href },
    { id: "income" as const, label: "Income", href: link(to.page("income")).href },
    { id: "savings" as const, label: "Savings", href: link(to.page("savings")).href },
    { id: "documents" as const, label: "Documents", count: d?.files.length || undefined, href: link(to.page("documents")).href },
  ];
  const openTab = (t: Tab) => navigate(t === "overview" ? to.overview() : t === "spending" ? to.spending() : to.page(t));

  return (
    <div className="money" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} onKeyDown={rowKeys}>
      {input}
      <div className="phead mhead">
        <h1>Money</h1>
        {pace && <span className="meta">day {pace.elapsed} of {pace.length}</span>}
        <span className="sp" />
        {tab === "overview" && overviewMonth && (
          <div className="mnav">
            <Button size="sm" icon="chev-l" aria-label="Previous month" tip="Previous month  ←" data-tip-at="top" disabled={mi <= 0} onClick={() => goMonth(months[mi - 1]!)} />
            <b>{monthLong(overviewMonth)}</b>
            <Button size="sm" icon="chev-r" aria-label="Next month" tip="Next month  →" data-tip-at="top" disabled={mi < 0 || mi >= months.length - 1} onClick={() => goMonth(months[mi + 1]!)} />
          </div>
        )}
        <Button icon="upload" onClick={pick} disabled={!!busy} aria-label={busy ? `Reading ${busy}` : "Add a bank export"} tip="CSV, XLSX or a PDF payslip" data-tip-at="top">
          <span className="mlabel">{busy ? `Reading ${busy}…` : "Add a bank export"}</span>
        </Button>
      </div>
      <SectionBar>
        <Tabs label="Money" items={tabs} value={tab} onChange={openTab} />
      </SectionBar>

      {flashNotice}
      {d && (tab === "overview" || tab === "documents") && (
        <>
          {/* Two notes carrying one ledger tag: one is used, by a fixed rule, and the page says
              which rather than picking silently (ACL-011). */}
          {d.ledgerConflicts.map((c) => (
            <Notice
              key={c.tag}
              title={`${c.others.length + 1} notes are tagged #${c.tag}`}
              text={`Using ${c.using}. Not used: ${c.others.join(", ")}. Remove the tag from the ${c.others.length === 1 ? "one that is" : "ones that are"} not the ledger.`}
            />
          ))}
          {d.spending.excluded.length > 0 && (
            <Notice
              title={`${d.spending.excluded.length} statement ${d.spending.excluded.length === 1 ? "file is" : "files are"} left out of the figures`}
              text={d.spending.excluded.map((f) => (
                <span key={f.name} className="mnline">
                  {f.name}: {f.reason}.
                </span>
              ))}
            />
          )}
        </>
      )}

      {!d ? (
        failed ? (
          <Notice
            title="Money could not be read"
            text="The server did not answer. Your statements and ledgers are untouched."
            actions={
              <Button size="sm" onClick={() => void load()}>
                Try again
              </Button>
            }
          />
        ) : (
          <Skeleton rows={6} label="Reading the statements" />
        )
      ) : tab === "overview" ? (
        overviewMonth ? (
          <Overview
            d={d}
            month={overviewMonth}
            detail={detail}
            dismissed={dismissed}
            onDismiss={(r) => dismiss(r, true)}
            onAdd={(r) => void add(r)}
            adding={adding}
            onUpload={pick}
          />
        ) : null
      ) : tab === "spending" ? (
        <SpendingPage d={d} onOpenNote={onOpenNote} />
      ) : tab === "subscriptions" || tab === "income" ? (
        <LedgerPage
          kind={tab}
          d={d}
          month={at.month}
          onOpenNote={onOpenNote}
          onRead={setReading}
          dismissed={dismissed}
          onDismiss={(r) => dismiss(r, true)}
          onUndismiss={(r) => dismiss(r, false)}
          onAdd={(r) => void add(r)}
          adding={adding}
        />
      ) : tab === "savings" ? (
        <SavingsPage d={d} />
      ) : (
        <DocumentsPage d={d} onRead={setReading} onUpload={pick} />
      )}
      {reader}
    </div>
  );
}
