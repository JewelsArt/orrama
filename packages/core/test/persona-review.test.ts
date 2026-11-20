/**
 * The Me page's review fixes (20 Nov 2026): what Jules's real note showed going wrong. Each case
 * is the smallest note that showed it.
 */
import { describe, expect, it } from "vitest";
import { answerQuestion, monthOf, numbersIn, parsePersona, personaGraph, quotableText, storyOf, unsourcedNumbers } from "../src/index.js";

const NOW = monthOf(2026, 11);

const NOTE = `---
title: Persona — Kim
tags:
  - persona
---

# Persona — Kim

## In short

### One line

- **EN:** Final-year student who builds tools.

### CV headline

- **Title line:** Budgets and the tools behind them.
- **In short:** Not the headline.

## Experience

| Period | Role | Organisation | What I did | Lane |
|---|---|---|---|---|
| 2022–2027 | Business major | City School, Amsterdam | Corporate finance, financial risk | Study |
| Sep 2025–Jan 2026 | Data role, simulation company | City School (SAP lab) | SAP → Sheets → Looker reporting pipeline | Study |
| 2025 | Data and sales | Kawa | Cleaned 114,000+ towns into sales targets | Work |
| Feb–Jun 2026 | Finance intern | Acme | Business case, company dashboard | Work |
| Aug 2026–Jan 2027 | Thesis intern | Acme | Thesis plus invoice router | Work |
| Jul 2026–now | Builder | Plotter (own app) | A planner app | Built |

## Projects

| Project | When | What it is | My part | Outcome | Skills | People | Part of | Outside use |
|---|---|---|---|---|---|---|---|---|
| ★ Office expansion business case | Feb – Mar 2026 | A scenario model. | Built it. | Above standard. | | | Acme | Yes. |
| ★ Company dashboard | Spring 2026 | Six pages. | Built it. | Presented. | | | Acme | Yes. |
| Invoice mailbox router | Sep 2026 – now | Sorts invoices. | Built it. | 10 of 10 test mails right. | | | Acme | Yes. |
| Sales forecast | Spring 2026 | A forecast. | Built it. | Defended. | | | Acme | Yes. |
| SAP reporting pipeline | Sep 2025 – Jan 2026 | Reporting. | Data role. | 77 hours. | | | City School, Amsterdam | Yes. |
| Plotter | Jul 2026 – now | A planner. | Built it. | Shipped. | | | Own time | Yes. |

### Project details

- **Office expansion business case.** The CEO weighed a second office.
- **Plotter.** Plain files, a map, a planner.

## Proof points

| Number | What |
|---|---|
| 3 · 9 | Scenarios and linked sheets in the office expansion model |
| 6 · 10+ | Dashboard pages and KPIs defined |
| 3 | Languages the router answers in |
| 114,000+ | Towns cleaned into sales targets |
| 8.6 | Financial Risk Management |

Internal only, never outside: 2,717 client messages.

## Growing

- **Skills I want:** analysis, storytelling.

## Plain-language terms

| Term | Plain meaning |
|---|---|
| P&L | Revenue minus costs. |

## Check with Kim

- Target role: traineeship **or** controller?
- Dashboard: how many sources were connected (4, 9 or 10)?
- Graduation date: January, or later because of a resit
  in March 2027?
- Target role, more evidence: the online CV is aimed at controller roles.
- Dashboard sources, more evidence: the CV names five.
`;

const p = parsePersona(NOTE);
const g = personaGraph(p, NOW);

describe("what the page couldn't show", () => {
  it("reads the headline, the story behind projects, Growing and the terms", () => {
    expect(p.headline).toBe("Budgets and the tools behind them.");
    expect(p.projects.find((x) => x.name === "Office expansion business case")!.details).toBe("The CEO weighed a second office.");
    expect(p.projects.find((x) => x.name === "Plotter")!.details).toBe("Plain files, a map, a planner.");
    expect(p.growing).toEqual([{ label: "Skills I want", text: "analysis, storytelling." }]);
    expect(p.terms).toEqual([{ term: "P&L", plain: "Revenue minus costs." }]);
  });
});

