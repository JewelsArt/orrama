/**
 * The map's keyboard path: arrows move a cursor to the nearest note that lies
 * that way. Before, the canvas had no tabIndex, no key handler and no name —
 * a mouse-only surface (audit: "the graph canvas has no keyboard path").
 */
import { describe, expect, it } from "vitest";
import { nearestInDirection } from "./GraphCanvas.js";

const at = (id: string, x: number, y: number) => ({ id, x, y });
const RIGHT = { x: 1, y: 0 };
const LEFT = { x: -1, y: 0 };
const UP = { x: 0, y: -1 };
const DOWN = { x: 0, y: 1 };

describe("nearestInDirection", () => {
  const o = at("o", 0, 0);
  const nodes = [o, at("right", 100, 5), at("upRight", 40, -80), at("left", -50, 0), at("down", 0, 60), at("farUp", 0, -200)];

  it("goes the way the arrow points", () => {
    expect(nearestInDirection(o, nodes, LEFT)?.id).toBe("left");
    expect(nearestInDirection(o, nodes, DOWN)?.id).toBe("down");
    expect(nearestInDirection(o, nodes, UP)?.id).toBe("upRight");
  });

  it("prefers the node straight across over a closer one off to the side", () => {
    // upRight is nearer (89 vs 100) but mostly up; right is nearly level.
    expect(nearestInDirection(o, nodes, RIGHT)?.id).toBe("right");
  });

  it("never picks a node behind it, or itself", () => {
    const edge = at("edge", 100, 5);
    expect(nearestInDirection(edge, nodes, RIGHT)).toBeNull();
    expect(nearestInDirection(o, [o], RIGHT)).toBeNull();
  });
});
