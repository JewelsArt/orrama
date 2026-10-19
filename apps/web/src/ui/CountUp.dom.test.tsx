/**
 * The hero's counting figure (Clay): the real figure is always the element's text, so a screen
 * reader reads it once and Paper shows it unchanged; only its whole part is handed to clay.css.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CountUp } from "./CountUp.js";

afterEach(cleanup);

const mount = (text: string) => render(<b data-testid="fig"><CountUp text={text} /></b>).getByTestId("fig");

describe("CountUp", () => {
  it("keeps the figure as text and counts its whole part", () => {
    const fig = mount("€908.40");
    expect(fig.textContent).toBe("€908.40");
    const cnt = fig.querySelector<HTMLElement>(".cnt")!;
    expect(cnt.className).toBe("cnt");
    expect([cnt.style.getPropertyValue("--to"), cnt.style.getPropertyValue("--from")]).toEqual(["908", "0"]);
    expect(cnt.textContent).toBe("908");
  });

  it("from a thousand: thousands and hundreds, counting from the first thousand", () => {
    const fig = mount("€1,520.00");
    expect(fig.textContent).toBe("€1,520.00");
    const cnt = fig.querySelector<HTMLElement>(".cnt")!;
    expect(cnt.className).toBe("cnt k");
    expect([cnt.style.getPropertyValue("--to"), cnt.style.getPropertyValue("--from")]).toEqual(["1520", "1000"]);
  });

  it("anything that is not a figure it can count stays as it is", () => {
    for (const text of ["no typical month", "€1,250,000.00", "−€12.00"]) {
      const fig = mount(text);
      expect(fig.textContent).toBe(text);
      if (text.startsWith("−")) expect(fig.querySelector(".cnt")?.textContent).toBe("12");
      else expect(fig.querySelector(".cnt")).toBeNull();
      cleanup();
    }
  });
});