describe("links the note implies", () => {
  it("a place whose own words name the project is its row, beside what Part of names", () => {
    expect(g.expsOfProject("sap-reporting-pipeline")).toContain("city-school-sap-lab-data-role-simulation-company");
    expect(g.expsOfProject("plotter")).toEqual(["plotter-own-app-builder"]);
    expect(g.projectsOfExp("plotter-own-app-builder")).toEqual(["plotter"]);
  });

  it("a proof point finds its source by the number a row quotes, most of a name, or a word only one project has", () => {
    const src = (n: string) => p.proof.find((f) => f.number === n)!.source;
    expect(src("3 · 9")).toBe("project:office-expansion-business-case");
    expect(src("6 · 10+")).toBe("project:company-dashboard");
    expect(src("3")).toBe("project:invoice-mailbox-router");
    // "Sales forecast" shares "sales" with it, but the row that quotes 114,000+ says where it is from.
    expect(src("114,000+")).toBe("exp:kawa-data-and-sales");
    expect(src("8.6")).toBe("exp:city-school-amsterdam-business-major");
  });
});

describe("the timeline ends at now", () => {
  const s = storyOf(p, NOW)!;
  const at = (short: string) => s.bars.find((b) => b.short === short)!;

  it("a year written alone never stretches it; a place still going stops at now", () => {
    // 2027 is on the axis only for the thesis's January, which the note gives to the month.
    expect(s.years.at(-1)!.year).toBe(2027);
    expect(s.years.at(-1)!.width).toBeLessThan(s.years.at(-2)!.width / 6);
    expect(at("Plotter").left + at("Plotter").width).toBeCloseTo(s.now);
    expect(at("Plotter").open).toBe(true);
    expect(at("City School").left + at("City School").width).toBeCloseTo(100);
    expect(at("City School").open).toBe(true);
    expect(s.now).toBeLessThan(100);
  });
});

describe("open questions", () => {
  it("'… more evidence' joins the question it is about; each keeps its place among the bullets", () => {
    expect(p.questions.map((q) => [q.index, q.name])).toEqual([
      [0, "Target role"],
      [1, "Dashboard"],
      [2, "Graduation date"],
    ]);
    expect(p.questions[0]!.evidence).toEqual(["the online CV is aimed at controller roles."]);
    expect(p.questions[1]!.evidence).toEqual(["the CV names five."]);
  });

  it("a question wrapped onto a second line is answered on its last line", () => {
    const q = p.questions.find((x) => x.name === "Graduation date")!;
    expect(q.raw).toBe("Graduation date: January, or later because of a resit");
    const next = answerQuestion(NOTE, q.index, q.raw, "January 2027", "2026-11-20")!;
    expect(next).toContain("- Graduation date: January, or later because of a resit\n  in March 2027? **Answer (2026-11-20):** January 2027\n");
    expect(parsePersona(next).questions.find((x) => x.name === "Graduation date")!.answer).toBe("January 2027");
  });

  it("a second answer replaces the first where it stands", () => {
    const once = answerQuestion(NOTE, 0, p.questions[0]!.raw, "traineeship", "2026-11-20")!;
    const q = parsePersona(once).questions[0]!;
    const twice = answerQuestion(once, q.index, q.raw, "controller", "2026-11-21")!;
    expect(twice).toContain("- Target role: traineeship **or** controller? **Answer (2026-11-21):** controller\n");
    expect(twice).not.toContain("2026-11-20");
  });
});

describe("numbers Orr may quote", () => {
  it("reads a French thousands space as one number", () => {
    expect(numbersIn("114 000 communes et 3 jours")).toEqual(["114000", "3"]);
    expect(unsourcedNumbers("Plus de 114 000 communes", NOTE)).toEqual([]);
  });

  it("never the open questions' numbers or what is internal only", () => {
    const q = quotableText(NOTE);
    expect(unsourcedNumbers("I connected 4 sources", q)).toEqual(["4"]);
    expect(unsourcedNumbers("2,717 messages", q)).toEqual(["2717"]);
    expect(unsourcedNumbers("9 linked sheets and 8.6 in risk", q)).toEqual([]);
  });
});
