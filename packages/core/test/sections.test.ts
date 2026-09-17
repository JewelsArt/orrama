import { describe, expect, it } from "vitest";
import { appendToSection, readSection, readSectionItems, writeSection } from "../src/sections.js";

const NOTE = `---
title: Thesis
---
# Thesis

Intro line.

## Goals
- Ship the research plan
- Defend in January

## Decisions
- **2026-08-20** — scope to NL vs FR

### Rejected
- weekly interviews

## People
- [[Pieter Haans]]
`;

describe("markdown sections", () => {
  it("reads a section and stops at the next same-level heading", () => {
    expect(readSection(NOTE, "Goals")).toBe("- Ship the research plan\n- Defend in January");
    expect(readSectionItems(NOTE, "People")).toEqual(["[[Pieter Haans]]"]);
  });

  it("keeps deeper headings inside their parent section", () => {
    expect(readSection(NOTE, "Decisions")).toContain("### Rejected");
    expect(readSection(NOTE, "Decisions")).toContain("weekly interviews");
  });

  it("ignores headings inside code fences", () => {
    const fenced = "# N\n\n```\n## Goals\nnot a heading\n```\n\n## Goals\nreal\n";
    expect(readSection(fenced, "Goals")).toBe("real");
  });

  it("returns empty for a missing section and creates it on write", () => {
    expect(readSection(NOTE, "Prompt")).toBe("");
    const out = writeSection(NOTE, "Prompt", "You are helping with the AMSIB thesis.");
    expect(readSection(out, "Prompt")).toBe("You are helping with the AMSIB thesis.");
    // the rest of the note survives
    expect(readSection(out, "Goals")).toContain("Defend in January");
    expect(out).toContain("title: Thesis");
  });

  it("replaces a body without touching its neighbours", () => {
    const out = writeSection(NOTE, "Goals", "- One goal only");
    expect(readSection(out, "Goals")).toBe("- One goal only");
    expect(readSection(out, "People")).toBe("- [[Pieter Haans]]");
    expect(out).toContain("Intro line.");
  });

  it("appends newest last, creating the section when absent", () => {
    const once = appendToSection(NOTE, "Inbox", "- ask Pieter for the Q3 export");
    const twice = appendToSection(once, "Inbox", "- book defence room");
    expect(readSectionItems(twice, "Inbox")).toEqual(["ask Pieter for the Q3 export", "book defence room"]);
    expect(readSection(twice, "Goals")).toContain("Ship the research plan");
  });
});
