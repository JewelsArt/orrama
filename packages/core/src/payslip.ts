/**
 * Dutch payslips (loonstrook), as produced by Loket.nl — the payroll provider
 * behind a large share of NL employers, and the one Jules's is on.
 *
 * The input is the PDF's TEXT LAYER, already flattened by the caller. A payslip
 * is laid out in columns, and flattening merges them, so a label is followed by
 * its period figure and then its year-to-date figure: `BRUTO 1.057,06 4.820,90`.
 * That is the whole grammar — read a label, take the next N numbers.
 *
 * Numbers are Dutch: thousands separated by dots, decimals by a comma.
 *
 * Nothing here throws on a payslip it does not recognise. A missing field comes
 * back null and the caller can ask the user for it; guessing at a salary figure
 * is far worse than admitting the layout was unfamiliar.
 */

import { parseMoney } from "./money.js";
import { appendRow, cells, changeRow, isRule, mapHeader, readLedgerTable, removeRow, type LedgerSpec, type LedgerTable, type RowRef, type RowWrite } from "./table.js";

export interface Payslip {
  /** `YYYY-MM` — the period the payslip covers, not the run date. */
  month: string | null;
  gross: number | null;
  net: number | null;
  /** Everything withheld: gross − net, which is exact and needs no label. */
  tax: number | null;
  hours: number | null;
  /** Contractual rate from the payslip (`UURLOON`), before any allowance. */
  hourlyRate: number | null;
  /** What an hour actually put in your pocket: net ÷ hours. */
  effectiveNet: number | null;
  /** Holiday allowance paid out this period (`VAK.TSLG AFK`). */
  holidayPay: number | null;
  ytd: { gross: number | null; net: number | null; hours: number | null };
}

/**
 * `1.057,06` / `-75,17` / `15,0000` → number. Every string NUMBER can match
 * carries a comma decimal, so the shared "last separator wins" rule reads them
 * identically to the hand-rolled Dutch one this replaced — one parser, not two.
 */
const dutch = (raw: string) => parseMoney(raw, ",");

const NUMBER = /-?\d{1,3}(?:\.\d{3})*,\d+|-?\d+,\d+/g;

/**
 * The nth number following a label — 0 is the period figure, 1 the
 * year-to-date one. Bounded to the next 120 characters so a label whose own
 * value is missing reads the following row instead of scanning the document.
 */
function num(text: string, label: string, index = 0): number | null {
  const at = text.indexOf(label);
  if (at === -1) return null;
  const tail = text.slice(at + label.length, at + label.length + 120);
  const raw = (tail.match(NUMBER) ?? [])[index];
  return raw === undefined ? null : dutch(raw);
}

export function parsePayslip(text: string): Payslip {
  // One line of whitespace, so a label never straddles a newline.
  const flat = text.replace(/\s+/g, " ");

  // `Verl. per.` — the period being paid, as MM/YYYY. The run DATE is a full
  // dd-mm-yyyy elsewhere and must not be mistaken for it, which is why this
  // looks for exactly month/year and nothing longer.
  const period = /(?<![\d-])(0?[1-9]|1[0-2])\/(20\d{2})(?![\d-])/.exec(flat);
  const month = period ? `${period[2]}-${period[1]!.padStart(2, "0")}` : null;

  const gross = num(flat, "BRUTO");
  const ytdGross = num(flat, "BRUTO", 1);
  const net = num(flat, "NETTOLOON");
  const ytdNet = num(flat, "NETTOLOON", 1);
  const hours = num(flat, "UREN GEWERKT");
  const ytdHours = num(flat, "UREN GEWERKT", 1);
  const hourlyRate = num(flat, "UURLOON");
  // VAK.TSLG AFK carries tabel/tarief/tm-period; the first is this period's.
  const holidayPay = num(flat, "VAK.TSLG AFK");

  // Deductions as gross − net rather than by summing labelled lines: the set of
  // withholdings varies by contract (pension, WGA, ZVW…), and any line missed
  // would quietly understate the tax.
  const tax = gross !== null && net !== null ? Math.round((gross - net) * 100) / 100 : null;
  const effectiveNet = net !== null && hours ? Math.round((net / hours) * 100) / 100 : null;

  return {
    month,
    gross,
    net,
    tax,
    hours,
    hourlyRate,
    effectiveNet,
    holidayPay,
    ytd: { gross: ytdGross, net: ytdNet, hours: ytdHours },
  };
}

