/**
 * Clay's shell (19 October 2026, canvas page 4h): the two navs and day or night in the rail.
 * A page's sections go to the top bar in Clay and stay in place in Paper (SectionBar); the sun
 * and the moon replace F3's button in Clay only; Find and your Orr move to the top bar, except
 * on Settings, whose board keeps them in the rail.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "../router.js";
import type { Look, Shown } from "../theme.js";
import { SectionBar, useLook } from "./SectionBar.js";
import { Shell } from "./Shell.js";

afterEach(cleanup);

function Page() {
  const look = useLook();
  return (
    <div data-testid="page" data-look={look}>
      <h1>Money</h1>
      <SectionBar>
        <nav aria-label="Money sections">
          <a href="/money">Overview</a>
        </nav>
      </SectionBar>
    </div>
  );
}

function mount({ look, shown = "light", route = { kind: "money" } as Route, onTheme = vi.fn() }: { look: Look; shown?: Shown; route?: Route; onTheme?: (s: Shown) => void }) {
  render(
    <Shell
      route={route}
      title="Money"
      me={{ displayName: "Erin Vale", avatar: "orra" }}
      updateReady={false}
      askOpen={false}
      onFind={() => {}}
      onAsk={() => {}}
      shown={shown}
      look={look}
      onTheme={onTheme}
    >
      <Page />
    </Shell>,
  );
  return onTheme;
}

const rail = () => screen.getAllByRole("navigation", { name: "Places" })[0]!;
const sections = () => screen.getByRole("navigation", { name: "Money sections" });

describe("the section bar", () => {
  it("in Clay, a page's sections are in the top bar, beside Find and you", () => {
    mount({ look: "clay" });
    const top = sections().closest(".ctop");
    expect(top).not.toBeNull();
    expect(within(top as HTMLElement).getByRole("button", { name: "Find" })).toBeTruthy();
    expect(within(top as HTMLElement).getByRole("link", { name: "Erin Vale: Settings" }).getAttribute("href")).toBe("/settings/you");
    expect(screen.getByTestId("page").contains(sections())).toBe(false);
    expect(screen.getByTestId("page").dataset.look).toBe("clay");
  });

  it("in Paper, they stay where the page draws them and there is no top bar", () => {
    mount({ look: "paper" });
    expect(screen.getByTestId("page").contains(sections())).toBe(true);
    expect(document.querySelector(".ctop")).toBeNull();
    expect(screen.getByTestId("page").dataset.look).toBe("paper");
  });

  it("on Settings, Clay has no top bar: the page keeps its own, and Find and you stay in the rail", () => {
    mount({ look: "clay", route: { kind: "settings", section: "you" } });
    expect(document.querySelector(".ctop")).toBeNull();
    expect(screen.getByTestId("page").contains(sections())).toBe(true);
    expect(within(rail()).getByRole("button", { name: "Find" })).toBeTruthy();
    expect(within(rail()).getByRole("link", { name: "Erin Vale: Settings" })).toBeTruthy();
  });
});

describe("day or night in the rail", () => {
  it("Clay: the sun and the moon at the top, the lit one is the mode you're in, and F3's button goes", async () => {
    const user = userEvent.setup();
    const onTheme = mount({ look: "clay", shown: "light" });
    const group = within(rail()).getByRole("group", { name: "Day or night" });
    expect(rail().firstElementChild).toBe(group);
    const day = within(group).getByRole("button", { name: "Day" });
    const night = within(group).getByRole("button", { name: "Night" });
    expect([day.getAttribute("aria-pressed"), night.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
    expect(rail().querySelector(".ri.theme")).toBeNull();
    expect(within(rail()).queryByRole("button", { name: "Find" })).toBeNull();
    await user.click(night);
    expect(onTheme).toHaveBeenLastCalledWith("dark");
    await user.click(day);
    expect(onTheme).toHaveBeenLastCalledWith("light");
  });

  it("at night the moon is the lit one", () => {
    mount({ look: "clay", shown: "dark" });
    const group = within(rail()).getByRole("group", { name: "Day or night" });
    expect(within(group).getByRole("button", { name: "Night" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(group).getByRole("button", { name: "Day" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("Paper keeps F3's one button and has no sun and moon", () => {
    mount({ look: "paper", shown: "light" });
    expect(within(rail()).queryByRole("group", { name: "Day or night" })).toBeNull();
    expect(rail().querySelector(".ri.theme")?.getAttribute("aria-label")).toBe("Switch to dark");
    expect(within(rail()).getByRole("button", { name: /Find/ })).toBeTruthy();
  });
});
