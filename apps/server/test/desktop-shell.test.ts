/**
 * The Tauri shell stays thin: no Rust commands (the two it had took the vault
 * root from the caller and could read or write any file on the Mac), no page
 * gets Tauri IPC beyond the folder chooser (2C: the server's own page, one
 * command, granted at run time for its exact origin), and no setting that
 * cannot affect the window it ships (audit OPS-010).
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
  it("registers no commands, and gives the server's page the folder chooser and nothing else", () => {
    const src = rust();
    expect(src).not.toMatch(/#\[tauri::command\]|invoke_handler/);
    // Three plugins are registered: single instance, the dialog for the folder chooser (2C,
    // Jules 25 Oct: D5), and the updater, driven from Rust alone (2E; no capability grants a page
    // any of its commands, below). The opener is called from Rust, never registered (registering
    // it would add its commands and a script to every page).
    expect([...src.matchAll(/\.plugin\(([\w:]+)/g)].map((m) => m[1])).toEqual(["tauri_plugin_single_instance::init", "tauri_plugin_dialog::init", "tauri_plugin_updater::Builder::new"]);
    const cargo = fs.readFileSync(path.join(shell, "Cargo.toml"), "utf8");
    expect([...cargo.matchAll(/^(tauri-plugin-[\w-]+)\s*=/gm)].map((m) => m[1]).sort()).toEqual(["tauri-plugin-dialog", "tauri-plugin-opener", "tauri-plugin-single-instance", "tauri-plugin-updater"]);
    expect(cargo).not.toMatch(/^notify\s*=/m);
    // No capability file: the one capability is made at run time, for the server's exact origin,
    // with the dialog's open only (capability.rs; `cargo test` holds its origin and its one permission).
    expect(fs.existsSync(path.join(shell, "capabilities"))).toBe(false);
    expect([...src.matchAll(/add_capability\(([^)]*\))/g)].map((m) => m[1])).toEqual(["capability::server_page(port)"]);
    expect(source("capability.rs")).toMatch(/pub const PERMISSION: &str = "dialog:allow-open";/);
    expect([...source("capability.rs").matchAll(/"[a-z-]+:[a-z-]+"/g)].map((m) => m[0])).toEqual(['"dialog:allow-open"', '"dialog:allow-open"']);
    expect(source("capability.rs")).toMatch(/#\[test\]\s*fn the_page_gets_the_folder_chooser_and_nothing_else/);
    expect(source("capability.rs")).toMatch(/#\[test\]\s*fn only_for_our_own_server_at_its_port/);
    // A lock held through a match hung the window when the reset action took it again (2C):
    // clippy (desktop.yml, -D warnings) refuses that shape anywhere in the shell.
    expect(source("lib.rs")).toMatch(/^\/\/.*\n#!\[warn\(clippy::significant_drop_in_scrutinee\)\]/);
  });

  it("updates from the signed feed of the newest GitHub release (2E)", () => {
    const updater = (conf as unknown as { plugins: { updater: Record<string, unknown> } }).plugins.updater;
    expect(updater.endpoints).toEqual(["https://github.com/JewelsArt/orrama/releases/latest/download/latest.json"]);
    // Jules's public key (the private key and its password are his alone, never in the repo).
    expect(Buffer.from(String(updater.pubkey), "base64").toString("utf8")).toMatch(/^untrusted comment: minisign public key: [0-9A-F]{16}\n[A-Za-z0-9+/=]{56}\n?$/);
    // Not requireSignedVersion: Tauri CLI 2.11 signs without the version in the trusted comment,
    // and the plugin would then refuse every update. updater.rs offers only a newer version; turn
    // it on once the CLI records the version (2E's notes).
    expect(updater.requireSignedVersion).toBeUndefined();
    expect(updater.windows).toEqual({ installMode: "passive" });
    expect(Object.keys(updater).filter((k) => k.startsWith("dangerous"))).toEqual([]);
    expect((conf.bundle as Record<string, unknown>).createUpdaterArtifacts).toBe(true);
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
