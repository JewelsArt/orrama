/**
 * Orr in the app stands where he stands on the boards: the placements below are
 * ~/orrama-redesign/mockups/orrsprite.py's own output for the same calls (11 October).
 */
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { avatarBox, avatarCrop, poseBox } from "./geometry.js";
import { Avatar, avatarName, HeadMark, Orr, POSE_FADE_MS } from "./Orr.js";

const r1 = (n: number) => Math.round(n * 10) / 10;

describe("geometry, against orrsprite.py", () => {
  it("poses: X.pose('sit', 48), X.pose('hello', 112), X.pose('peek', 64)", () => {
    const at = (b: number) => {
      const x = poseBox(b);
      return [r1(x.width), r1(x.ground), r1(x.height)];
    };
    expect(at(48)).toEqual([91.6, 60.8, 76.2]);
    expect(at(112)).toEqual([213.6, 141.8, 177.7]);
    expect(at(64)).toEqual([122.1, 81.1, 101.6]);
  });

  it("an avatar standing: X.avatar('victorr', 112)", () => {
    const x = avatarBox(112);
    expect([r1(x.width), r1(x.ground), r1(x.height)]).toEqual([183.7, 141.1, 151.3]);
  });

  it("an avatar's head in a circle: X.avatar_crop('victorr', 38) and ('orra', 96)", () => {
    const c = (n: string, d: number) => Object.values(avatarCrop(n, d)).map(r1);
    expect(c("victorr", 38)).toEqual([80.5, 66.3, -22.2, -6.8]);
    expect(c("orra", 96)).toEqual([203.5, 167.6, -41.6, -27.6]);
  });
});

describe("<Orr>", () => {
  it("stands in a box as wide as his cell and as tall as his ground line", () => {
    const { container } = render(<Orr pose="sit" size={48} />);
    const box = container.querySelector<HTMLElement>(".orrw")!;
    expect([box.style.width, box.style.height]).toEqual(["91.6px", "60.8px"]);
    expect(box.dataset.pose).toBe("sit");
    const fig = box.querySelector<HTMLElement>(".orrsp")!;
    expect(fig.style.height).toBe("76.2px");
    expect(fig.dataset.figure).toBe("sit");
    // both themes' drawings are declared; the stylesheet picks one by the page's data-theme
    expect(fig.style.getPropertyValue("--orr-l")).toMatch(/^url\(/);
    expect(fig.style.getPropertyValue("--orr-d")).toMatch(/^url\(/);
    expect(fig.style.getPropertyValue("--orr-l")).not.toBe(fig.style.getPropertyValue("--orr-d"));
  });

  it("is Hello below 48 px, whatever the pose", () => {
    const { container } = render(<Orr pose="telescope" size={40} />);
    expect(container.querySelector<HTMLElement>(".orrw")!.dataset.pose).toBe("hello");
  });

  it("is only the head mark below 20 px", () => {
    const { container } = render(<Orr pose="sit" size={16} />);
    expect(container.querySelector(".orrw")).toBeNull();
    expect(container.querySelector("svg.hd")).not.toBeNull();
  });

  it("changes pose with a 150 ms cross-fade, then keeps one drawing", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<Orr pose="sit" size={64} />);
    rerender(<Orr pose="jump" size={64} />);
    const layers = () => [...container.querySelectorAll<HTMLElement>(".orrsp")].map((l) => `${l.className.replace("orrsp", "").trim()}:${l.dataset.figure}`);
    expect(layers()).toEqual(["out:sit", "in:jump"]);
    act(() => void vi.advanceTimersByTime(POSE_FADE_MS));
    expect(layers()).toEqual([":jump"]);
    vi.useRealTimers();
  });

  it("is decorative unless labelled", () => {
    const { container, rerender } = render(<Orr pose="wave" size={64} />);
    expect(container.querySelector(".orrw")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<Orr pose="wave" size={64} label="Orr waves" />);
    expect(container.querySelector(".orrw")!.getAttribute("aria-label")).toBe("Orr waves");
  });
});

describe("<Avatar>", () => {
  it("crops the head into a circle of the given diameter", () => {
    const { container } = render(<Avatar name="victorr" size={38} />);
    const c = container.querySelector<HTMLElement>(".avc")!;
    expect([c.style.width, c.style.height]).toEqual(["38px", "38px"]);
    const fig = c.querySelector<HTMLElement>(".orrsp")!;
    expect([fig.style.left, fig.style.top]).toEqual(["-22.2px", "-6.8px"]);
    expect(fig.style.getPropertyValue("--orr-l")).toMatch(/avatars-a-victorr-light/);
  });

  it("maps the old rock faces to Orrs, and anything unknown to Orriginal", () => {
    expect(avatarName("basalt")).toBe("orriginal");
    expect(avatarName("moss")).toBe("sorrel");
    expect(avatarName("victorr")).toBe("victorr");
    expect(avatarName("granite")).toBe("orriginal");
    expect(avatarName(undefined)).toBe("orriginal");
  });
});

describe("<HeadMark>", () => {
  it("gives each copy its own gradient, so two on a page both draw", () => {
    const { container } = render(
      <>
        <HeadMark size={16} />
        <HeadMark size={22} />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((g) => g.id);
    expect(new Set(ids).size).toBe(2);
    for (const p of container.querySelectorAll("path")) expect(ids).toContain(/url\(#(.+)\)/.exec(p.getAttribute("fill")!)![1]);
  });
});
