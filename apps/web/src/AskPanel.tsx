/**
 * Ask Orr (structure.md §2.11, the Ask board): a panel beside the page on the desktop, the
 * centre tab, full screen, on the phone.
 *
 * - His head and his name in the header, the earlier questions on this device (Jules, 11 Oct)
 *   and close; ⌘J opens and closes it (App).
 * - Answers are Markdown, read into elements (ask/markdown.ts, never set as HTML), and every
 *   [[citation]] opens its thing: the project page, the person, the company, the note. A link
 *   follows the address and the panel stays open (on the phone, where the panel is the screen,
 *   it steps aside for the page).
 * - While he works, he thinks (or reads) and each step appears as it happens; once he has
 *   answered, the steps fold under the answer as "How I found this", each a sentence with what
 *   it found as names that open their things (ask/working.ts).
 * - The note the page is about goes with every question as `contextNoteId` (AI-012).
 * - Stop ends his run, and so does closing the panel (AI-006): the request closes and the
 *   server stops the model and every tool call after it.
 *
 * Mail he writes waits in Mail → Waiting for you; he never sends it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { api, getToken } from "./api.js";
import { Markdown } from "./ask/Answer.js";
import { HISTORY_MAX, readHistory, saveConversation, type Conversation } from "./ask/history.js";
import { citedNote, contextNoteOf, EMPTY_VAULT, noteRoute, targetRoute, titleOf, type Vault } from "./ask/targets.js";
import { stepOf, type Step } from "./ask/working.js";
import type { LinkRef } from "./notes/links.js";
import { readKey, removeKey, writeKey } from "./storage.js";
import { Button, LinkButton } from "./ui/controls.js";
import { dateLabel, timeLabel } from "./ui/dates.js";
import { Icon } from "./ui/Icon.js";
import { HeadMark, Orr } from "./ui/orr/Orr.js";
import { Popover } from "./ui/overlays.js";
import { navigate, routeHref, useRoute, type Route } from "./ui/router.js";
import { EmptyState, Notice } from "./ui/states.js";

/** The conversation the panel had open, so closing and opening it again (or a reload) finds it. */
const OPEN_KEY = "basalt-ask-open";

const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 760px)").matches;

/** A link the app follows itself; a ⌘-click still opens a new tab. */
const follow = (to: Route) => (e: MouseEvent) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(to);
};

/**
 * The notes Orr's tools returned in this conversation, by title and by path: a citation names
 * the note he read before any other note of that name (targets.ts).
 */
function seenNotes(messages: UIMessage[]): LinkRef[] {
  const out: LinkRef[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 5) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && typeof o.title === "string") out.push({ target: o.title, targetId: o.id });
    if (typeof o.id === "string" && typeof o.path === "string") out.push({ target: o.path.replace(/\.md$/i, ""), targetId: o.id });
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  for (const m of messages) for (const p of m.parts) if ("output" in p && p.state === "output-available") visit(p.output, 0);
  return out;
}

/** An assistant message as the panel draws it: its words, and its tool calls as steps. */
function readMessage(m: UIMessage): { text: string; steps: Step[]; reading: boolean } {
  const text: string[] = [];
  const steps: Step[] = [];
  let reading = false;
  for (const p of m.parts) {
    if (p.type === "text") text.push(p.text);
    else if (p.type === "dynamic-tool" || p.type.startsWith("tool-")) {
      const tool = p.type === "dynamic-tool" ? (p as { toolName: string }).toolName : p.type.slice("tool-".length);
      const part = p as { state: string; input?: unknown; output?: unknown };
      const step = stepOf(tool, part.state, part.input, part.output);
      steps.push(step);
      if (step.state === "running") reading = /^(read_note|read_email|search_vault|list_summaries)$/.test(tool);
    }
  }
  return { text: text.filter((t) => t.trim()).join("\n\n"), steps, reading };
}

/** Who reads what Orr reads, said plainly under the field. */
function readBy(provider: string | null): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  if (provider === "chatgpt") return "OpenAI";
  return "the model you set up";
}

interface Status {
  configured: boolean;
  provider: string | null;
}

