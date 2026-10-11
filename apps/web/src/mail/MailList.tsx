/**
 * The list: Mail's header (the account, Check now, Write), the drafts Orr is holding for you,
 * the category tabs, and the messages. Every row is a link to its message (§1.7 #7), arrow keys
 * move between rows, and a click the app follows itself (⌘-click still opens a new tab).
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { InboxItem, PendingDraft } from "@basalt/schema/responses";
import { Button, Ring, Square } from "../ui/controls.js";
import { Icon } from "../ui/Icon.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { Menu } from "../ui/overlays.js";
import { Notice, Skeleton } from "../ui/states.js";
import { draftedAt } from "./DraftCard.js";
import { fitTabs, splitTabs, TAB_LABEL, TABS_SHOWN, type MailTab, type TabInfo } from "./tabs.js";
import { listWhen } from "./when.js";

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** A link the app follows itself. */
function A({ href, onGo, className, children, label, current }: { href: string; onGo: () => void; className?: string; children: ReactNode; label?: string; current?: boolean }) {
  return (
    <a
      className={className}
      href={href}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      data-row=""
      onClick={(e) => {
        if (!plainClick(e)) return;
        e.preventDefault();
        onGo();
      }}
    >
      {children}
    </a>
  );
}

/** Arrow keys between the rows of a list. */
const arrows = (e: KeyboardEvent<HTMLElement>) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row]")];
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const to = rows[e.key === "ArrowDown" ? i + 1 : i - 1];
  if (i < 0 || !to) return;
  e.preventDefault();
  to.focus();
};

export interface RowLook {
  /** The name on the row: the sender, and their company when you know it. */
  who: string;
  company: boolean;
}

