import { useEffect, useRef, useState } from "react";
import type { ServerSettings } from "@orrama/schema/responses";
import { api, type Me, rememberEmail, sessionStarted, type SignedIn } from "./api.js";
import { Door, DoorError, DoorField, DoorFoot, PasswordField, reducedMotion, type DoorHandle } from "./door/Door.js";
import { NotesChoice, type NotesWay } from "./door/NotesChoice.js";
import { countingLine, firstRunCounts, foundDetail, foundLine, type FirstCounts } from "./door/shape.js";
import { doorError } from "./door/voice.js";
import { Button } from "./ui/controls.js";
import { navigate, type Route } from "./ui/router.js";

/** How long the notes take to arrive as dots, counted (the board's 3.2 s). */
const COUNT_MS = 3200;
/** The gather, before the two ways on appear. */
const GATHER_MS = 1500;

/** What the door says once the notes are there, by the way the person started. */
function readyWords(way: NotesWay, c: FirstCounts): { hi: string; detail: string } {
  if (way === "example") return { hi: "Your example is ready.", detail: foundDetail(c) };
  if (way === "empty" || c.notes === 0) return { hi: "Your notes start here.", detail: "Write your first one, and it'll be here." };
  return { hi: foundLine(c), detail: foundDetail(c) };
}

/**
 * First run (structure.md §2.14, take B). Shown when GET /api/auth/status reports an empty
 * install, which is the only time the register endpoint accepts a request without an invite:
 * the first account founds the workspace and owns it.
 *
 * 1. Your account: name, email, password, stored on this machine only. No dots yet.
 * 2. Where are your notes? Start with an example, start empty, or use notes you already have
 *    (door/NotesChoice.tsx). Also shown on its own (`resume`) when the founder signs in again
 *    before choosing: /api/auth/status says `chooseNotes` until it is settled.
 * 3. Orrama reads them: each one arrives as a dot as it's counted, then they gather. Show me how
 *    they relate (the Orrery), or Start with today.
 *
 * The counts are real, asked once the folder is settled.
 */