export function AskPanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [vault, setVault] = useState<Vault>(EMPTY_VAULT);
  const route = useRoute();

  // Whether Orr has a model, and the vault the names lead into: asked together, so a question
  // is never sent before the panel knows which note the page is about. A vault that does not
  // load leaves the citations as text; it never stops a question.
  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      api<Status>("GET", "/api/ai/status"),
      api<Vault["tree"]>("GET", "/api/vault/tree"),
      api<Vault["projects"]>("GET", "/api/projects"),
    ]).then(([s, tree, projects]) => {
      if (!live) return;
      setVault({ tree: tree.status === "fulfilled" ? tree.value : [], projects: projects.status === "fulfilled" ? projects.value : [] });
      setStatus(s.status === "fulfilled" ? s.value : { configured: false, provider: null });
    });
    return () => {
      live = false;
    };
  }, []);

  // On the phone the panel is the screen: going somewhere (a citation, a tab) shows that page.
  const href = route ? routeHref(route) : "";
  const firstHref = useRef(href);
  useEffect(() => {
    if (href !== firstHref.current && isPhone()) onClose();
  }, [href, onClose]);

  // Which conversation is open: the one left open, else a new one.
  const [history, setHistory] = useState<Conversation[]>(readHistory);
  const [open, setOpen] = useState<Conversation | null>(() => {
    const id = readKey(OPEN_KEY);
    return (id && readHistory().find((c) => c.id === id)) || null;
  });
  const [fresh, setFresh] = useState(() => crypto.randomUUID());
  const id = open?.id ?? fresh;
  useEffect(() => writeKey(OPEN_KEY, id), [id]);
  const startNew = () => {
    removeKey(OPEN_KEY);
    setOpen(null);
    setFresh(crypto.randomUUID());
  };

  const historyButton = useRef<HTMLButtonElement>(null);
  const [showHistory, setShowHistory] = useState(false);

  return (
    <aside className="ui askp" aria-label="Ask Orr">
      <header className="ask-h">
        <HeadMark size={20} />
        <h2>Ask Orr</h2>
        <span className="sp" />
        <Button
          ref={historyButton}
          kind="quiet"
          size="sm"
          icon="clock"
          aria-label="Earlier questions"
          tip="Earlier questions"
          data-tip-at="top"
          aria-haspopup="dialog"
          aria-expanded={showHistory}
          onClick={() => {
            setHistory(readHistory());
            setShowHistory((v) => !v);
          }}
        />
        <Button kind="quiet" size="sm" icon="x" aria-label="Close" tip="Close  ⌘J" data-tip-at="top" onClick={onClose} />
      </header>
      {showHistory && (
        <Popover anchor={historyButton} onClose={() => setShowHistory(false)} label="Earlier questions" className="popover ask-hist" align="end">
          <button
            type="button"
            className="ask-hist-new"
            onClick={() => {
              setShowHistory(false);
              startNew();
            }}
          >
            <Icon name="plus" size={16} />
            New conversation
          </button>
          {history.length > 0 ? (
            <ul aria-label={`Your last ${HISTORY_MAX} conversations, on this device`}>
              {history.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={c.id === id ? "true" : undefined}
                    onClick={() => {
                      setShowHistory(false);
                      setOpen(c);
                    }}
                  >
                    <span className="t">{c.title}</span>
                    <span className="d">{dateLabel(c.at) === dateLabel(Date.now()) ? timeLabel(c.at) : dateLabel(c.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="q3">Your questions are kept here, on this device.</p>
          )}
        </Popover>
      )}
      <Chat
        key={id}
        id={id}
        initial={(open?.messages ?? []) as unknown as UIMessage[]}
        status={status}
        vault={vault}
        route={route}
        onSaved={setHistory}
      />
    </aside>
  );
}

/** One conversation: its messages, the request, and the field you ask in. */
function Chat({
  id,
  initial,
  status,
  vault,
  route,
  onSaved,
}: {
  id: string;
  initial: UIMessage[];
  status: Status | null;
  vault: Vault;
  route: Route | null;
  onSaved: (all: Conversation[]) => void;
}) {
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // The note the page is about goes with each question (AI-012); read when the question is sent.
  const context = useRef<string | undefined>(undefined);
  context.current = route ? contextNoteOf(route, vault) : undefined;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/ask",
        headers: () => ({ Authorization: `Bearer ${getToken()}` }),
        body: () => (context.current ? { contextNoteId: context.current } : {}),
      }),
    [],
  );
  const { messages, sendMessage, status: run, error, stop } = useChat({ id, messages: initial, transport });
  const busy = run === "submitted" || run === "streaming";

  // Closing the panel ends the run (AI-006): the request closes, and the server stops the model
  // and every tool call after it. A ref, so a new `stop` on a later render never ends it early.
  const stopRun = useRef(stop);
  stopRun.current = stop;
  useEffect(
    () => () => {
      void stopRun.current();
    },
    [],
  );

  // Kept on this device once an answer is in, and when the conversation is put away.
  const latest = useRef(messages);
  latest.current = messages;
  useEffect(() => {
    if (!busy && messages.length) onSaved(saveConversation(id, messages as never));
  }, [busy, messages, id, onSaved]);
  useEffect(
    () => () => {
      if (latest.current.length) saveConversation(id, latest.current as never);
    },
    [id],
  );

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, run]);
  useEffect(() => {
    if (!isPhone()) field.current?.focus();
  }, []);

  const seen = useMemo(() => seenNotes(messages), [messages]);
  /** A citation: a link to its note's page when the note is known, its words when it is not. */
  const cite = (target: string, label: string): ReactNode => {
    const note = citedNote(target, seen, vault);
    if (!note) return <span className="cite-none">{label}</span>;
    const to = noteRoute(note, vault);
    return (
      <a className="cite" href={routeHref(to)} onClick={follow(to)}>
        {label}
      </a>
    );
  };

  const ready = status?.configured === true;
  const ask = () => {
    const text = input.trim();
    if (!text || busy || !ready) return;
    void sendMessage({ text });
    setInput("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter asks; Shift-Enter is a new line; a word still being composed (an IME) is not sent.
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    ask();
  };
  // The field grows with what you type, up to a few lines.
  useEffect(() => {
    const f = field.current;
    if (!f) return;
    f.style.height = "auto";
    f.style.height = `${Math.min(f.scrollHeight, 160)}px`;
  }, [input]);

  const context0 = context.current ? titleOf(context.current, vault) : undefined;
  const last = messages[messages.length - 1];

  return (
    <>
      <div className="ask-b" ref={scroller}>
        {status && !status.configured && (
          <EmptyState
            pose="hello"
            title="Orr needs a model to answer."
            text="Give him one in Settings: a key for Anthropic, Google or another provider, or your ChatGPT plan."
            actions={
              <LinkButton kind="solid" href={routeHref({ kind: "settings", section: "ai" })} onClick={follow({ kind: "settings", section: "ai" })}>
                Set up Orr
              </LinkButton>
            }
          />
        )}
        {ready && messages.length === 0 && (
          <div className="ask-hello">
            <p>
              He reads your notes, projects, people, calendar and mail, and says where he found what he tells you. He can add steps, events and
              projects. Mail he writes waits for you in Mail; he never sends it.
            </p>
            {context0 && (
              <p className="q3">
                He reads <b>{context0}</b> with your question.
              </p>
            )}
          </div>
        )}
        {messages.map((m) => {
          if (m.role === "user")
            return (
              <div key={m.id} className="you">
                {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
              </div>
            );
          if (m.role !== "assistant") return null;
          const { text, steps, reading } = readMessage(m);
          const working = busy && m === last;
          return (
            <div key={m.id} className="ans-turn">
              {text && (
                <div className="ans">
                  <Markdown text={text} cite={cite} />
                </div>
              )}
              {working ? <Working steps={steps} reading={reading} vault={vault} /> : steps.length > 0 && <HowIFound steps={steps} vault={vault} />}
            </div>
          );
        })}
        {busy && last?.role !== "assistant" && <Working steps={[]} reading={false} vault={vault} />}
        {error && (
          <Notice
            title="Orr couldn't finish that."
            text={error.message || "The model didn't answer."}
            actions={
              <LinkButton size="sm" href={routeHref({ kind: "settings", section: "ai" })} onClick={follow({ kind: "settings", section: "ai" })}>
                Check Orr's model
              </LinkButton>
            }
          />
        )}
      </div>
      <form
        className="ask-f"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <div className="ask-in">
          <textarea
            ref={field}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={status && !status.configured ? "Orr needs a model first" : "Ask about anything you keep"}
            disabled={!ready}
            aria-label="Question"
          />
          {busy ? (
            <Button size="sm" onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button type="submit" kind="solid" size="sm" icon="up" aria-label="Ask" disabled={!ready || !input.trim()} />
          )}
        </div>
        {ready && <p className="ask-hint">What he reads goes to {readBy(status.provider)} to answer.</p>}
      </form>
    </>
  );
}

/** While he works: Orr thinking (or reading), and each step as it happens. */
function Working({ steps, reading, vault }: { steps: Step[]; reading: boolean; vault: Vault }) {
  return (
    <div className="ask-work" role="status" aria-label="Orr is working">
      <Orr pose={reading ? "read" : "think"} size={48} />
      <div>
        <b>{reading ? "Reading" : "Thinking"}</b>
        {steps.length > 0 && <Steps steps={steps} vault={vault} />}
      </div>
    </div>
  );
}

/** Once he has answered: the steps, folded under the answer. */
function HowIFound({ steps, vault }: { steps: Step[]; vault: Vault }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="how">
      <button type="button" className="how-h" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="chev-r" size={14} />
        <span>How I found this</span>
      </button>
      {open && <Steps steps={steps} vault={vault} />}
    </div>
  );
}

function Steps({ steps, vault }: { steps: Step[]; vault: Vault }) {
  return (
    <ol className="steps">
      {steps.map((s, i) => (
        <li key={i} className={`step ${s.state}`}>
          {s.state === "running" ? <span className="pending" aria-label="Working on it" /> : <Icon name={s.state === "done" ? "check" : "warn"} size={14} label={s.state === "done" ? "Done" : "Didn't work"} />}
          <div>
            {s.text}
            {(s.found.length > 0 || s.more > 0) && (
              <div className="found">
                {s.found.map((f, j) => {
                  const to = targetRoute(f.to, vault);
                  const label = f.label || (f.to.kind === "note" ? titleOf(f.to.id, vault) : undefined) || "the note";
                  return (
                    <a key={j} href={routeHref(to)} onClick={follow(to)}>
                      {label}
                    </a>
                  );
                })}
                {s.more > 0 && <span className="more">and {s.more} more</span>}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
