/**
 * A date typed as text: day before month, a year before 1900 never a date, an empty field a
 * cleared date, anything else not a date (WEB-023's half-typed years never get written).
 */
import { describe, expect, it } from "vitest";
import { parseDateInput } from "./dateInput.js";

const TODAY = "2026-10-11";
const p = (s: string) => parseDateInput(s, TODAY);

describe("parseDateInput", () => {
  it("reads the ways a person writes a date", () => {
    expect(p("2027-01-19")).toBe("2027-01-19");
    expect(p("19 Jan 2027")).toBe("2027-01-19");
    expect(p("19 January 2027")).toBe("2027-01-19");
    expect(p("Tue 19 Jan 2027")).toBe("2027-01-19");
    expect(p("Jan 19, 2027")).toBe("2027-01-19");
    expect(p("19/1/2027")).toBe("2027-01-19");
    expect(p("19.01.2027")).toBe("2027-01-19");
    expect(p("19-1-2027")).toBe("2027-01-19");
    expect(p("3 Sept 2026")).toBe("2026-09-03");
  });

  it("a day and month alone are this year; words for days are days", () => {
    expect(p("31 Aug")).toBe("2026-08-31");
    expect(p("31/8")).toBe("2026-08-31");
    expect(p("today")).toBe("2026-10-11");
    expect(p("Tomorrow")).toBe("2026-10-12");
  });

  it("an empty field clears the date", () => {
    expect(p("")).toBe("");
    expect(p("   ")).toBe("");
  });

  it("is never a half-typed year, a day that does not exist, or a guess", () => {
    expect(p("0202-01-15")).toBeNull();
    expect(p("15 Jan 202")).toBeNull();
    expect(p("1899-12-31")).toBeNull();
    expect(p("31 Feb 2027")).toBeNull();
    expect(p("2027-02-29")).toBeNull();
    expect(p("2028-02-29")).toBe("2028-02-29");
    expect(p("13/13/2027")).toBeNull();
    expect(p("next week")).toBeNull();
    expect(p("ja 5")).toBeNull();
    expect(p("19 Jan 2027 at noon")).toBeNull();
  });
});
