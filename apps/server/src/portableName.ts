/**
 * Why a new file, note or folder may not take this name, or null when every
 * disk the vault travels to can hold it (audit OPS-003). Windows cannot:
 * `" * : < > ? |`, a name ending in a dot or a space, or a device name (CON,
 * NUL, COM1…, with any extension). There an upload under such a name answered
 * 500, a note named `Why now?.md` failed the same way, a `:` would have
 * written into a hidden stream of another file, and `NUL.pdf` would have
 * stored nothing and answered 200. Refused everywhere, as Obsidian does, so a
 * vault made on the Mac still opens on Windows (Jules, 14 Oct 2026). Only a
 * new name is judged: files and notes already in the vault keep opening,
 * saving and being linked to under whatever name they have.
 */
export function unportableName(name: string, what: "file" | "note" | "folder" = "file"): string | null {
  if (/["*:<>?|]/.test(name)) return `a ${what} name can't contain " * : < > ? or |`;
  if (/[. ]$/.test(name)) return `a ${what} name can't end with a dot or a space`;
  if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(\.|$)/i.test(name)) return `Windows keeps the name "${name.split(".")[0]}" for a device`;
  return null;
}
