/**
 * Waiting for you (`/mail/waiting`): every draft Orr is holding, whole, each with Send, Edit and
 * Discard. "2 drafts" anywhere in the app opens this (§1.7 #2).
 */
import type { ReactNode } from "react";
import type { PendingDraft } from "@basalt/schema/responses";
import { HeadMark } from "../ui/orr/Orr.js";
import { EmptyState } from "../ui/states.js";

export function Waiting({ pending, loaded, card }: { pending: PendingDraft[]; loaded: boolean; card: (p: PendingDraft) => ReactNode }) {
  return (
    <section className="mread mwait" aria-label="Waiting for you">
      <h2>
        <HeadMark size={22} />
        Waiting for you
      </h2>
      <p className="mwait-sub">Orr drafts; sending is yours. Nothing leaves until you press Send.</p>
      {loaded && pending.length === 0 ? (
        <EmptyState pose="mail" title="Nothing waits for you." text="When Orr drafts a reply, it waits here until you've read it and pressed Send." />
      ) : (
        pending.map((p) => <div key={p.id}>{card(p)}</div>)
      )}
    </section>
  );
}
