/**
 * The theme (structure.md §9): the account's light or dark, or this device's system when it
 * matches. WEB-019: index.html said dark and the stored theme went on in an effect, after the
 * first paint, so every launch and reload of a light install flashed dark first.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountTheme, DEVICE_KEY, resolveTheme, shownOf, THEME_KEY } from "./theme.js";

const WEB = path.resolve(import.meta.dirname, "../..");
const BOOT = fs.readFileSync(path.join(WEB, "public/boot-theme.js"), "utf8");

const system = (dark: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: dark && q === "(prefers-color-scheme: dark)", addEventListener() {}, removeEventListener() {} }));

/** Run the boot script on a fresh <html>, as the browser does before the first frame. */
function boot() {
  const root = document.documentElement;
  root.removeAttribute("data-theme");
  root.removeAttribute("data-vision");
  new Function(BOOT)();
  return root.dataset.theme;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-vision");
});

describe("the theme", () => {
  it("is the account's, unless this device matches its system", () => {
    expect(resolveTheme("light", false, true)).toBe("light");
    expect(resolveTheme("command", false, false)).toBe("dark");
    expect(resolveTheme("light", true, true)).toBe("dark");
    expect(resolveTheme("command", true, false)).toBe("light");
    expect(resolveTheme(null, false, true)).toBe("light"); // light is the default
  });

  it("reads the account's words: command is dark, paper is light", () => {
    expect([shownOf("command"), shownOf("dark"), shownOf("paper"), shownOf("light"), shownOf(undefined)]).toEqual(["dark", "dark", "light", "light", "light"]);
    expect([accountTheme("dark"), accountTheme("light")]).toEqual(["command", "light"]);
  });
});

describe("the first frame (WEB-019)", () => {
  it("the boot script puts on the theme the app will show, in every stored case", () => {
    for (const account of [null, "light", "paper", "command", "dark"])
      for (const match of [false, true])
        for (const dark of [false, true]) {
          localStorage.clear();
          if (account) localStorage.setItem(THEME_KEY, account);
          if (match) localStorage.setItem(DEVICE_KEY, "match");
          system(dark);
          expect(boot(), `account ${account}, match ${match}, system dark ${dark}`).toBe(resolveTheme(account, match, dark));
        }
  });

  it("and the colour-vision mode", () => {
    system(false);
    localStorage.setItem("basalt-vision", "deuteranopia");
    boot();
    expect(document.documentElement.dataset.vision).toBe("deuteranopia");
  });

  it("paints light when storage refuses", () => {
    system(true);
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("denied");
      },
    });
    expect(boot()).toBe("light");
  });

  it("index.html starts light and runs the boot script first, as a plain blocking script", () => {
    const doc = new DOMParser().parseFromString(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), "text/html");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("light");
    const tag = doc.head.querySelector('script[src="/boot-theme.js"]');
    expect(tag).not.toBeNull();
    expect(["type", "async", "defer"].filter((a) => tag!.hasAttribute(a))).toEqual([]);
    expect(doc.querySelectorAll("script")[0]).toBe(tag); // before the app's own module
  });

  it("every stylesheet that styles the night names it dark, the page's word now", () => {
    const files = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".css") ? [path.join(dir, d.name)] : []));
    const css = [...files(path.join(WEB, "src")), ...files(path.resolve(WEB, "../../packages/ui/src"))];
    const stale = css.flatMap((f) =>
      [...fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{/g)]
        .map((m) => m[1]!.trim())
        .filter((sel) => sel.includes('[data-theme="command"]') && !sel.includes('[data-theme="dark"]'))
        .map((sel) => `${path.basename(f)}: ${sel}`),
    );
    expect(stale).toEqual([]);
  });
});
