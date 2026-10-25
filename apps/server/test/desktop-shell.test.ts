/**
 * The Tauri shell stays thin: no Rust commands (the two it had took the vault
 * root from the caller and could read or write any file on the Mac), no
 * capability (no page gets Tauri IPC), and no setting that cannot affect the
 * window it ships (audit OPS-010).
 *
 * Its only window loaded http://localhost:4623 directly, so whatever held port
 * 4623 was shown as Orrama. Then it waited for anything answering as Orrama
 * there. Since stage 2 (2B) it starts its own server and shows it only when
 * /api/health answers as Orrama with the launch id it gave that server
 * (`is_orrama` and `is_our_launch`, unit-tested by `cargo test`).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const shell = path.resolve(import.meta.dirname, "../../desktop/src-tauri");
const conf = JSON.parse(fs.readFileSync(path.join(shell, "tauri.conf.json"), "utf8")) as {
  identifier: string;
  build: Record<string, string>;
  app: { windows: unknown[]; security: { csp: string } };
  bundle: Record<string, unknown>;
};
const source = (f: string) => fs.readFileSync(path.join(shell, "src", f), "utf8");
const rust = () => fs.readdirSync(path.join(shell, "src")).map(source).join("\n");

describe("desktop shell", () => {
  it("registers no commands and gives no page IPC", () => {
    const src = rust();
    expect(src).not.toMatch(/#\[tauri::command\]|invoke_handler/);
    // One plugin is registered, single instance; the opener is called from Rust,
    // never registered (registering it would add its commands and a script to every page).
    expect([...src.matchAll(/\.plugin\(([\w:]+)/g)].map((m) => m[1])).toEqual(["tauri_plugin_single_instance::init"]);
    const cargo = fs.readFileSync(path.join(shell, "Cargo.toml"), "utf8");
    expect([...cargo.matchAll(/^(tauri-plugin-[\w-]+)\s*=/gm)].map((m) => m[1]).sort()).toEqual(["tauri-plugin-opener", "tauri-plugin-single-instance"]);
    expect(cargo).not.toMatch(/^notify\s*=/m);
    expect(fs.existsSync(path.join(shell, "capabilities"))).toBe(false); // no IPC for any page
  });

  it("is com.orrama.desktop, and its bundle carries Node and the server", () => {
    // Jules, 25 Oct 2026: the data folder and the updater's continuity hang on it.
    expect(conf.identifier).toBe("com.orrama.desktop");
    // Kept out of tauri.conf.json so cargo check and tauri dev work without the prepared bundle.
    expect(conf.bundle.externalBin).toBeUndefined();
    const bundle = JSON.parse(fs.readFileSync(path.join(shell, "tauri.bundle.conf.json"), "utf8")) as { bundle: Record<string, unknown> };
    expect(bundle.bundle.externalBin).toEqual(["binaries/node"]);
    expect(bundle.bundle.resources).toEqual({ "resources/server/": "server/" });
  });

  it("opens on its own bundled pages, which the config's CSP actually covers", () => {
    expect(conf.app.windows).toEqual([]); // made in lib.rs, with its navigation rules
    expect(source("lib.rs")).toMatch(/WebviewWindowBuilder::new\(app, "main", WebviewUrl::App\("index\.html"\.into\(\)\)\)/);
    expect(Object.keys(conf.build)).toEqual(["frontendDist"]); // no dev URL or web build that nothing shows
    const dist = path.join(shell, conf.build.frontendDist!);
    const page = (f: string) => fs.readFileSync(path.join(dist, f), "utf8");
    expect(page("index.html")).toMatch(/Starting Orrama…/);
    expect(page("failed.html")).toMatch(/Orrama couldn’t start[\s\S]*action\/retry[\s\S]*action\/log/);
    expect(page("key.html")).toMatch(/Orrama can’t read its key[\s\S]*action\/retry/);
    expect(page("key-keyring.html")).toMatch(/Orrama can’t read its key[\s\S]*action\/retry/);
    // The bundled pages load nothing from anywhere else, and run no script.
    const csp = conf.app.security.csp;
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).not.toMatch(/https?:|ws:|'unsafe-/);
    expect(fs.readdirSync(dist).filter((f) => f.endsWith(".js"))).toEqual([]);
    for (const f of fs.readdirSync(dist).filter((f) => f.endsWith(".html"))) expect(page(f)).not.toMatch(/<script|\son[a-z]+=/i);
  });

  it("shows a server only once it answers as Orrama with its own launch id", () => {
    const src = rust();
    expect(source("server.rs")).toMatch(/health::fetch\(port\)\.is_some_and\(\|r\| health::is_our_launch\(&r, &launch_id\)\)/);
    expect(src).toMatch(/fn is_orrama\(response: &str\) -> bool/);
    expect(src).toMatch(/fn is_our_launch\(response: &str, launch_id: &str\) -> bool/);
    expect(src).toMatch(/#\[test\]\s*fn refuses_anything_else/);
    expect(src).toMatch(/#\[test\]\s*fn refuses_another_launch_or_none/);
    expect(src).toMatch(/#\[test\]\s*fn never_new_secrets_over_a_database/);
  });
});
