import { describe, expect, it } from "vitest";
import {
  answerQuestion,
  blankPersona,
  monthOf,
  namesIn,
  parsePeriod,
  parsePersona,
  personaGraph,
  personaText,
  sectionOf,
  storyOf,
  unsourcedNumbers,
} from "../src/index.js";
import { SAMPLE_PERSONA } from "./persona-fixture.js";

const NOW = monthOf(2026, 11);
const p = parsePersona(SAMPLE_PERSONA);

describe("periods as people write them", () => {
  it.each([
    ["2023", monthOf(2023, 1), monthOf(2023, 12)],
    ["May 2026", monthOf(2026, 5), monthOf(2026, 5)],
    ["Spring 2026", monthOf(2026, 3), monthOf(2026, 5)],
    ["2021–2022", monthOf(2021, 1), monthOf(2022, 12)],
    ["Jan–Jun 2025", monthOf(2025, 1), monthOf(2025, 6)],
    ["Aug 2025 – Jan 2026", monthOf(2025, 8), monthOf(2026, 1)],
    ["Feb – Mar 2026", monthOf(2026, 2), monthOf(2026, 3)],
    ["Nov – Feb 2026", monthOf(2025, 11), monthOf(2026, 2)],
    ["September 2025 to January 2026", monthOf(2025, 9), monthOf(2026, 1)],
    ["2025 - 2026", monthOf(2025, 1), monthOf(2026, 12)],
  ])("%s", (text, start, end) => {
    expect(parsePeriod(text)).toEqual({ start, end });
  });

  it("an open end goes on", () => {
    expect(parsePeriod("Jul 2026–now")).toEqual({ start: monthOf(2026, 7), end: null });
    expect(parsePeriod("Sep 2026 – now")).toEqual({ start: monthOf(2026, 9), end: null });
  });

  it.each(["sometime", "", "now", "Jan", "2026–2025", "Jan 2026 – Smarch 2026", "1 – 2 – 3"])("%j is not read", (text) => {
    expect(parsePeriod(text)).toBeNull();
  });
});