/** Did enough come out to be worth filing? Month plus one of the two figures. */
export function payslipUsable(p: Payslip): boolean {
  return p.month !== null && (p.gross !== null || p.net !== null);
}


/* ---- the payslips ledger -------------------------------------------------
   Extracted figures are filed into a Markdown table like every other ledger
   here, so the PDF is the receipt and the note is the data. Delete the index,
   re-read the notes, and the salary history is still there. */

const HEADERS: Record<string, string> = {
  month: "month",
  period: "month",
  periode: "month",
  gross: "gross",
  bruto: "gross",
  net: "net",
  netto: "net",
  nettoloon: "net",
  tax: "tax",
  deductions: "tax",
  inhoudingen: "tax",
  hours: "hours",
  uren: "hours",
  rate: "rate",
  hourly: "rate",
  uurloon: "rate",
  file: "file",
  document: "file",
  payslip: "file",
};

export interface PayslipRow {
  month: string;
  gross: number | null;
  net: number | null;
  tax: number | null;
  hours: number | null;
  rate: number | null;
  file: string;
  /** net ÷ hours — recomputed on read so a hand-edited row stays consistent. */
  effectiveNet: number | null;
  /** 1-based line of its row in the note: how a screen finds the row again (`payslipTable`). */
  line: number;
}

/**
 * A figure out of the ledger table. This used to strip commas outright — which
 * is right for the plain decimals the app writes and turns a hand-edited Dutch
 * `900,50` into 90050 (audit B4). The shared parser reads both.
 */
const plain = parseMoney;

/** Read the payslips table, oldest first, skipping rows with no month. */
export function parsePayslipTable(content: string): PayslipRow[] {
  const lines = content.split(/\r?\n/);
  const out: PayslipRow[] = [];
  let cols: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) {
      cols = null;
      continue;
    }
    const row = cells(line);
    if (isRule(row)) continue;
    if (!cols) {
      const mapped = mapHeader(row, HEADERS);
      if (mapped.includes("month") && (mapped.includes("gross") || mapped.includes("net"))) cols = mapped;
      continue;
    }
    const get = (k: string) => {
      const at = cols!.indexOf(k);
      return at === -1 ? "" : (row[at] ?? "");
    };
    const month = get("month").trim();
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const net = plain(get("net"));
    const hours = plain(get("hours"));
    out.push({
      month,
      gross: plain(get("gross")),
      net,
      tax: plain(get("tax")),
      hours,
      rate: plain(get("rate")),
      file: get("file"),
      effectiveNet: net !== null && hours ? Math.round((net / hours) * 100) / 100 : null,
      line: i + 1,
    });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month));
}

/** File an extracted payslip into the table. Null if the note has none. */
export function appendPayslipRow(content: string, p: Payslip, file: string): string | null {
  const n = (v: number | null) => (v === null ? "" : v.toFixed(2));
  return appendRow(content, HEADERS, ["month", "gross"], {
    month: p.month ?? "",
    gross: n(p.gross),
    net: n(p.net),
    tax: n(p.tax),
    hours: p.hours === null ? "" : String(p.hours),
    rate: n(p.hourlyRate),
    file,
  });
}

/* ---- a payslip's row, typed or changed on a screen ---------------------------- */

const PAYSLIP_LEDGER: LedgerSpec = { headers: HEADERS, accepts: (m) => m.includes("month") && (m.includes("gross") || m.includes("net")), key: "month" };

/** The columns of a payslips note the app makes itself. */
export const PAYSLIP_COLUMNS = ["Month", "Gross", "Net", "Tax", "Hours", "Rate", "File"] as const;

/** Every row of the payslips note, as written. */
export const payslipTable = (content: string): LedgerTable => readLedgerTable(content, PAYSLIP_LEDGER);
export const changePayslipRow = (content: string, ref: RowRef, set: Record<string, string>): RowWrite => changeRow(content, PAYSLIP_LEDGER, ref, set);
export const removePayslipRow = (content: string, ref: RowRef): RowWrite => removeRow(content, PAYSLIP_LEDGER, ref);

/**
 * Gross and net typed by hand for a month (a payslip whose layout was not
 * read, or one with no PDF at all), as the figures a read payslip files.
 * Withheld is gross − net, as parsePayslip works it out.
 */
export function typedPayslip(month: string, gross: number | null, net: number | null): Payslip {
  const tax = gross !== null && net !== null ? Math.round((gross - net) * 100) / 100 : null;
  return { month, gross, net, tax, hours: null, hourlyRate: null, effectiveNet: null, holidayPay: null, ytd: { gross: null, net: null, hours: null } };
}
