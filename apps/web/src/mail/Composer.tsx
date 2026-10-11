/**
 * Writing: a new message, a reply, a forward, or a draft Orr staged, loaded as it is so what
 * goes out is what you just read. One composer per draft: the screen keys it (WEB-006), and it
 * says whether its fields hold anything you typed, so leaving can ask first.
 */
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { Button } from "../ui/controls.js";
import { Field, Input, Textarea } from "../ui/fields.js";
import { Icon } from "../ui/Icon.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { Notice } from "../ui/states.js";
import type { Draft } from "./compose.js";

export function Composer({
  draft,
  from,
  onDirty,
  onClose,
  onSent,
}: {
  draft: Draft;
  from: string;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<"address" | "server" | null>(null);
  const [sent, setSent] = useState(false);
  const toRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  /*
   * "Sent" shows for a moment, then the composer closes. The timer dies with the composer: one
   * left running after you'd gone elsewhere stepped your history back from that page.
   */
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closing.current), []);
  const changed = to !== draft.to || subject !== draft.subject || body !== draft.body;
  useEffect(() => {
    onDirty(changed && !sent);
  }, [changed, sent, onDirty]);

  // Start where the writing starts: the address for a new message or a forward, the text otherwise.
  useEffect(() => {
    const el = draft.to ? bodyRef.current : toRef.current;
    el?.focus();
    if (el === bodyRef.current) bodyRef.current?.setSelectionRange(0, 0);
  }, [draft.to]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      await api("POST", "/api/mail/send", { to, subject, body, inReplyTo: draft.inReplyTo, references: draft.references });
      // The staged row has served its purpose once the real message is away.
      if (draft.id) await api("DELETE", `/api/mail/drafts/${draft.id}`).catch(() => {});
      setSent(true);
      closing.current = setTimeout(onSent, 700);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? "address" : "server");
      setSending(false);
    }
  };

  const staged = !!draft.id;
  return (
    <form
      className="mcompose"
      aria-label={draft.title}
      onSubmit={(e) => {
        e.preventDefault();
        if (to.trim() && !sending && !sent) void send();
      }}
    >
      <header className="mc-head">
        <h2>{draft.title}</h2>
        <span className="mc-from">From {from}</span>
        {/* A staged draft outlives this composer: closing leaves it in Waiting for you, so
            don't call that discarding. */}
        <Button kind="quiet" icon="x" aria-label={staged ? "Close" : "Discard"} tip={staged ? "Close" : "Discard"} onClick={onClose} />
      </header>
      {staged && (
        <div className="draftbar">
          {draft.createdBy === "agent" ? <HeadMark size={16} /> : <Icon name="pen" size={16} />}
          <span>
            <b>{draft.createdBy === "agent" ? "Orr drafted this." : "An API-token client drafted this."}</b> Check the recipient and the wording: sending
            is yours.
          </span>
        </div>
      )}
      <Field label="To" error={error === "address" ? "Check the address: the mail server didn't accept it." : null}>
        <Input ref={toRef} value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" autoComplete="off" type="text" />
      </Field>
      <Field label="Subject">
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label="Message">
        <Textarea ref={bodyRef} className="mc-body" value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {error === "server" && <Notice title="Not sent." text="The mail server didn't take it. Your text is still here: try again in a moment." />}
      <div className="mc-acts">
        <Button kind="solid" type="submit" disabled={sending || sent || !to.trim()}>
          {sent ? "Sent" : sending ? "Sending…" : "Send"}
        </Button>
        <Button kind="quiet" onClick={onClose}>
          {staged ? "Close" : "Discard"}
        </Button>
      </div>
    </form>
  );
}
