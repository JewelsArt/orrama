/** Tab inside a modal: the wrap-around rule the Dialog applies. */
import { describe, expect, it } from "vitest";
import { wrapFocus } from "./dialog.js";

describe("wrapFocus", () => {
  it("enters from outside at the first control (last with Shift)", () => {
    expect(wrapFocus(3, -1, false)).toBe(0);
    expect(wrapFocus(3, -1, true)).toBe(2);
  });
  it("wraps from the last to the first and back", () => {
    expect(wrapFocus(3, 2, false)).toBe(0);
    expect(wrapFocus(3, 0, true)).toBe(2);
  });
  it("leaves the middle to the browser, and does nothing with no controls", () => {
    expect(wrapFocus(3, 1, false)).toBeNull();
    expect(wrapFocus(3, 1, true)).toBeNull();
    expect(wrapFocus(0, -1, false)).toBeNull();
  });
});
