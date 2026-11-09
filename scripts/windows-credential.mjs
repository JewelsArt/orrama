// The Windows Credential Manager through the calls the app's own keyring makes (CredWriteW,
// CredReadW, CredDeleteW: windows-native-keyring-store), so install-check.mjs's stand-in is the
// kind of entry a friend's install leaves: a generic credential, persisted per user. cmdkey, which
// it used before, exited 0 on the runner and then did not show the entry (release run 42519847955).
//
// Windows PowerShell can call those functions and is on every Windows, so nothing is installed.
// Only install-check.mjs and a Windows-only test use this.
import { spawnSync } from "node:child_process";
import path from "node:path";

// CRED_TYPE_GENERIC = 1 (the uninstall hook's `i 1`), CRED_PERSIST_ENTERPRISE = 3 (the keyring's
// default), ERROR_NOT_FOUND = 1168. The blob says what it is: there is no secret to protect.
const HELPER = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OrramaCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Native {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref Native credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr credential);
  const uint Generic = 1, Enterprise = 3;
  const int NotFound = 1168;
  static string Failed(string call, int code) { return call + " failed with Windows error " + code; }
  public static string Write(string target, string user) {
    byte[] blob = Encoding.Unicode.GetBytes("a stand-in, not a secret");
    IntPtr memory = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, memory, blob.Length);
      Native c = new Native();
      c.Type = Generic;
      c.TargetName = target;
      c.UserName = user;
      c.CredentialBlob = memory;
      c.CredentialBlobSize = (uint)blob.Length;
      c.Persist = Enterprise;
      if (CredWriteW(ref c, 0)) return "written";
      return Failed("CredWriteW", Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public static string Read(string target) {
    IntPtr found;
    if (CredReadW(target, Generic, 0, out found)) { CredFree(found); return "present"; }
    int code = Marshal.GetLastWin32Error();
    return code == NotFound ? "absent" : Failed("CredReadW", code);
  }
  public static string Delete(string target) {
    if (CredDeleteW(target, Generic, 0)) return "deleted";
    int code = Marshal.GetLastWin32Error();
    return code == NotFound ? "absent" : Failed("CredDeleteW", code);
  }
}
'@
$target = $env:ORRAMA_CREDENTIAL_TARGET
switch ($env:ORRAMA_CREDENTIAL_DO) {
  'write' { [OrramaCredential]::Write($target, $env:ORRAMA_CREDENTIAL_USER) }
  'read' { [OrramaCredential]::Read($target) }
  'delete' { [OrramaCredential]::Delete($target) }
}
`;

/**
 * What the helper said, when it is one of `expected`. Anything else throws, with everything it
 * printed: a check that cannot read the Credential Manager must never pass for "the entry is gone".
 */
export function credentialAnswer(result, expected) {
  const said = (result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !expected.includes(said)) {
    const why = result.error ? String(result.error) : `exit ${result.status}`;
    throw new Error(`the Credential Manager helper did not answer ${expected.join(" or ")}: ${why}, stdout ${JSON.stringify(said)}, stderr ${JSON.stringify((result.stderr ?? "").trim())}`);
  }
  return said;
}

function helper(what, target, user = "", expected) {
  // Started from a pwsh step, the inherited PSModulePath points Windows PowerShell at PowerShell 7's
  // modules and Add-Type cannot load. Without it, it finds its own.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
  Object.assign(env, { ORRAMA_CREDENTIAL_DO: what, ORRAMA_CREDENTIAL_TARGET: target, ORRAMA_CREDENTIAL_USER: user });
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(HELPER, "utf16le").toString("base64");
  return credentialAnswer(spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { env, encoding: "utf8", windowsHide: true }), expected);
}

export const writeCredential = (target, user) => void helper("write", target, user, ["written"]);
export const credentialExists = (target) => helper("read", target, "", ["present", "absent"]) === "present";
export const deleteCredential = (target) => void helper("delete", target, "", ["deleted", "absent"]);
