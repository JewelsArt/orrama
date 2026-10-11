/**
 * ⌘R reloads (structure.md §1.5), installed outside React by main.tsx: the Tauri window has no
 * menu, so nothing else binds it there, and a plain window listener keeps working when a view,
 * or the whole app, has crashed (WEB-011). In a browser the browser's own binding fires first.
 */
export function installReloadKey(win: Window = window, reload: () => void = () => win.location.reload()): () => void {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "r") {
      e.preventDefault();
      reload();
    }
  };
  win.addEventListener("keydown", onKey);
  return () => win.removeEventListener("keydown", onKey);
}
