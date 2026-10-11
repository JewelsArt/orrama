/**
 * One status vocabulary (structure.md §2.4): every spelling a hand-written `status:` uses is
 * read as one of the ontology's seven words, and the shelf follows from it.
 */
import { describe, expect, it } from "vitest";
import { shelfOf, statusOf, statusProblems, STATUS_IDS } from "./status.js";

describe("statusOf", () => {
  it("reads the ontology's ids, their words, and their aliases", () => {
    for (const id of STATUS_IDS) expect(statusOf(id)).toBe(id);
    expect(statusOf("on track")).toBe("on-track");
    expect(statusOf("At Risk")).toBe("at-risk");
    expect(statusOf("active")).toBe("on-track");
    expect(statusOf("in progress")).toBe("on-track");
    expect(statusOf("blocked")).toBe("at-risk");
    expect(statusOf("on hold")).toBe("paused");
    expect(statusOf("on-hold")).toBe("paused");
  });

  it("reads what the old board wrote and parked on", () => {
    expect(statusOf("planning")).toBe("planned");
    expect(statusOf("sleeping")).toBe("paused");
    expect(statusOf("someday")).toBe("paused");
    expect(statusOf("done")).toBe("completed");
    expect(statusOf("shipped")).toBe("completed");
    expect(statusOf("canceled")).toBe("cancelled");
    expect(statusOf("dropped")).toBe("cancelled");
  });

  it("says nothing for an empty status or a word it does not have", () => {
    expect(statusOf("")).toBeNull();
    expect(statusOf(null)).toBeNull();
    expect(statusOf("waiting for Ines")).toBeNull();
  });
});

describe("shelfOf", () => {
  it("the note's word wins over its steps", () => {
    expect(shelfOf({ status: "sleeping", total: 5, done: 1 })).toBe("paused");
    expect(shelfOf({ status: "cancelled", total: 5, done: 5 })).toBe("cancelled");
    expect(shelfOf({ status: "archived", total: 0, done: 0 })).toBe("archived");
    expect(shelfOf({ status: "done", total: 5, done: 1 })).toBe("completed");
  });

  it("every step ticked is completed; no steps yet is active", () => {
    expect(shelfOf({ status: "on-track", total: 3, done: 3 })).toBe("completed");
    expect(shelfOf({ status: "", total: 3, done: 3 })).toBe("completed");
    expect(shelfOf({ status: "", total: 0, done: 0 })).toBe("active");
    expect(shelfOf({ status: "at-risk", total: 3, done: 2 })).toBe("active");
  });
});

describe("statusProblems", () => {
  it("flags a missing status and a word outside the vocabulary, and nothing else", () => {
    expect(statusProblems("")).toEqual(["No status yet: pick one."]);
    expect(statusProblems("waiting")).toEqual(["Its status “waiting” is not one of the vault's words."]);
    expect(statusProblems("sleeping")).toEqual([]);
  });
});
