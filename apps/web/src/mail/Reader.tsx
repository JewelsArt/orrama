/**
 * The calm reading pane (structure.md §2.8): the subject, who sent it (a name that opens their
 * page, and a line saying how you know them), when and to whom, Reply and Forward, the message,
 * and under it the reply Orr drafted, if he did.
 */
import { useRef, useState, type ReactNode } from "react";
import type { MailMessage, PendingDraft } from "@basalt/schema/responses";
import { Button } from "../ui/controls.js";
import { Ring, Square, NameLink } from "../ui/controls.js";
import { dateTimeLabel } from "../ui/dates.js";
import { Menu } from "../ui/overlays.js";
import { Notice, Skeleton } from "../ui/states.js";
import { routeHref, type Route } from "../ui/router.js";
import { MessageBody } from "./MessageBody.js";
import { addressOf, type Sender } from "./people.js";

/** A thing the sender is tied to, said in words ("supervises Graduation thesis"). */
export interface Relation {
  relation: string;
  title: string;
  to: Route;
}

/** A name that opens its thing; the app follows the link itself (§1.7 #1). */
export function Go({ to, onGo, children }: { to: Route; onGo: (r: Route) => void; children: ReactNode }) {
  return (
    <NameLink href={routeHref(to)} onOpen={() => onGo(to)}>
      {children}
    </NameLink>
  );
}

export const personRoute = (slug: string): Route => ({ kind: "person", slug });
export const companyRoute = (slug: string): Route => ({ kind: "company", slug });

export function Reader({
  message,
  loading,
  failed,
  onRetry,
  me,
  sender,
  personSlug,
  companySlug,
  relations,
  images,
  onImages,
  onReply,
  onForward,
  onGo,
  draft,
}: {
  message: MailMessage | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  me: string;
  sender?: Sender;
  personSlug?: string;
  companySlug?: string;
  relations: Relation[];
  images: boolean;
  onImages: (on: boolean) => void;
  onReply: () => void;
  onForward: () => void;
  onGo: (r: Route) => void;
  /** Orr's staged reply to this message, drawn under it. */
  draft?: ReactNode;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);

  if (failed)
    return (
      <article className="mread">
        <Notice
          title="Couldn't open this message."
          text="Gmail didn't answer. It may have been moved or deleted, or the connection dropped."
          actions={
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      </article>
    );
  if (loading || !message)
    return (
      <article className="mread" aria-busy="true">
        <Skeleton rows={5} label="Opening the message" />
      </article>
    );

  const name = message.fromName || message.from || "Unknown sender";
  const contact = sender?.contact;
  const company = sender?.company;
  const toMe = addressOf(message.to) === me.toLowerCase() || message.to.toLowerCase().includes(me.toLowerCase());
  const companyLink = company && companySlug ? <Go to={companyRoute(companySlug)} onGo={onGo}>{company.name}</Go> : (sender?.companyName ?? null);

  const relLine: ReactNode[] = [];
  if (contact?.role && companyLink) relLine.push(<span key="r">{contact.role} at {companyLink}</span>);
  else if (contact?.role) relLine.push(<span key="r">{contact.role}</span>);
  else if (companyLink) relLine.push(<span key="r">{sender?.kind === "company" ? companyLink : <>at {companyLink}</>}</span>);
  for (const r of relations)
    relLine.push(
      <span key={`${r.relation}-${r.title}`}>
        {r.relation}{" "}
        <Go to={r.to} onGo={onGo}>
          {r.title}
        </Go>
      </span>,
    );

  const nameEl =
    contact && personSlug ? (
      <Go to={personRoute(personSlug)} onGo={onGo}>
        {name}
      </Go>
    ) : sender?.kind === "company" && company && companySlug ? (
      <Go to={companyRoute(companySlug)} onGo={onGo}>
        {name}
      </Go>
    ) : (
      <b>{name}</b>
    );

  return (
    <article className="mread" aria-label={message.subject || "Message"}>
      <h2>{message.subject || "(no subject)"}</h2>
      <div className="from">
        {sender?.kind === "company" ? <Square name={name} /> : <Ring name={name} />}
        <div className="who2">
          <div className="nm2">
            {nameEl}
            {message.fromName && <span className="addr">{message.from}</span>}
          </div>
          {relLine.length > 0 && (
            <span className="mrel">
              {relLine.map((part, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {part}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="dt">
          {message.date ? dateTimeLabel(message.date) : ""}
          <span>{toMe ? "to you" : `to ${message.to}`}</span>
        </div>
      </div>
      <div className="acts2">
        <Button kind="solid" icon="back" onClick={onReply}>
          Reply
        </Button>
        <Button onClick={onForward}>Forward</Button>
        {message.html && (
          <>
            <Button ref={more} kind="quiet" icon="dots" aria-label="More" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
            {menu && (
              <Menu
                anchor={more}
                label="More"
                onClose={() => setMenu(false)}
                items={[{ label: images ? "Block images" : "Show images", onSelect: () => onImages(!images) }]}
              />
            )}
          </>
        )}
      </div>
      <MessageBody message={message} images={images} onShowImages={() => onImages(true)} />
      {draft}
    </article>
  );
}
