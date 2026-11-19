/**
 * Generate my persona runs on the server; this watches it from anywhere in the app (ME), so you
 * can leave the Me page and are told when the draft is ready. Started when a generation starts,
 * it asks every few seconds until the job is no longer running, then says so once, unless the
 * Me page is on screen (it shows the result itself).
 */
import type { PersonaJob } from "@orrama/schema/responses";
import { api } from "../api.js";
import { toast } from "../ui/overlays.js";
import { navigate } from "../ui/router.js";

let timer: ReturnType<typeof setTimeout> | null = null;

export function watchGeneration(every = 3000): void {
  if (timer) return;
  const tick = async () => {
    timer = null;
    let job: PersonaJob = null;
    try {
      job = await api<PersonaJob>("GET", "/api/persona/generate");
    } catch {
      timer = setTimeout(() => void tick(), every * 3);
      return;
    }
    if (job?.state === "running") {
      timer = setTimeout(() => void tick(), every);
      return;
    }
    if (location.pathname.startsWith("/me")) return;
    if (job?.state === "done") toast("Your persona draft is ready.", { ms: 15_000, action: { label: "Review", run: () => navigate({ kind: "me" }) } });
    else if (job?.state === "failed") toast("Orr couldn't finish your persona draft.", { action: { label: "Open", run: () => navigate({ kind: "me" }) } });
  };
  timer = setTimeout(() => void tick(), every);
}
