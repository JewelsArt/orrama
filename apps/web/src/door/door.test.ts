import { describe, expect, it } from "vitest";
import { ApiError } from "../api.js";
import { areaSpans, assignDots, MAX_DOTS } from "./dots.js";
import { countingLine, foundDetail, foundLine, shapeOf } from "./shape.js";
import { cancelled, doorError, waitOf } from "./voice.js";
import type { TreeNote } from "../api.js";

describe("the door's voice", () => {
  it("never repeats the server's words, and names what to do", () => {
    const said = doorError(new ApiError(401, "invalid email or password"), "signin").text;
    expect(said).toBe("That email and password don't match. Check them and try again.");
    expect(said).not.toMatch(/invalid/);
  });

  it("says how long to wait, from the server's own figure", () => {
    expect(doorError(new ApiError(429, "too many failed sign-ins — try again in 15 min"), "signin").text).toBe("Too many tries from here. Try again in 15 minutes.");
    expect(doorError(new ApiError(429, "too many attempts — try again in 42s"), "passcode").text).toBe("Too many wrong passcodes. Try again in 42 seconds.");
    expect(doorError(new ApiError(429, "slow down"), "signin").text).toBe("Too many tries from here. Wait a little, then try again.");
    expect(waitOf("try again in 1 min")).toBe("1 minute");
    expect(waitOf("try again in 1s")).toBe("1 second");
  });

  it("sends a passcode lockout to the password", () => {
    expect(doorError(new ApiError(403, "too many attempts — sign in with your password"), "passcode")).toEqual({
      text: "Too many wrong passcodes. Use your password to get back in.",
      passwordOnly: true,
    });
    expect(doorError(new ApiError(401, "incorrect passcode"), "passcode").passwordOnly).toBeUndefined();
  });

  it("tells a server that doesn't answer from one that says no", () => {
    expect(doorError(new TypeError("Failed to fetch"), "signin").text).toMatch(/isn't answering/);
    expect(doorError(new ApiError(500, "internal error"), "signin").text).toMatch(/went wrong/);
  });

  it("says a password, not an email, is wrong on the lock", () => {
    expect(doorError(new ApiError(401, "invalid email or password"), "password").text).toBe("That password isn't right. Try again.");
  });

  it("first run on a server someone else set up", () => {
    expect(doorError(new ApiError(403, "an invite is required to join this workspace"), "register").text).toMatch(/already set up/);
  });

  it("a dismissed Touch ID prompt is not an error", () => {
    expect(cancelled(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"))).toBe(true);
    expect(cancelled(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(cancelled(new ApiError(400, "challenge expired — try again"))).toBe(false);
  });
});

const note = (id: string, category: string): TreeNote => ({ id, path: `${id}.md`, folder: "", title: id, hash: "h", mtimeMs: 0, tags: [], openTasks: 0, category });

describe("the vault's shape", () => {
  it("counts each area's notes, projects and people, in the areas' drawing order", () => {
    const tree = [note("a", "work"), note("b", "work"), note("c", "school"), note("d", "personal"), note("e", "mystery")];
    const shape = shapeOf(tree, new Set(["a"]), new Set(["b", "d"]));
    expect(shape.areas).toEqual([
      { color: "--c3", notes: 1, projects: 0, people: 0 }, // school
      { color: "--c1", notes: 2, projects: 1, people: 1 }, // work
      { color: "--c2", notes: 1, projects: 0, people: 1 }, // personal
      { color: "--c-other", notes: 1, projects: 0, people: 0 }, // in no area
    ]);
  });

  it("an empty vault has no areas", () => {
    expect(shapeOf([], new Set(), new Set()).areas).toEqual([]);
  });
});

describe("first run's sentences", () => {
  const c = { notes: 312, people: 41, companies: 12, projects: 9, links: 1804 };
  it("says what it found", () => {
    expect(foundLine(c)).toBe("I found 312 notes.");
    expect(foundDetail(c)).toBe("41 people, 12 companies, 9 projects and 1,804 links between them.");
  });
  it("in the singular, and without the parts that are zero", () => {
    expect(foundLine({ ...c, notes: 1 })).toBe("I found 1 note.");
    expect(foundDetail({ notes: 3, people: 1, companies: 0, projects: 1, links: 0 })).toBe("1 person and 1 project.");
    expect(foundDetail({ notes: 3, people: 0, companies: 0, projects: 0, links: 0 })).toBe("");
  });
  it("an empty folder is said, not counted", () => {
    expect(foundLine({ notes: 0, people: 0, companies: 0, projects: 0, links: 0 })).toBe("No notes here yet.");
  });
  it("counts up while the dots arrive", () => {
    expect(countingLine(c, 0.5)).toBe("156 notes · 21 people · 6 companies · 5 projects");
    expect(countingLine({ ...c, companies: 1 }, 1)).toBe("312 notes · 41 people · 1 company · 9 projects");
  });
});

describe("the gathered vault", () => {
  it("gives each area an arc by its notes, and none to an empty one", () => {
    const spans = areaSpans([100, 0, 100, 50]);
    expect(spans[1]).toBeNull();
    const width = (s: [number, number] | null | undefined) => (s ? s[1] - s[0] : 0);
    expect(width(spans[0])).toBeCloseTo(width(spans[2]));
    expect(width(spans[3])).toBeLessThan(width(spans[0]));
    // A big area does not swallow a small one: the share is the count to the power 0.8.
    expect(width(spans[3]) / width(spans[0])).toBeCloseTo(Math.pow(0.5, 0.8));
    // The arcs and their gaps go once round.
    const total = spans.reduce((t, s) => t + width(s), 0) + 0.05 * 3;
    expect(total).toBeCloseTo(Math.PI * 2);
  });

  it("one dot per note in a small vault; the halo's dots in a big one, in proportion", () => {
    expect(assignDots({ areas: [{ color: "--c1", notes: 13, projects: 2, people: 4 }] })).toHaveLength(13);
    const big = assignDots({
      areas: [
        { color: "--c1", notes: 3000, projects: 30, people: 0 },
        { color: "--c2", notes: 1000, projects: 0, people: 200 },
      ],
    });
    expect(big.length).toBeLessThanOrEqual(MAX_DOTS);
    const work = big.filter((d) => d.area === 0).length;
    const personal = big.filter((d) => d.area === 1).length;
    expect(work / personal).toBeCloseTo(3, 0);
    expect(big.filter((d) => d.area === 1 && d.kind === 1).length).toBe(Math.round((200 * MAX_DOTS) / 4000));
  });

  it("projects come first, so they gather first", () => {
    const dots = assignDots({ areas: [{ color: "--c1", notes: 10, projects: 2, people: 3 }] });
    expect(dots.map((d) => d.kind)).toEqual([0, 0, 1, 1, 1, 2, 2, 2, 2, 2]);
  });

  it("no notes, no dots", () => {
    expect(assignDots({ areas: [] })).toEqual([]);
  });
});
