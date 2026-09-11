import { describe, expect, it } from "vitest";
import { appendPayslipRow, parsePayslip, parsePayslipTable, payslipUsable } from "../src/payslip.js";

/**
 * A Loket.nl payslip's text layer, with the real layout and invented figures —
 * the column order, the label set and the flattening are what the parser cares
 * about, and no one's actual salary belongs in a repo.
 */
const SLIP = `Werknr. BSN Functiegr. Geb. datum In dienst Uit dienst Basisloon Bet.per. Aant.per Min. loon Ploeg
Fulltime Parttime ZW WW WAO ZVW Afr.SV PF 1 PF 2 PF 3 PF 4 Pens. grsl. LB tab. Per tab. LH kort LH % Fisc.jaarloon
U I T T E B E T A L E N Functie Strook Volgnr. Runnr. Datum run Verl. per. Periode Tm-periode Tabel Tarief Tabel Tarief
C U M U L A T I E S S P E C I F I C A T I E O P B O U W T M - P E R I O D E ©2009 loket.nl
204 01-01-2000 01-01-2025 20,00 UUR 1 14,99 1 40,00 * * * * J WIT MND J 9.000,00
SOME ROLE PERIODE 7 17 07-08-2026 07/2026
Contract: Bepaalde tijd,Schriftelijk (Ja),Oproepkracht (Ja)
UREN GEWERKT 100,00 400,00 UITB.VAK.UREN 5,00 22,80 DEELTIJDFACTOR 32,74 156,63
DGN SOC VERZ 8,00 37,00 MUT. AFKVAKGLD 978,76 4.463,80 VAK.UREN AFK 903,75 4.121,70
ARBEIDSKORT. 100,42 313,42 WG.HEFF.ZVW 64,48 294,07 V/H SOC.PLLOON 2.000,00 8.000,00
UURLOON 20,0000 LOON/SALARIS 903,75 903,75 4.121,70 VAK.TSLG AFK 160,00 160,00 640,00
VAK.UREN AFK 75,01 75,01 342,10 BRUTO 2.000,00 8.000,00 HEFF.PL.LOON 2.000,00 8.000,00
LB/PR.VOLKSVZ. -380,00 1.520,00 PREMIE WGA-WHK -20,00 80,00 NETTOLOON 1.600,00 6.400,00
SALARIS 1.600,00(NL00BANK0000000000) € 1.600,00`;

describe("parsePayslip", () => {
  it("reads the period being paid, not the run date", () => {
    // "07-08-2026" is when payroll ran; "07/2026" is the month worked.
    expect(parsePayslip(SLIP).month).toBe("2026-07");
  });

  it("reads the period figures and their year-to-date column", () => {
    const p = parsePayslip(SLIP);
    expect(p.gross).toBe(2000);
    expect(p.net).toBe(1600);
    expect(p.hours).toBe(100);
    expect(p.hourlyRate).toBe(20);
    expect(p.holidayPay).toBe(160);
    expect(p.ytd).toEqual({ gross: 8000, net: 6400, hours: 400 });
  });

  it("takes tax as gross minus net, not by summing withholding lines", () => {
    // 380 + 20 happens to match here, but the set of deductions varies by
    // contract — subtracting is exact whatever the payslip lists.
    expect(parsePayslip(SLIP).tax).toBe(400);
  });

  it("computes what an hour actually paid, which no line on the slip states", () => {
    const p = parsePayslip(SLIP);
    expect(p.effectiveNet).toBe(16); // 1600 / 100
    // Below the €20 contractual rate here — tax outweighs the allowances.
    expect(p.hourlyRate! > p.effectiveNet!).toBe(true);
  });

  it("reads Dutch thousands and decimals", () => {
    const p = parsePayslip("BRUTO 1.057,06 4.820,90 NETTOLOON 978,40 4.641,16 Verl. per. 03/2026");
    expect(p.gross).toBe(1057.06);
    expect(p.net).toBe(978.4);
    expect(p.tax).toBe(78.66);
  });

  it("returns nulls for an unfamiliar document instead of guessing", () => {
    const p = parsePayslip("Dear Jules,\n\nThanks for your application.\n");
    expect(p).toMatchObject({ month: null, gross: null, net: null, tax: null });
    expect(payslipUsable(p)).toBe(false);
  });

  it("is usable once a month and one figure are found", () => {
    expect(payslipUsable(parsePayslip(SLIP))).toBe(true);
    expect(payslipUsable(parsePayslip("Verl. per. 07/2026 and nothing else"))).toBe(false);
  });

  it("does not divide by zero on a payslip with no hours", () => {
    const p = parsePayslip("Verl. per. 07/2026 UREN GEWERKT 0,00 0,00 BRUTO 500,00 500,00 NETTOLOON 400,00 400,00");
    expect(p.effectiveNet).toBeNull();
  });
});

const LEDGER = `---
title: Payslips
tags: [payslips]
---
# Payslips

| Month | Gross | Net | Tax | Hours | Rate | File |
|-------|-------|-----|-----|-------|------|------|
| 2026-06 | 900.00 | 850.00 | 50.00 | 55 | 15.00 | jun.pdf |
`;

describe("payslips ledger", () => {
  it("files an extracted payslip as a row", () => {
    const out = appendPayslipRow(LEDGER, parsePayslip(SLIP), "jul.pdf")!;
    const rows = parsePayslipTable(out);
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-07"]);
    expect(rows[1]).toMatchObject({ gross: 2000, net: 1600, tax: 400, hours: 100, file: "jul.pdf" });
  });

  it("recomputes the effective rate on read, so a hand-edited row stays true", () => {
    const edited = LEDGER.replace("| 900.00 | 850.00 | 50.00 | 55 |", "| 900.00 | 800.00 | 100.00 | 100 |");
    expect(parsePayslipTable(edited)[0]!.effectiveNet).toBe(8); // 800 / 100
  });

  it("returns rows oldest first whatever order they were written in", () => {
    const shuffled = `${LEDGER}| 2026-04 | 700.00 | 660.00 | 40.00 | 44 | 15.00 |  |
`;
    expect(parsePayslipTable(shuffled).map((r) => r.month)).toEqual(["2026-04", "2026-06"]);
  });

  it("skips rows whose month is not a real period", () => {
    const junk = `${LEDGER}| tbd | 700.00 | 660.00 | 40.00 | 44 | 15.00 |  |
`;
    expect(parsePayslipTable(junk)).toHaveLength(1);
  });

  it("refuses a note with no payslips table", () => {
    expect(appendPayslipRow("# Payslips\n\nnone yet\n", parsePayslip(SLIP), "x.pdf")).toBeNull();
  });
});