export function MailList({
  provider,
  address,
  loading,
  failed,
  messages,
  tabs,
  tab,
  onTab,
  selected,
  look,
  hrefOf,
  onOpen,
  pending,
  toNameOf,
  draftHref,
  onDraft,
  onDiscardDraft,
  waitingHref,
  onWaiting,
  onCheck,
  onWrite,
  onRetry,
  settingsHref,
  onSettings,
}: {
  provider: string;
  address: string;
  loading: boolean;
  failed: boolean;
  messages: InboxItem[] | null;
  tabs: TabInfo[];
  tab: MailTab;
  onTab: (t: MailTab) => void;
  selected: number | null;
  look: (m: InboxItem) => RowLook;
  hrefOf: (uid: number) => string;
  onOpen: (uid: number) => void;
  pending: PendingDraft[];
  toNameOf: (address: string) => string;
  draftHref: (id: string) => string;
  onDraft: (id: string) => void;
  onDiscardDraft: (id: string) => void;
  waitingHref: string;
  onWaiting: () => void;
  onCheck: () => void;
  onWrite: () => void;
  onRetry: () => void;
  settingsHref: string;
  onSettings: () => void;
}) {
  const shown = (messages ?? []).filter((m) => tab === "all" || m.category === tab);
  /*
   * How many tabs fit (§2.8: what doesn't fit goes into More, so All never scrolls out of
   * view). A hidden copy of every tab, and of More, is measured against the strip; again
   * whenever the strip changes width. Before there is a layout to measure, five.
   */
  const strip = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(TABS_SHOWN);
  const tabsKey = tabs.map((t) => `${t.id}:${t.unread}`).join(",");
  useLayoutEffect(() => {
    const el = strip.current;
    const r = ruler.current;
    if (!el || !r) return;
    const measure = () => {
      const widths = [...r.children].map((c) => (c as HTMLElement).offsetWidth);
      const style = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      setFit(fitTabs(widths.slice(0, -1), widths[widths.length - 1] ?? 0, room, 2) ?? TABS_SHOWN);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabsKey]);
  const { row, more } = splitTabs(tabs, fit, tab);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const tabButton = (t: TabInfo) => (
    <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} data-id={t.id} onClick={() => onTab(t.id)}>
      {t.label}
      {t.unread > 0 && t.id !== "all" && <span className="n">{t.unread}</span>}
    </button>
  );

  let body: ReactNode;
  if (loading && !messages?.length) body = <Skeleton rows={6} label="Fetching your inbox" />;
  else if (messages && messages.length === 0 && !failed) body = <p className="mhint">Your inbox is empty.</p>;
  else if (shown.length === 0 && messages?.length)
    body = (
      <p className="mhint">
        {tab === "primary"
          ? `No personal mail in the last ${messages.length}: everything recent is filed under the other tabs.`
          : `Nothing in ${TAB_LABEL[tab]}.`}
      </p>
    );
  else
    body = shown.map((m) => {
      const l = look(m);
      return (
        <A
          key={m.uid}
          href={hrefOf(m.uid)}
          onGo={() => onOpen(m.uid)}
          current={selected === m.uid}
          className={`mr${selected === m.uid ? " on" : ""}${m.seen ? "" : " unread"}`}
        >
          {l.company ? <Square name={m.fromName || m.from} /> : <Ring name={m.fromName || m.from} />}
          <span className="mwho">
            {l.who}
            {!m.seen && <span className="sr"> (unread)</span>}
          </span>
          <span className="mwhen">{listWhen(m.date)}</span>
          <span className="msub">{m.seen ? m.subject || "(no subject)" : <b>{m.subject || "(no subject)"}</b>}</span>
        </A>
      );
    });

  return (
    <section className="mlist" aria-label="Messages">
      <div className="mlist-top">
        <h1>Mail</h1>
        <span className="acct" title={address}>
          <i aria-hidden="true" className={failed ? "bad" : undefined} />
          {provider}
        </span>
        <span className="sp" />
        <Button kind="quiet" size="sm" icon="repeat" aria-label="Check now" tip="Check now" data-tip-at="top" disabled={loading} onClick={onCheck} />
        <Button size="sm" icon="pen" onClick={onWrite}>
          Write
        </Button>
      </div>
      {failed && (
        <div className="mnotice">
          <Notice
            title={`Couldn't reach ${provider}.`}
            text={messages?.length ? "The app password may have changed. Mail you already have is still here." : "The app password may have changed, or the connection dropped."}
            actions={
              <>
                <Button size="sm" onClick={onRetry}>
                  Retry
                </Button>
                <a
                  className="btn sm quiet"
                  href={settingsHref}
                  onClick={(e) => {
                    if (!plainClick(e)) return;
                    e.preventDefault();
                    onSettings();
                  }}
                >
                  Settings → Mail
                </a>
              </>
            }
          />
        </div>
      )}
      {pending.length > 0 && (
        <div className="wait" onKeyDown={arrows}>
          <h3>
            <HeadMark size={16} />
            <A href={waitingHref} onGo={onWaiting} className="ui-nm">
              Waiting for you · {pending.length}
            </A>
          </h3>
          <p>Orr drafts; sending is yours. Nothing leaves until you press Send.</p>
          {pending.map((p) => (
            <div key={p.id} className="dr">
              <A href={draftHref(p.id)} onGo={() => onDraft(p.id)} className="dr-open" label={`Review the draft ${p.subject || "(no subject)"}`}>
                <Icon name="pen" size={14} />
                <span className="x">
                  <span className="t">{p.subject || "(no subject)"}</span>
                  <span className="m">
                    to {toNameOf(p.to)} · drafted {draftedAt(p).replace(/^(at|on) /, "")}
                  </span>
                </span>
                <span className="r">Review</span>
              </A>
              <Button kind="quiet" size="sm" icon="x" className="dr-x" aria-label={`Discard the draft ${p.subject || "(no subject)"}`} tip="Discard" data-tip-at="top" onClick={() => onDiscardDraft(p.id)} />
            </div>
          ))}
        </div>
      )}
      {tabs.length > 1 && (
        <div
          ref={strip}
          className="tabs mtabs"
          role="tablist"
          aria-label="Categories"
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
            const i = list.indexOf(document.activeElement as HTMLButtonElement);
            const to = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
            if (i < 0 || !to) return;
            e.preventDefault();
            to.focus();
            if (to.dataset.id) onTab(to.dataset.id as MailTab);
          }}
        >
          <div ref={ruler} className="mtabs-ruler" aria-hidden="true">
            {tabs.map((t) => (
              <button key={t.id} type="button" tabIndex={-1}>
                {t.label}
                {t.unread > 0 && t.id !== "all" && <span className="n">{t.unread}</span>}
              </button>
            ))}
            <button type="button" className="mtab-more" tabIndex={-1}>
              More
              <Icon name="chev-d" size={12} />
            </button>
          </div>
          {row.map(tabButton)}
          {more.length > 0 && (
            <>
              <button
                ref={moreBtn}
                type="button"
                className="mtab-more"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              >
                More
                <Icon name="chev-d" size={12} />
              </button>
              {moreOpen && (
                <Menu
                  anchor={moreBtn}
                  label="More categories"
                  onClose={() => setMoreOpen(false)}
                  items={more.map((t) => ({ label: t.unread ? `${t.label} · ${t.unread}` : t.label, onSelect: () => onTab(t.id) }))}
                />
              )}
            </>
          )}
        </div>
      )}
      <div className="list" onKeyDown={arrows}>
        {body}
      </div>
    </section>
  );
}
