/**
 * Copy for the Me page: the clipboard API where the page has it (https, localhost), else the old
 * way through a hidden field (plain http over the LAN or a tailnet has no clipboard API). Always
 * says what happened (review, 20 Nov: Copy used to do nothing at all there).
 */
import { toast } from "../ui/overlays.js";

function oldWay(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  field.remove();
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) ok = oldWay(text);
  toast(ok ? "Copied." : "It couldn't be copied. Select the text instead.");
  return ok;
}
