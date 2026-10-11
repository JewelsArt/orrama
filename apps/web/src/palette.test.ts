/** A hand-built colour profile drives Orrama's five life areas, in the vault's order. */
import { describe, expect, it } from "vitest";
import { PROFILE_VAR_NAMES, profileVars, type VisionProfile } from "./palette.js";

// One hex per PALETTE_SLOTS entry: School, Work, Knowledge, Claude & tools, Personal, Projects, Spending.
const profile: VisionProfile = {
  id: "p1",
  name: "Mine",
  colors: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666", "#777777"],
};
const pinned = { ok: "#1E7B43", warn: "#7F6000", danger: "#C0392B" };

describe("profileVars", () => {
  it("puts each area's pick on its tokens.css slot", () => {
    const v = profileVars(profile, "#FFFFFF", "light", pinned);
    expect([v["--c1"], v["--c2"], v["--c3"], v["--c4"], v["--c5"]]).toEqual([
      "#222222", // c1 Work
      "#555555", // c2 Personal
      "#111111", // c3 School
      "#444444", // c4 Claude & tools
      "#333333", // c5 Knowledge
    ]);
  });

  it("keeps status pinned, the new --late with it", () => {
    const v = profileVars(profile, "#FFFFFF", "light", pinned);
    expect([v["--ok"], v["--warn"], v["--danger"], v["--late"]]).toEqual(["#1E7B43", "#7F6000", "#C0392B", "#C0392B"]);
  });

  it("can clear everything it sets", () => {
    const v = profileVars({ ...profile, brand: "#FEA267" }, "#FFFFFF", "dark", pinned);
    expect(Object.keys(v).filter((k) => !PROFILE_VAR_NAMES.includes(k))).toEqual([]);
  });
});