export function Setup({ onDone, resume }: { onDone: (me: Me) => void; resume?: Me }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Set once the account exists: next, where the notes are. */
  const [me, setMe] = useState<Me | null>(resume ?? null);
  /** The folder read now, for the chooser; then how the person started. */
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [serverFailed, setServerFailed] = useState(false);
  const [way, setWay] = useState<NotesWay | null>(null);
  const [counts, setCounts] = useState<FirstCounts | null>(null);
  /** 0–1 while counting; 1 once counted. */
  const [counted, setCounted] = useState(0);
  const [done, setDone] = useState(false);
  const door = useRef<DoorHandle>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);

  /** Derived, not asked for: it becomes a path segment under Personal/, so the
   *  fewer ways a person can hand-type something surprising, the better. */
  const username = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);

  const fail = (text: string, focus: HTMLInputElement | null) => {
    setError(text);
    door.current?.shake();
    focus?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!displayName.trim() || !email.trim() || !password) {
      return fail("Fill in all three, so Orrama can sign you in next time.", !displayName.trim() ? nameRef.current : !email.trim() ? emailRef.current : passRef.current);
    }
    if (password.length < 8) return fail("Make the password at least 8 characters.", passRef.current);
    // The server wants two characters at least (registerSchema): say so here, in words.
    if (username.length < 2) return fail("Use an email with at least two letters or digits before the @.", emailRef.current);
    setBusy(true);
    setError("");
    door.current?.think(true);
    try {
      const res = await api<SignedIn>("POST", "/api/auth/register", {
        email: email.trim(),
        username,
        displayName: displayName.trim(),
        password,
      });
      sessionStarted();
      rememberEmail(email.trim().toLowerCase());
      door.current?.think(false);
      setMe(res.user);
    } catch (err) {
      door.current?.think(false);
      setBusy(false);
      fail(doorError(err, "register").text, null);
    }
  };

  // 2: what the server reads now, for the chooser.
  useEffect(() => {
    if (!me || way) return;
    let alive = true;
    setServerFailed(false);
    api<ServerSettings>("GET", "/api/settings/server")
      .then((s) => alive && setServer(s))
      .catch(() => alive && setServerFailed(true));
    return () => {
      alive = false;
    };
  }, [me, way]);

  // 3: read what the server found, bring the dots in as they're counted, then gather.
  useEffect(() => {
    if (!me || !way) return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const reduce = reducedMotion();
    firstRunCounts()
      .then(({ counts: c, shape }) => {
        if (!alive) return;
        setCounts(c);
        const t0 = performance.now();
        const finish = () => {
          clearInterval(timer);
          setCounted(1);
          door.current?.dots()?.reveal(1);
          door.current?.dots()?.gather(shape);
          if (reduce) setDone(true);
          else setTimeout(() => alive && setDone(true), GATHER_MS);
        };
        if (reduce) return finish();
        timer = setInterval(() => {
          const f = Math.min(1, (performance.now() - t0) / COUNT_MS);
          setCounted(f);
          door.current?.dots()?.reveal(f);
          if (f >= 1) finish();
        }, 50);
      })
      .catch(() => {
        // The account exists either way; without the counts, just go on.
        if (alive) setDone(true);
      });
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [me, way]);

  const go = (to: Route) => {
    navigate(to);
    if (me) onDone(me);
  };

  const typed = (set: (v: string) => void) => (v: string) => {
    set(v);
    setError("");
  };

  return (
    <Door ref={door} screen="first" isIn={done && !!counts} dots={{ hidden: true }}>
      {!me ? (
        <>
          <div className="dr-card dr-first1">
            <h1 className="dr-h">Welcome to Orrama</h1>
            <p className="dr-p">Make your account. It's stored on this machine only.</p>
            <form className="dr-form" onSubmit={submit} noValidate>
              <DoorField
                ref={nameRef}
                label="Your name"
                value={displayName}
                onChange={typed(setDisplayName)}
                autoComplete="name"
                placeholder="What should Orr call you?"
                autoFocus
              />
              <DoorField ref={emailRef} label="Email" type="email" value={email} onChange={typed(setEmail)} autoComplete="username" placeholder="you@example.com" />
              <PasswordField ref={passRef} value={password} onChange={typed(setPassword)} autoComplete="new-password" />
              <DoorError text={error} />
              <Button kind="solid" type="submit" className="dr-go" disabled={busy}>
                {busy ? "Making your account…" : "Continue"}
              </Button>
            </form>
          </div>
          <DoorFoot />
        </>
      ) : !way ? (
        <>
          <div className="dr-card dr-first2">
            <h1 className="dr-h">Where are your notes?</h1>
            <p className="dr-p">Orrama keeps them as files on this computer, so they stay yours.</p>
            {server ? (
              <NotesChoice server={server} place="first" onDone={(w) => setWay(w)} />
            ) : serverFailed ? (
              <p className="dr-err" role="alert">
                Orrama's server isn't answering. Reload the page to try again.
              </p>
            ) : null}
          </div>
          <DoorFoot />
        </>
      ) : (
        <>
          <div className="dr-first3" aria-live="polite">
            {done && counts ? (
              <>
                <b className="dr-hi">{readyWords(way, counts).hi}</b>
                <p className="dr-count">{readyWords(way, counts).detail}</p>
              </>
            ) : done ? (
              <b className="dr-hi">Your account is ready.</b>
            ) : (
              <>
                <b className="dr-hi">Reading your notes…</b>
                <p className="dr-count">{counts ? countingLine(counts, counted) : " "}</p>
              </>
            )}
            {done && (
              <div className="dr-acts">
                {counts && counts.notes > 0 && way !== "empty" && (
                  <Button kind="solid" onClick={() => go({ kind: "orrery" })}>
                    Show me how they relate
                  </Button>
                )}
                <Button kind={counts && counts.notes > 0 && way !== "empty" ? "default" : "solid"} onClick={() => go({ kind: "today" })}>
                  Start with today
                </Button>
              </div>
            )}
          </div>
          <DoorFoot />
        </>
      )}
    </Door>
  );
}
