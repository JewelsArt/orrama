/**
 * A draft Orr staged, shown whole: who it goes to (the address, always, since the agent chose
 * it), the subject and every word, then Send, Edit and Discard. It sits under the message it
 * answers and on Waiting for you. Send posts exactly the text on the card through the one send
 * path (POST /api/mail/send, a signed-in session only); Edit opens it in the composer. The
 * agent itself can never send (CLAUDE.md "The agent can draft mail, never send it").
 */
import type { PendingDraft } from "@basalt/schema/responses";
import { Button } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { Notice } from "../ui/states.js";
import { listWhen } from "./when.js";

export function draftedAt(p: PendingDraft, now = new Date()): string {
  const when = listWhen(new Date(p.createdAt).toISOString(), now);
  return /^\d/.test(when) ? `at ${when}` : when === "Yesterday" ? "yesterday" : `on ${when}`;
}

export function DraftCard({
  draft,
  toName,
  sending,
  failed,
  onSend,
  onEdit,
  onDiscard,
  waitingHref,
  onWaiting,
}: {
  draft: PendingDraft;
  /** The recipient's name, when they are a contact. */
  toName?: string;
  sending: boolean;
  failed: boolean;
  onSend: () => void;
  onEdit: () => void;
  onDiscard: () => void;
  /** Where "Waiting for you" in the banner goes; left out on that page itself. */
  waitingHref?: string;
  onWaiting?: () => void;
}) {
  const orr = draft.createdBy === "agent";
  const what = draft.inReplyTo ? "a reply" : "a message";
  const where = waitingHref ? (
    <>
      It waits in{" "}
      <a
        className="ui-nm"
        href={waitingHref}
        onClick={(e) => {
          if (!onWaiting || e.button !== 0 || e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          onWaiting();
        }}
      >
        Waiting for you
      </a>
      ; nothing is sent until you press Send.
    </>
  ) : (
    "Nothing is sent until you press Send."
  );
  return (
    <article className="mdraft" aria-label={`Draft: ${draft.subject || "no subject"}`}>
      <div className="draftbar">
        {orr ? <HeadMark size={16} /> : <Icon name="pen" size={16} />}
        <span>
          <b>
            {orr ? "Orr" : "An API-token client"} drafted {what} {draftedAt(draft)}.
          </b>{" "}
          {where}
        </span>
        <Button kind="quiet" size="sm" onClick={onDiscard} disabled={sending}>
          Discard
        </Button>
      </div>
      <div className="dto">
        To {toName ? <b>{toName}</b> : null} <span className="daddr">{draft.to}</span>
        {draft.subject ? <> · {draft.subject}</> : null}
      </div>
      <div className="dbody">{draft.body.trim() ? draft.body : <span className="q3">No text.</span>}</div>
      {failed && <Notice title="Not sent." text="The mail server didn't take it. The draft is still here: try again, or edit it first." />}
      <div className="dacts">
        <Button kind="solid" size="sm" onClick={onSend} disabled={sending}>
          {sending ? "Sending…" : "Send"}
        </Button>
        <Button size="sm" onClick={onEdit} disabled={sending}>
          Edit
        </Button>
      </div>
    </article>
  );
}
