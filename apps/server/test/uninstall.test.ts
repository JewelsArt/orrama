/**
 * Uninstalling never deletes notes (2F). Only a Windows runner can run the uninstaller
 * (release.yml, scripts/install-check.mjs), so this holds the pieces together where every
 * platform can read them: the hook is wired into the installer, it ticks "Delete the
 * application data" only when asked (/DELETEAPPDATA) and never on an update, the Credential
 * Manager entry it removes is the one the app makes (secrets.rs + the keyring's "<user>.<service>"),
 * the check asks for the data and looks for the notes afterwards, and the data folder the
 * uninstaller removes is the app's identifier, never where notes go.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as { identifier: string; bundle: { windows: { nsis: { installerHooks?: string } } } };
const hooks = read("apps/desktop/src-tauri/windows/hooks.nsh");
const secrets = read("apps/desktop/src-tauri/src/secrets.rs");
const check = read("scripts/install-check.mjs");
const helper = read("scripts/windows-credential.mjs");
const helperUrl = pathToFileURL(path.join(root, "scripts/windows-credential.mjs")).href;
const credentials = (await import(helperUrl)) as {
  credentialAnswer(result: { status: number | null; stdout?: string | null; stderr?: string | null; error?: Error }, expected: string[]): string;
};
const run = promisify(execFile);

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

  it("is checked against the entry the app makes, written and read the way the app does", () => {
    const service = /KEYRING_SERVICE: &str = "([^"]+)"/.exec(secrets)![1]!;
    const user = /\} else \{\s+"([^"]+)"\.into\(\)/.exec(secrets)![1]!;
    expect(check).toContain(`const CREDENTIAL_USER = "${user}"`);
    expect(check).toContain("const CREDENTIAL = `${CREDENTIAL_USER}.${APP_ID}`");
    expect(check).toContain(`const APP_ID = "${service}"`);
    expect(check).toMatch(/writeCredential\(CREDENTIAL, CREDENTIAL_USER\)/);
    expect(check).toMatch(/while \(credentialExists\(CREDENTIAL\)\)/);
    // The hook deletes a generic credential (`i 1`): the stand-in must be one.
    expect(helper).toMatch(/const uint Generic = 1, Enterprise = 3;/);
    expect(helper).toMatch(/c\.Type = Generic;[\s\S]*c\.Persist = Enterprise;/);
  });

  it("never reads a broken Credential Manager as an entry that has gone", () => {
    const expected = ["present", "absent"];
    expect(credentials.credentialAnswer({ status: 0, stdout: "present\r\n" }, expected)).toBe("present");
    expect(credentials.credentialAnswer({ status: 0, stdout: "absent\r\n" }, expected)).toBe("absent");
    expect(() => credentials.credentialAnswer({ status: 0, stdout: "CredReadW failed with Windows error 1312\r\n" }, expected)).toThrow(/error 1312/);
    expect(() => credentials.credentialAnswer({ status: 1, stdout: "absent", stderr: "Add-Type failed" }, expected)).toThrow(/Add-Type failed/);
    expect(() => credentials.credentialAnswer({ status: null, stdout: null, error: new Error("ENOENT") }, expected)).toThrow(/ENOENT/);
    expect(() => credentials.credentialAnswer({ status: 0, stdout: "" }, expected)).toThrow();
  });

  // The real Credential Manager, on the Windows workflow: proves the helper before a release run
  // spends 40 minutes reaching it. Its own throwaway entry, removed again, never the app's. In a
  // child process: the helper is synchronous and takes minutes under the suite's load, and a worker
  // blocked that long makes vitest's own messages time out (Windows run 42653918633).
  it.runIf(process.platform === "win32")(
    "can write, see and remove a credential on this Windows",
    async () => {
      const target = `orrama test ${crypto.randomBytes(8).toString("hex")}.example`;
      const script = `
        const { writeCredential, credentialExists, deleteCredential } = await import(${JSON.stringify(helperUrl)});
        const target = process.argv[1];
        let seen;
        try {
          writeCredential(target, "orrama test");
          seen = credentialExists(target);
        } finally {
          deleteCredential(target);
        }
        console.log(JSON.stringify({ seen, after: credentialExists(target) }));
      `;
      const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, target]);
      expect(JSON.parse(stdout)).toEqual({ seen: true, after: false });
    },
    // Each call starts PowerShell and compiles its helper: about 26 s under the suite's load.
    300_000,
  );
});
