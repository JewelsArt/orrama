/**
 * Settings → Access (structure.md §3.1, "Plus"): only when this server has more than one account.
 * A one-person install never sees it, nor any team words (§8 #9). It lists the accounts; teams
 * and folder grants are still enforced underneath (CLAUDE.md "One user, one vault") and have no
 * screen yet.
 */
import type { Member } from "@orrama/schema/responses";
import { Avatar } from "../ui/orr/Orr.js";
import { SectionHead, SubHead, type SectionMeta } from "./parts.js";

export function AccessSection({ meta, members }: { meta: SectionMeta; members: Member[] }) {
  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />
      <div>
        <SubHead>{members.length} accounts</SubHead>
        {members.map((m) => (
          <div key={m.id} className="set-item">
            <Avatar name={m.avatar} size={32} />
            <span className="set-item-x">
              <b>{m.displayName}</b>
              <small>
                @{m.username}
                {m.isOwner ? " · sees every note" : ""}
              </small>
            </span>
          </div>
        ))}
        <p className="set-help">Who reads which folder is decided by teams and folder grants on the server; they have no screen yet.</p>
      </div>
    </section>
  );
}