describe("the note's sections", () => {
  it("knows its headings by name and ignores the rest", () => {
    expect(sectionOf("Check with Jules")).toBe("questions");
    expect(sectionOf("Rules for outside use")).toBe("rules");
    expect(sectionOf("Proof points")).toBe("proof");
    expect(sectionOf("Growing")).toBeNull();
    expect(p.sections).toEqual(["short", "now", "experience", "projects", "skills", "proof", "people", "voice", "rules", "interests", "questions"]);
  });

  it("names the person from the title, else front matter, else the account", () => {
    expect(p.name).toBe("Sam Rivera");
    expect(parsePersona("---\nname: Ada\ntags: [persona]\n---\n# Whatever\n").name).toBe("Ada");
    expect(parsePersona("## Now\n", "Fallback").name).toBe("Fallback");
    expect(p.updated).toBe("2026-11-03");
  });

  it("reads In short by length and language, bulleted, bold or plain, wrapped paragraphs kept whole", () => {
    expect(p.short.line.EN).toMatch(/^Final-year landscape student in Lisbon/);
    expect(p.short.line.FR).toMatch(/^Étudiante en dernière année/);
    expect(p.short.s30.EN).toBe("I'm Sam, a landscape student in my final year at Lisbon School of Design. I work at Oakline Builders on garden studios.");
    expect(p.short.s30.FR).toBe("Je m'appelle Sam, étudiante en paysage.");
    // "2 minutes (EN)": the heading says the language; paragraphs stay paragraphs.
    expect(p.short.min2).toEqual({ EN: "I'm Sam Rivera. I started in biology in Porto.\n\nThen I moved to Lisbon for landscape design." });
    // A ### this does not know (CV headline) is not a length.
    expect(JSON.stringify(p.short)).not.toContain("Gardens, plans");
  });

  it("reads Now as label and value, and says which row it couldn't read", () => {
    expect(p.now.map((n) => n.label)).toEqual(["Role", "Study", "Based in", "Languages"]);
    expect(p.unread).toContainEqual(expect.objectContaining({ section: "Now", reason: "a row needs a label and a value" }));
  });

  it("reads Experience with its lanes; an unreadable period is listed but said, an empty row skipped", () => {
    expect(p.experience.map((e) => e.org)).toEqual([
      "University of Porto",
      "Lisbon School of Design, Lisbon",
      "Verde Nursery",
      "Oakline Builders",
      "Oakline Builders",
      "Plotter (own app)",
      "Seed library",
    ]);
    expect(p.experience.find((e) => e.org === "Seed library")!.when).toBeNull();
    expect(p.unread).toContainEqual(expect.objectContaining({ section: "Experience", reason: 'the period "sometime" could not be read' }));
    expect(p.unread).toContainEqual(expect.objectContaining({ section: "Experience", reason: "a row needs a role or a place" }));
    expect(new Set(p.experience.map((e) => e.key)).size).toBe(p.experience.length);
  });

  it("reads Projects: ★, lists matched to the exact names (commas inside names kept), words of one's own kept", () => {
    const rooftop = p.projects.find((x) => x.name === "Rooftop beds")!;
    expect(rooftop.partOf).toEqual(["Oakline Builders", "Lisbon School of Design, Lisbon"]);
    expect(rooftop.people).toEqual(["Zora Quill", "Mira Costa"]);
    expect(p.projects.find((x) => x.name === "Plotter")!.partOf).toEqual(["Own time"]);
    expect(p.projects.filter((x) => x.star).map((x) => x.name)).toEqual(["Garden studio plans", "Courtyard survey"]);
    expect(p.projects).toHaveLength(4);
    expect(p.unread).toContainEqual(expect.objectContaining({ section: "Projects", reason: "a row needs a project name" }));
  });

  it("reads Skills: a level out of 10 or none (said), Proof as project names, the Also row apart", () => {
    expect(p.skills.map((s) => [s.name, s.level])).toEqual([
      ["Planting design", 9],
      ["CAD", 7],
      ["Site survey", 6],
      ["Building with AI", null],
    ]);
    expect(p.skills[0]!.proof).toEqual(["Garden studio plans", "Rooftop beds"]);
    expect(p.skillsAlso).toBe("QGIS, Excel");
    expect(p.skillNotes).toEqual(["Ways of working: drawing by hand first."]);
    expect(p.unread).toContainEqual(expect.objectContaining({ section: "Skills", reason: 'the level "lots" is not a number out of 10' }));
  });

  it("reads Proof points, their source (by name, or by the number a row quotes), and the lines under them", () => {
    expect(p.proof.map((f) => [f.number, f.source])).toEqual([
      ["14", "project:garden-studio-plans"],
      ["9", "project:courtyard-survey"],
      ["1,200+", "exp:verde-nursery-shop-assistant"],
      ["3", "project:plotter"],
    ]);
    expect(p.proofWords).toMatch(/^Zora Quill called/);
    expect(p.proofInternal).toBe("client names and prices.");
    expect(p.unread).toContainEqual(expect.objectContaining({ section: "Proof points", reason: "a row needs a number and what it is" }));
  });

  it("reads People, Voice (registers by their bold label), Rules, Interests; code is not persona text", () => {
    expect(p.people.map((x) => x.name)).toEqual(["Zora Quill", "Mira Costa"]);
    expect(p.voice).toEqual([
      { label: null, text: "Warm but plain. Story first, then the numbers." },
      { label: "English, work", text: '"Hi [first name]," then a few lines, "Best, Sam".' },
      { label: "French", text: '"vous" with outside contacts.' },
    ]);
    expect(p.rules).toHaveLength(2);
    expect(p.interests).toBe("Drawing, hiking, seed swaps.");
  });

  it("reads open questions: a short name, the options a **or** gives, an answer once written", () => {
    expect(p.questions.map((q) => [q.name, q.options, q.answer])).toEqual([
      ["Target role", ["garden designer", "landscape architect", "a master's first"], null],
      ["Graduation date", [], null],
      ["Portfolio", [], "Yes, in December."],
    ]);
  });

  it("never throws, whatever the note holds", () => {
    for (const text of ["", "---\n---\n", "## Experience\n|", "## Projects\n| a |\n|---|\n| ★ |\n", "## Check with me\n- \n- :\n", "\u0000## In short\n### One line\nEN:"]) {
      expect(() => parsePersona(text)).not.toThrow();
    }
  });
});

