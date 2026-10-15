/**
 * Mail (structure.md §2.8): reading and answering mail without leaving. The list and the message
 * side by side on the desktop; on the phone the list, then the message on its own screen with
 * Back, then the reply on its own (§1.6).
 *
 * Addresses (§1.2): `/mail` the list, `/mail/<uid>` a message, `/mail/waiting` the drafts Orr is
 * holding, and `?write=new|reply|forward` or `?draft=<id>` the composer over whichever page it
 * opened from (mail/compose.ts).
 *
 * This file holds the state and every request the screen makes (the contract test scans this
 * folder's top level for GETs); the pieces it draws are in mail/.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Company, Contact, GraphRelations, InboxItem, MailAccount as Account, MailMessage, PendingDraft, ProjectRow } from "@orrama/schema/responses";
import { api, isAbort, latestOnly, type Me } from "./api.js";
import { Confirm, type ConfirmRequest } from "./Confirm.js";
import { readKey, writeKey } from "./storage.js";
import { Button, LinkButton } from "./ui/controls.js";
import { goBack, navigate, routeHref, useLocation, useRoute, type Route } from "./ui/router.js";
import { EmptyState, Notice, Skeleton } from "./ui/states.js";
import { attempt } from "./ui/writes.js";
import { toast } from "./ui/overlays.js";
import { Composer } from "./mail/Composer.js";
import { composeHref, composeOf, emptyDraft, forwardDraft, replyDraft, stagedDraft, type Compose, type Draft } from "./mail/compose.js";
import { DraftCard } from "./mail/DraftCard.js";
import { MailList, type RowLook } from "./mail/MailList.js";
import { imagesAllowed, setImagesAllowed } from "./mail/MessageBody.js";
import { addressOf, entitySlug, matchSender, projectSlugs, type Sender } from "./mail/people.js";
import { Reader, type Relation } from "./mail/Reader.js";
import { mailTabs, validTab, type MailTab } from "./mail/tabs.js";
import { Waiting } from "./mail/Waiting.js";

const TAB_KEY = "orrama-mail-tab";
const SETTINGS: Route = { kind: "settings", section: "connections" };

interface People {
  contacts: Contact[];
  companies: Company[];
  projects: ProjectRow[];
}

export function Mail(_props: { me: Me }) {
  const route = useRoute();
  const href = useLocation();
  const at = useMemo<Extract<Route, { kind: "mail" }>>(() => (route?.kind === "mail" ? route : { kind: "mail" }), [route]);
  const uid = at.id && /^\d+$/.test(at.id) ? Number(at.id) : null;
  const path = routeHref(at);
  const compose = composeOf(href.includes("?") ? href.slice(href.indexOf("?")) : "");

  // null: the account couldn't be read — said with Retry, never as "Mail isn't connected" (WEB-010).
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [accountTry, setAccountTry] = useState(0);
  const [messages, setMessages] = useState<InboxItem[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [pending, setPending] = useState<PendingDraft[]>([]);
  const [draftsLoaded, setDraftsLoaded] = useState(false);
  const [people, setPeople] = useState<People>({ contacts: [], companies: [], projects: [] });

  const [storedTab, setStoredTab] = useState<string | null>(() => readKey(TAB_KEY));
  const tabs = useMemo(() => mailTabs(messages ?? []), [messages]);
  const tab = validTab(storedTab, tabs);
  const pickTab = (t: MailTab) => {
    writeKey(TAB_KEY, t);
    setStoredTab(t);
  };

  const [message, setMessage] = useState<MailMessage | null>(null);
  const [loadingMsg, setLoadingMsg] = useState(false);
  const [msgFailed, setMsgFailed] = useState(false);
  // Click one message, then another: the first one's body must not land last.
  const [nextMessage] = useState(latestOnly);
  const [images, setImages] = useState(imagesAllowed);
  const [relations, setRelations] = useState<Relation[]>([]);
  const [sendingDraft, setSendingDraft] = useState<string | null>(null);
  const [failedDraft, setFailedDraft] = useState<string | null>(null);

  /* ---- loading ------------------------------------------------------------------------- */

  const loadDrafts = useCallback(async () => {
    setPending(await api<PendingDraft[]>("GET", "/api/mail/drafts").catch(() => []));
    setDraftsLoaded(true);
  }, []);

  const loadInbox = useCallback(async () => {
    setLoadingList(true);
    setListFailed(false);
    try {
      const r = await api<{ email: string; messages: InboxItem[] }>("GET", "/api/mail/inbox?limit=80");
      setMessages(r.messages);
    } catch {
      // What failed is said in words (the list's notice), never the server's text.
      setListFailed(true);
      setMessages((prev) => prev ?? []);
    } finally {
      setLoadingList(false);
    }
  }, []);

  /** The people and companies a sender can be, and the projects a relation can open. */
  const loadPeople = useCallback(async () => {
    const [contacts, companies, projects] = await Promise.all([
      api<Contact[]>("GET", "/api/contacts").catch(() => []),
      api<Company[]>("GET", "/api/companies").catch(() => []),
      api<ProjectRow[]>("GET", "/api/projects").catch(() => []),
    ]);
    setPeople({ contacts, companies, projects });
  }, []);

  useEffect(() => {
    void api<Account>("GET", "/api/mail/account")
      .then((a) => {
        setAccount(a);
        if (a.connected) {
          void loadInbox();
          void loadDrafts();
          void loadPeople();
        }
      })
      .catch(() => setAccount(null));
  }, [loadInbox, loadDrafts, loadPeople, accountTry]);

  const [retry, setRetry] = useState(0);
  const connected = !!account?.connected;
  useEffect(() => {
    if (uid === null || !connected) return;
    setMsgFailed(false);
    setLoadingMsg(true);
    const signal = nextMessage();
    api<MailMessage>("GET", `/api/mail/message/${uid}`, undefined, { signal })
      .then((m) => {
        setMessage(m);
        // Reflect the read state in the list without a full refetch.
        setMessages((prev) => prev?.map((x) => (x.uid === uid ? { ...x, seen: true } : x)) ?? prev);
      })
      .catch((e) => {
        if (isAbort(e)) return;
        setMessage(null);
        setMsgFailed(true);
      })
      .finally(() => {
        // A newer message is loading: its skeleton is not ours to stop.
        if (!signal.aborted) setLoadingMsg(false);
      });
  }, [uid, connected, nextMessage, retry]);

  /* ---- who the senders are ---------------------------------------------------------------- */

  const senderOf = useCallback((from: string, fromName: string): Sender => matchSender(from, fromName, people.contacts, people.companies), [people]);
  const slugs = useMemo(() => projectSlugs(people.projects), [people.projects]);
  const look = useCallback(
    (m: InboxItem): RowLook => {
      const s = senderOf(m.from, m.fromName);
      const name = m.fromName || m.from || "Unknown sender";
      const where = s.contact ? (s.company?.name ?? s.companyName) : undefined;
      return { who: where ? `${name} · ${where}` : name, company: s.kind === "company" };
    },
    [senderOf],
  );
  const contactNameOf = useCallback(
    (to: string): string | undefined => {
      const a = addressOf(to);
      return people.contacts.find((c) => c.email && c.email.toLowerCase().split(/[,;\s]+/).includes(a))?.name;
    },
    [people.contacts],
  );

  const shown = message && message.uid === uid ? message : null;
  const sender = shown ? senderOf(shown.from, shown.fromName) : undefined;
  const contactId = sender?.contact?.id;
  const companyId = sender?.company?.id;
  // How you know the sender, from the knowledge graph: "supervises Graduation thesis". On a vault
  // without an ontology there are no typed relations, and the line says only role and company.
  useEffect(() => {
    setRelations([]);
    if (!contactId) return;
    let live = true;
    api<GraphRelations>("GET", `/api/graph/relations?entity=${encodeURIComponent(contactId)}`)
      .then((g) => {
        if (!live) return;
        const out: Relation[] = [];
        for (const r of g.relations)
          for (const t of r.to) {
            if (t.id === companyId || t.id === contactId || out.some((o) => o.title === t.title)) continue;
            const project = slugs.get(t.id);
            const person = people.contacts.find((c) => c.id === t.id);
            const company = people.companies.find((c) => c.id === t.id);
            const to: Route = project
              ? { kind: "project", slug: project }
              : person
                ? { kind: "person", slug: entitySlug(person.path) }
                : company
                  ? { kind: "company", slug: entitySlug(company.path) }
                  : { kind: "notes", id: t.id };
            out.push({ relation: r.relation.replace(/[_-]+/g, " "), title: t.title, to });
          }
        setRelations(out.slice(0, 2));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [contactId, companyId, slugs, people.contacts, people.companies]);

  /* ---- leaving the composer, and going places ------------------------------------------------ */

  /*
   * Each draft gets its own composer (WEB-006). The composer copies its draft into its fields
   * once, so a second draft shown in the same instance kept the first one's text under the
   * second one's id and headers: Send mailed A's words threaded to B and deleted B unsent. The
   * key is the composer's address plus a count bumped each time one is opened, so every draft,
   * even the same one again, starts a fresh composer.
   */
  const [composerKey, setComposerKey] = useState(0);
  /** Whether the open composer holds something the user typed; it would be lost by leaving. */
  const dirty = useRef(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  /** Leave the composer: straight away if nothing was typed, else only once the user says so. */
  const leaveComposer = useCallback((go: () => void) => {
    if (!dirty.current) return go();
    setConfirm({
      title: "Discard this message?",
      body: "What you wrote here hasn't been sent or saved.",
      confirmLabel: "Discard",
      danger: true,
      onConfirm: () => {
        dirty.current = false;
        go();
      },
    });
  }, []);

  const go = useCallback((to: Route | string) => leaveComposer(() => navigate(to)), [leaveComposer]);
  const openCompose = useCallback(
    (c: Compose) =>
      leaveComposer(() => {
        setComposerKey((k) => k + 1);
        navigate(composeHref(path, c));
      }),
    [leaveComposer, path],
  );
  /** Close the composer: back to the page it opened over. */
  const closeComposer = useCallback(() => {
    dirty.current = false;
    goBack(at);
  }, [at]);

  /* ---- drafts ------------------------------------------------------------------------------ */

  const composingDraft = compose?.kind === "draft" ? compose.id : null;
  const discardDraft = useCallback(
    async (id: string) => {
      if (!(await attempt("The draft wasn't discarded.", () => api("DELETE", `/api/mail/drafts/${id}`)))) return;
      if (composingDraft === id) closeComposer();
      void loadDrafts();
    },
    [composingDraft, closeComposer, loadDrafts],
  );

  /** Send a staged draft from its card: exactly the text the card shows, by the one send path. */
  const sendDraft = useCallback(
    async (p: PendingDraft) => {
      setSendingDraft(p.id);
      setFailedDraft(null);
      try {
        await api("POST", "/api/mail/send", { to: p.to, subject: p.subject, body: p.body, inReplyTo: p.inReplyTo ?? undefined, references: p.references ?? undefined });
        // Sent is sent; a draft still listed after it would read as not sent and go twice.
        const cleared = await api("DELETE", `/api/mail/drafts/${p.id}`).then(() => true, () => false);
        toast(`Sent to ${contactNameOf(p.to) ?? p.to}.${cleared ? "" : " Its draft is still listed: discard it."}`);
        void loadDrafts();
      } catch {
        setFailedDraft(p.id);
      } finally {
        setSendingDraft(null);
      }
    },
    [loadDrafts, contactNameOf],
  );

  const waitingRoute: Route = { kind: "mail", waiting: true };
  const card = (p: PendingDraft, withWaiting: boolean) => (
    <DraftCard
      draft={p}
      toName={contactNameOf(p.to)}
      sending={sendingDraft === p.id}
      failed={failedDraft === p.id}
      onSend={() => void sendDraft(p)}
      onEdit={() => openCompose({ kind: "draft", id: p.id })}
      onDiscard={() => void discardDraft(p.id)}
      waitingHref={withWaiting ? routeHref(waitingRoute) : undefined}
      onWaiting={withWaiting ? () => go(waitingRoute) : undefined}
    />
  );

  /* ---- the screen -------------------------------------------------------------------------- */

  if (account === undefined)
    return (
      <div className="mail ui mail-off">
        <div className="mread">
          <Skeleton rows={4} label="Opening Mail" />
        </div>
      </div>
    );

  if (account === null)
    return (
      <div className="mail ui mail-off">
        <div className="mread">
          <h2>Mail</h2>
          <Notice
            title="Mail didn't open."
            text="The server didn't say whether mail is connected. Check it's running, then try again."
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setAccount(undefined);
                  setAccountTry((n) => n + 1);
                }}
              >
                Retry
              </Button>
            }
          />
        </div>
      </div>
    );

  if (!account?.connected)
    return (
      <div className="mail ui mail-off">
        <div className="mread">
          <h2>Mail</h2>
          <EmptyState
            pose="mail"
            title="Mail isn't connected yet."
            text="Connect your Gmail with an app password. Messages are read from Google when you open them and never stored, and nothing is sent anywhere but Google."
            actions={
              <LinkButton
                kind="solid"
                href={routeHref(SETTINGS)}
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
                  e.preventDefault();
                  navigate(SETTINGS);
                }}
              >
                Connect Gmail
              </LinkButton>
            }
          />
        </div>
      </div>
    );

  let draft: Draft | null | "gone" = null;
  if (compose?.kind === "new") draft = emptyDraft();
  else if (compose?.kind === "reply") draft = shown ? replyDraft(shown) : null;
  else if (compose?.kind === "forward") draft = shown ? forwardDraft(shown) : null;
  else if (compose?.kind === "draft") {
    const p = pending.find((d) => d.id === compose.id);
    draft = p ? stagedDraft(p) : draftsLoaded ? "gone" : null;
  }

  const unread = (messages ?? []).filter((m) => !m.seen).length;
  const replyCard = shown?.messageId ? pending.find((p) => p.inReplyTo === shown.messageId) : undefined;
  const provider = /gmail/i.test(account.imapHost ?? "") ? "Gmail" : (account.email ?? "Mail");

  let pane;
  if (compose) {
    pane =
      draft === "gone" ? (
        <div className="mread">
          <EmptyState pose="mail" title="That draft is gone." text="It was sent or discarded. Drafts still waiting are under Waiting for you." />
        </div>
      ) : draft ? (
        <div className="mread mread-compose">
          <Composer
            key={`${compose.kind}:${compose.kind === "draft" ? compose.id : ""}#${composerKey}`}
            draft={draft}
            from={account.email ?? ""}
            onDirty={(d) => {
              dirty.current = d;
            }}
            onClose={closeComposer}
            onSent={() => {
              dirty.current = false;
              closeComposer();
              void loadInbox();
              void loadDrafts();
            }}
          />
        </div>
      ) : (
        <div className="mread">
          <Skeleton rows={4} label="Opening the composer" />
        </div>
      );
  } else if (at.waiting) {
    pane = <Waiting pending={pending} loaded={draftsLoaded} card={(p) => card(p, false)} />;
  } else if (uid !== null) {
    pane = (
      <Reader
        message={shown}
        loading={loadingMsg}
        failed={msgFailed}
        onRetry={() => setRetry((n) => n + 1)}
        me={account.email ?? ""}
        sender={sender}
        personSlug={sender?.contact ? entitySlug(sender.contact.path) : undefined}
        companySlug={sender?.company ? entitySlug(sender.company.path) : undefined}
        relations={relations}
        images={images}
        onImages={(on) => {
          setImagesAllowed(on);
          setImages(on);
        }}
        onReply={() => openCompose({ kind: "reply" })}
        onForward={() => openCompose({ kind: "forward" })}
        onGo={go}
        draft={replyCard ? card(replyCard, true) : undefined}
      />
    );
  } else {
    pane = (
      <div className="mread mread-idle">
        {messages && unread === 0 && pending.length === 0 && !listFailed ? (
          <EmptyState pose="mail" title="Everything's answered." text="Nothing waits for you, and no drafts." />
        ) : (
          <p className="mhint">Pick a message to read it.</p>
        )}
      </div>
    );
  }

  return (
    <div className="mail ui" data-screen={compose || uid !== null || at.waiting ? "pane" : "list"}>
      <MailList
        provider={provider}
        address={account.email ?? ""}
        loading={loadingList}
        failed={listFailed}
        messages={messages}
        tabs={tabs}
        tab={tab}
        onTab={pickTab}
        selected={uid}
        look={look}
        hrefOf={(u) => routeHref({ kind: "mail", id: String(u) })}
        onOpen={(u) => go({ kind: "mail", id: String(u) })}
        pending={pending}
        toNameOf={(to) => contactNameOf(to) ?? to}
        draftHref={(id) => composeHref(path, { kind: "draft", id })}
        onDraft={(id) => openCompose({ kind: "draft", id })}
        onDiscardDraft={(id) => void discardDraft(id)}
        waitingHref={routeHref(waitingRoute)}
        onWaiting={() => go(waitingRoute)}
        onCheck={() => {
          void loadInbox();
          void loadDrafts();
        }}
        onWrite={() => openCompose({ kind: "new" })}
        onRetry={() => void loadInbox()}
        settingsHref={routeHref(SETTINGS)}
        onSettings={() => go(SETTINGS)}
      />
      {pane}
      <Confirm request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
