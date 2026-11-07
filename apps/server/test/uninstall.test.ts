/**
 * Uninstalling never deletes notes (2F). Only a Windows runner can run the uninstaller
 * (release.yml, scripts/install-check.mjs), so this holds the pieces together where every
 * platform can read them: the hook is wired into the installer, it ticks "Delete the
 * application data" only when asked (/DELETEAPPDATA) and never on an update, the Credential
 * Manager entry it removes is the one the app makes (secrets.rs + the keyring's "<user>.<service>"),
 * the check asks for the data and looks for the notes afterwards, and the data folder the
 * uninstaller removes is the app's identifier, never where notes go.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { identifier: string; bundle: { windows: { nsis: { installerHooks?: string } } } };
const hooks = read("apps/desktop/src-tauri/windows/hooks.nsh");
const secrets = read("apps/desktop/src-tauri/src/secrets.rs");
const check = read("scripts/install-check.mjs");

/** The `!macro NAME` … `!macroend` body. */
const macro = (name: string) => new RegExp(`!macro ${name}\\n([\\s\\S]*?)!macroend`).exec(hooks)?.[1] ?? "";

describe("the Windows uninstaller", () => {
  it("runs Orrama's hooks", () => {
    const rel = conf.bundle.windows.nsis.installerHooks;
    expect(rel).toBe("windows/hooks.nsh");
    expect(fs.existsSync(path.join(root, "apps/desktop/src-tauri", rel!))).toBe(true);
  });

  it("ticks Delete the application data only when the command line asks", () => {
    const pre = macro("NSIS_HOOK_PREUNINSTALL");
    expect(pre).toMatch(/\$\{GetOptions\} \$CMDLINE "\/DELETEAPPDATA" \$R0\s+\$\{IfNot\} \$\{Errors\}\s+StrCpy \$DeleteAppDataCheckboxState 1/);
    // Nothing else in it touches files.
    expect(pre).not.toMatch(/RMDir|Delete /i);
  });

  it("removes the app's own Credential Manager entry with the data, never on an update", () => {
    const post = macro("NSIS_HOOK_POSTUNINSTALL");
    expect(post).toMatch(/\$\{If\} \$DeleteAppDataCheckboxState = 1\s+\$\{AndIf\} \$UpdateMode <> 1/);
    const service = /KEYRING_SERVICE: &str = "([^"]+)"/.exec(secrets)![1]!;
    const user = /\} else \{\s+"([^"]+)"\.into\(\)/.exec(secrets)![1]!;
    expect(service).toBe(conf.identifier);
    expect(post).toContain(`CredDeleteW(w "${user}.${service}", i 1, i 0)`);
    // Only that entry: a hook never deletes a folder, so it can never reach the notes.
    expect(hooks).not.toMatch(/RMDir|Delete "/i);
  });

  it("is checked on CI: uninstalled with the data, the data gone, the notes kept", () => {
    expect(check).toContain('spawnSync(uninstaller, ["/S", "/DELETEAPPDATA"]');
    expect(check).toContain(`const APP_ID = "${conf.identifier}"`);
    expect(check).toMatch(/the uninstall left \$\{CREDENTIAL\} in the Credential Manager/);
    expect(check).toMatch(/the uninstall took the notes folder with it/);
    expect(read(".github/workflows/release.yml")).toMatch(/node scripts\/install-check\.mjs --installer/);
  });
});