describe("what links to what", () => {
  const g = personaGraph(p, NOW);

  it("a project is part of the place it names, during its time there", () => {
    expect(g.expsOfProject("garden-studio-plans")).toEqual(["oakline-builders-intern-garden-studios"]);
    // Two Oakline rows; the rooftop beds (Oct 2026 on) fall in the second.
    expect(g.expsOfProject("rooftop-beds")).toEqual(["oakline-builders-garden-designer", "lisbon-school-of-design-lisbon-landscape-design"]);
    expect(g.expsOfProject("plotter")).toEqual([]);
  });

  it("skills come from the project's column and from each skill's Proof", () => {
    expect(g.skillsOfProject("plotter").sort()).toEqual(["building-with-ai", "cad"]);
    expect(g.projectsOfSkill("site-survey")).toEqual(["courtyard-survey"]);
  });

  it("related() lights a thing and everything it touches, itself first", () => {
    const r = g.related("person:mira-costa");
    expect(r[0]).toBe("person:mira-costa");
    expect(r).toEqual(expect.arrayContaining(["project:courtyard-survey", "project:rooftop-beds", "exp:lisbon-school-of-design-lisbon-landscape-design"]));
    expect(g.related("proof:14-studio-plans-drawn-at-oakline-builders")).toEqual(expect.arrayContaining(["project:garden-studio-plans", "skill:planting-design", "person:zora-quill"]));
    expect(g.related("exp:verde-nursery-shop-assistant")).toContain("proof:1-200-plants-sold-in-one-spring");
  });

  it("lanes: a project takes its place's, one of its own is Built", () => {
    expect(g.laneOf("project:courtyard-survey")).toBe("Study");
    expect(g.laneOf("project:plotter")).toBe("Built");
    expect(g.laneOf("proof:9-courtyard-survey-grade")).toBe("Study");
  });
});

