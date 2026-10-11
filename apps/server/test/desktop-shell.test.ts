/**
 * The Tauri shell stays a window: no Rust commands (the two it had took the
 * vault root from the caller and could read or write any file on the Mac), and
 * no setting that cannot affect the window it ships (audit OPS-010).
 *
 * Its only window loaded http://localhost:4623 directly, so the CSP Tauri
 * injects, the bundled web build and the dev URL applied to nothing, and
 * whatever held port 4623 was shown as Basalt. Now the window opens on a
 * bundled page and moves to the server only when /api/health answers the way
 * Basalt does (`is_basalt` in lib.rs, unit-tested by `cargo test`).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const shell = path.resolve(import.meta.dirname, "../../desktop/src-tauri");
const conf = JSON.parse(fs.readFileSync(path.join(shell, "tauri.conf.json"), "utf8")) as {
  build: Record<string, string>;
  app: { windows: { label: string; url: string }[]; security: { csp: string } };
};
const rust = () => fs.readdirSync(path.join(shell, "src")).map((f) => fs.readFileSync(path.join(shell, "src", f), "utf8")).join("\n");

describe("desktop shell", () => {
  it("registers no commands and loads no plugins", () => {
    expect(rust()).not.toMatch(/#\[tauri::command\]|invoke_handler|\.plugin\(/);
    const cargo = fs.readFileSync(path.join(shell, "Cargo.toml"), "utf8");
    expect(cargo).not.toMatch(/tauri-plugin-|^notify\s*=/m);
    expect(fs.existsSync(path.join(shell, "capabilities"))).toBe(false); // no IPC for any page
  });

  it("opens on its own bundled page, which the config's CSP actually covers", () => {
    expect(conf.app.windows).toHaveLength(1);
    const [win] = conf.app.windows;
    expect(win!.label).toBe("main");
    expect(win!.url).toBe("index.html"); // a page Tauri serves, not an external URL
    expect(Object.keys(conf.build)).toEqual(["frontendDist"]); // no dev URL or web build that nothing shows
    const dist = path.join(shell, conf.build.frontendDist!);
    expect(fs.readFileSync(path.join(dist, "index.html"), "utf8")).toMatch(/Basalt isn.t running/);
    // The bundled page loads nothing from anywhere else, and runs no script.
    const csp = conf.app.security.csp;
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/https?:|ws:|'unsafe-/);
    expect(fs.readdirSync(dist).filter((f) => f.endsWith(".js"))).toEqual([]);
  });

  it("moves to the server only once it answers as Basalt", () => {
    const src = rust();
    expect(src).toMatch(/if basalt_answers\(\) \{\s*let _ = window\.navigate\(server\);/);
    expect(src).toMatch(/const SERVER: &str = "http:\/\/localhost:4623";/);
    expect(src).toMatch(/fn is_basalt\(response: &str\) -> bool/);
    expect(src).toMatch(/#\[test\]\s*fn refuses_anything_else/);
  });
});
