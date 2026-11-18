/**
 * Today's Orr noticed, with nothing to say: the count of notes it read, said right for one
 * (2L, from Z-wave1's small list: "Read from 1 notes").
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NoticedModule } from "./modules.js";

const known = { people: new Set<string>(), companies: new Set<string>(), projects: new Map<string, string>(), conversations: new Set<string>() };
const health = { href: "/notes/health", onOpen: () => {} };
const quiet = (typed: boolean, notes: number) => render(<NoticedModule loaded={{ state: "ok", data: { typed, total: 0, first: null, notes } }} health={health} known={known} />);

describe("Today's Orr noticed, when nothing needs a look", () => {
  it("says one note", () => {
    quiet(true, 1);
    expect(screen.getByText("Nothing in the graph needs a look. Read from 1 note.")).toBeTruthy();
  });

  it("says many notes, typed or not", () => {
    quiet(false, 12);
    expect(screen.getByText(/^Your notes have no types yet, so there is nothing to check\. Read from 12 notes\./)).toBeTruthy();
  });
});