describe("the story", () => {
  const s = storyOf(p, NOW)!;

  it("lanes in order Study, Work, Built; bars packed into rows that don't overlap", () => {
    // Porto (2020–2021) and Lisbon (2021–2026) share 2021: two rows.
    expect(s.lanes).toEqual([
      { lane: "Study", rows: 2 },
      { lane: "Work", rows: 1 },
      { lane: "Built", rows: 1 },
    ]);
    for (const lane of s.lanes) {
      const bars = s.bars.filter((b) => b.lane === lane.lane).sort((a, b) => a.left - b.left);
      for (let i = 1; i < bars.length; i++) if (bars[i]!.row === bars[i - 1]!.row) expect(bars[i]!.left).toBeGreaterThanOrEqual(bars[i - 1]!.left + bars[i - 1]!.width - 0.001);
    }
  });

  it("places bars by date: later starts sit further right, an open one runs to the end, now inside the last year", () => {
    const at = (org: string) => s.bars.find((b) => b.label.startsWith(org))!;
    expect(at("University of Porto").left).toBe(0);
    expect(at("Verde Nursery").left).toBeGreaterThan(at("University of Porto").left);
    expect(at("Plotter").open).toBe(true);
    expect(at("Plotter").left + at("Plotter").width).toBeCloseTo(100);
    expect(at("Plotter").now).toBe(true);
    expect(at("Verde Nursery").now).toBe(false);
    const y2026 = s.years.find((y) => y.year === 2026)!;
    expect(s.now).toBeGreaterThan(y2026.left);
    expect(s.now).toBeLessThanOrEqual(100);
    // Labels: the place, then the role.
    expect(at("Oakline Builders").label).toBe("Oakline Builders · Intern, garden studios");
  });

  it("gives years room by how much happened in them, each labelled, the widths adding up", () => {
    expect(s.years.map((y) => y.year)).toEqual([2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect(s.years.reduce((a, y) => a + y.width, 0)).toBeCloseTo(100);
    const w = (y: number) => s.years.find((x) => x.year === y)!.width;
    // 2025 had a degree and an internship; 2023 only the degree.
    expect(w(2025)).toBeGreaterThan(w(2023));
  });

  it("has nothing to draw without a dated row", () => {
    expect(storyOf(parsePersona("## Experience\n\n| Period | Role |\n|---|---|\n| soon | Gardener |\n"), NOW)).toBeNull();
  });
});

describe("writing back", () => {
  it("an answer goes on its question's line, nothing else changes, and a changed note is refused", () => {
    const q = p.questions[0]!;
    const next = answerQuestion(SAMPLE_PERSONA, 0, q.raw, "Garden designer", "2026-11-19")!;
    expect(next).not.toBeNull();
    const changed = next.split("\n").filter((l, i) => l !== SAMPLE_PERSONA.split("\n")[i]);
    expect(changed).toEqual([`- ${q.raw} **Answer (2026-11-19):** Garden designer`]);
    expect(parsePersona(next).questions[0]!.answer).toBe("Garden designer");
    expect(answerQuestion(SAMPLE_PERSONA, 0, "something else", "x", "2026-11-19")).toBeNull();
    expect(answerQuestion(SAMPLE_PERSONA, 9, q.raw, "x", "2026-11-19")).toBeNull();
  });

  it("the fenced '## Voice' in the sample is not a Check-with section to write into", () => {
    expect(answerQuestion("## Voice\n- a\n", 0, "a", "x", "2026-11-19")).toBeNull();
  });

  it("a blank persona reads back with every section and nothing in them", () => {
    const blank = parsePersona(blankPersona("Ada Lane", "2026-11-19"));
    expect(blank.name).toBe("Ada Lane");
    expect(blank.sections).toEqual(["short", "now", "experience", "projects", "skills", "proof", "people", "voice", "rules", "interests", "questions"]);
    expect(blank.experience).toEqual([]);
    expect(blank.now).toEqual([]);
    expect(blank.short.line).toEqual({});
  });
});

describe("the note's own text", () => {
  it("a Source column names the row's note: a [[link]]'s target, else its words", () => {
    const n = parsePersona("## Experience\n\n| Period | Role | Organisation | Lane | Source |\n|---|---|---|---|---|\n| 2024 | Gardener | Own | Work | [[Notes/Garden log\\|log]] |\n| 2025 | Cook | Café | Work | Kitchen diary |\n| 2026 | Baker | Shop | Work | |\n");
    expect(n.experience.map((e) => e.source)).toEqual(["Notes/Garden log", "Kitchen diary", null]);
  });

  it("personaText gives the sections asked under their own headings, code and unknown sections left out", () => {
    const t = personaText(SAMPLE_PERSONA, ["voice", "rules"]);
    expect(t.startsWith("## Voice\n\n- Warm but plain.")).toBe(true);
    expect(t).toContain("## Rules for outside use\n\n- Never name Oakline's clients.");
    expect(t).not.toContain("## Skills");
    const all = personaText(SAMPLE_PERSONA);
    expect(all).not.toContain("## Growing");
    expect(all).not.toContain("a fenced heading");
    expect(all.match(/^## /gm)).toHaveLength(11);
  });
});

describe("numbers", () => {
  it("a draft may quote only numbers the note holds", () => {
    expect(unsourcedNumbers("My grade was 9 and I drew 14 plans.", SAMPLE_PERSONA)).toEqual([]);
    expect(unsourcedNumbers("My grades: 9 and 8.7, and 1,200 plants.", SAMPLE_PERSONA)).toEqual(["8.7"]);
  });

  it("namesIn takes the longest known name first", () => {
    expect(namesIn("Lisbon School of Design, Lisbon, Oakline Builders", ["Lisbon School of Design", "Lisbon School of Design, Lisbon", "Oakline Builders"])).toEqual([
      "Lisbon School of Design, Lisbon",
      "Oakline Builders",
    ]);
  });
});
