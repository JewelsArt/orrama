import { useEffect, useRef, useState } from "react";
import { api, rememberEmail, setToken, type Me } from "./api.js";
import { Door, DoorError, DoorField, DoorFoot, PasswordField, reducedMotion, type DoorHandle } from "./door/Door.js";
import { countingLine, firstRunCounts, foundDetail, foundLine, type FirstCounts } from "./door/shape.js";
import { doorError } from "./door/voice.js";
import { Button } from "./ui/controls.js";
import { navigate, type Route } from "./ui/router.js";

/** How long the notes take to arrive as dots, counted (the board's 3.2 s). */
const COUNT_MS = 3200;
/** The gather, before the two ways on appear. */
const GATHER_MS = 1500;

/**
 * First run (structure.md §2.14, take B). Shown when GET /api/auth/status reports an empty
 * install, which is the only time the register endpoint accepts a request without an invite:
 * the first account founds the workspace and owns it.
 *
 * 1. Your account: name, email, password, stored on this machine only. No dots yet.
 * 2. Orrama reads your notes: each one arrives as a dot as it's counted.
 * 3. They gather: "I found 312 notes." Show me how they relate (the Orrery), or Start with today.
 *
 * Choosing the notes folder is for later (structure.md §2.14, decided 8 October): first run reads
 * the folder the server started with. The counts are real, asked once the account exists.
 */
export function Setup({ onDone }: { onDone: (me: Me) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Set once the account exists: Orrama is reading the notes. */
  const [me, setMe] = useState<Me | null>(null);
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
      const res = await api<{ token: string; user: Me }>("POST", "/api/auth/register", {
        email: email.trim(),
        username,
        displayName: displayName.trim(),
        password,
      });
      setToken(res.token);
      rememberEmail(email.trim().toLowerCase());
      door.current?.think(false);
      setMe(res.user);
    } catch (err) {
      door.current?.think(false);
      setBusy(false);
      fail(doorError(err, "register").text, null);
    }
  };

  // 2 and 3: read what the server found, bring the dots in as they're counted, then gather.
  useEffect(() => {
    if (!me) return;
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
  }, [me]);

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
      ) : (
        <>
          <div className="dr-first3" aria-live="polite">
            {done && counts ? (
              <>
                <b className="dr-hi">{foundLine(counts)}</b>
                <p className="dr-count">{foundDetail(counts)}</p>
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
                {counts && counts.notes > 0 && (
                  <Button kind="solid" onClick={() => go({ kind: "orrery" })}>
                    Show me how they relate
                  </Button>
                )}
                <Button kind={counts && counts.notes > 0 ? "default" : "solid"} onClick={() => go({ kind: "today" })}>
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
