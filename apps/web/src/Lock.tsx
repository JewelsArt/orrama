import { useCallback, useEffect, useRef, useState } from "react";
import { api, lastEmail, type Me, type SignedIn, touchIdAvailable, unlockWithTouchId } from "./api.js";
import { After, BackspaceIcon, Door, DoorError, FingerprintIcon, PasswordField, useEnter, useNarrow, type DoorHandle } from "./door/Door.js";
import { cancelled, doorError } from "./door/voice.js";
import { Button } from "./ui/controls.js";
import { timeLabel } from "./ui/dates.js";

const LENGTH = 4;
const BACK = "Back where you left off.";

/**
 * Quick unlock for a device that has signed in before (structure.md §2.14, take B): the time,
 * Touch ID on the computer, the passcode keypad on the phone, and the password one click away.
 * The dots are dimmer: the vault is folded away. No name at the door: the remembered address
 * only says which account to ask about, and is never shown.
 *
 * The passcode is NOT checked here - it is posted to /api/auth/unlock and verified against an
 * argon2 hash with a server-side attempt counter. A four-digit secret is 10,000 combinations, so
 * a lock screen that decided the answer in the browser would be decoration. Wrong entries cool
 * down, and ten of them turn the passcode off until a password sign-in.
 *
 * Touch ID is offered only when the platform reports a user-verifying authenticator AND the
 * account has one enrolled. An account with neither way in has nothing to unlock with, so the
 * door hands over to the full sign-in (`onUsePassword`).
 */
export function Lock({ onUnlock, onUsePassword }: { onUnlock: (me: Me) => void; onUsePassword: () => void }) {
  const email = lastEmail();
  const narrow = useNarrow();
  const [digits, setDigitsState] = useState("");
  // The digits are read where they change, not inside a state updater: React may run an updater
  // twice (StrictMode does in development), and an updater that posts would spend two attempts.
  const typedDigits = useRef("");
  const setDigits = useCallback((next: string) => {
    typedDigits.current = next;
    setDigitsState(next);
  }, []);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [methods, setMethods] = useState<{ passcode: boolean; webauthn: boolean } | null>(null);
  /** Showing the password form instead of Touch ID or the keypad. */
  const [usePw, setUsePw] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const door = useRef<DoorHandle>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const { entered, enter } = useEnter(door);

  const usePassword = useRef(onUsePassword);
  usePassword.current = onUsePassword;
  useEffect(() => {
    let alive = true;
    (async () => {
      let m = { passcode: false, webauthn: false };
      try {
        const opts = await api<{ passcode: boolean; webauthn: boolean }>("POST", "/api/auth/unlock/options", { email });
        m = { passcode: opts.passcode, webauthn: opts.webauthn && (await touchIdAvailable()) };
      } catch {
        /* the server didn't say: nothing to unlock with */
      }
      if (!alive) return;
      if (!m.passcode && !m.webauthn) return usePassword.current();
      setMethods(m);
    })();
    return () => {
      alive = false;
    };
  }, [email]);

  // The time, kept current.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const fail = useCallback((text: string) => {
    setError(text);
    door.current?.shake();
  }, []);

  const toPassword = useCallback(() => {
    setUsePw(true);
    setDigits("");
    setTimeout(() => passRef.current?.focus(), 0);
  }, [setDigits]);

  const submitCode = useCallback(
    async (code: string) => {
      setBusy(true);
      setError("");
      door.current?.think(true);
      try {
        const res = await api<SignedIn>("POST", "/api/auth/unlock", { email, passcode: code });
        await enter(res, BACK, onUnlock);
      } catch (err) {
        door.current?.think(false);
        setBusy(false);
        setDigits("");
        const said = doorError(err, "passcode");
        if (said.passwordOnly) {
          setMethods((m) => m && { ...m, passcode: false });
          toPassword();
        }
        fail(said.text);
      }
    },
    [email, enter, onUnlock, fail, toPassword, setDigits],
  );

  const push = useCallback(
    (d: string) => {
      if (busy || entered || !methods?.passcode || usePw) return;
      if (typedDigits.current.length >= LENGTH) return;
      const next = typedDigits.current + d;
      door.current?.spark();
      setError("");
      setDigits(next);
      if (next.length === LENGTH) void submitCode(next);
    },
    [busy, entered, methods, usePw, submitCode, setDigits],
  );

  // A physical keyboard is the fastest way in on a laptop; the pad is for touch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) push(e.key);
      else if (e.key === "Backspace") setDigits(typedDigits.current.slice(0, -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push, setDigits]);

  const touchId = async () => {
    setBusy(true);
    setWaiting(true);
    setError("");
    door.current?.think(true);
    try {
      const res = await unlockWithTouchId(email);
      await enter(res, BACK, onUnlock);
    } catch (err) {
      door.current?.think(false);
      setBusy(false);
      setWaiting(false);
      // A dismissed prompt is a normal thing to do, not a failure worth saying anything about.
      if (!cancelled(err)) fail(doorError(err, "touchid").text);
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      fail("Enter your password.");
      passRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    door.current?.think(true);
    try {
      const res = await api<SignedIn>("POST", "/api/auth/login", { email, password });
      await enter(res, BACK, onUnlock);
    } catch (err) {
      door.current?.think(false);
      setBusy(false);
      fail(doorError(err, "password").text);
      passRef.current?.select();
    }
  };

  // The keypad is the phone's way in, and the computer's when it has no Touch ID.
  const pad = !!methods?.passcode && !usePw && (narrow || !methods.webauthn);
  // On a computer with Touch ID, digits typed on the keyboard still unlock; the pins show once you type.
  const pins = !!methods?.passcode && !usePw && (pad || digits.length > 0);
  const touch = !!methods?.webauthn && !usePw;
  // Back from the password: to the keypad on the phone, to Touch ID on the computer.
  const back = methods?.passcode && (narrow || !methods.webauthn) ? "Use your passcode instead" : methods?.webauthn ? "Use Touch ID instead" : "";

  return (
    <Door ref={door} screen="lock" isIn={!!entered} className={pad ? "has-pad" : undefined} dots={{ dim: true }}>
      {entered ? (
        <After entered={entered} />
      ) : (
        <>
          <p className="dr-locked">Locked</p>
          <p className="dr-clock">{timeLabel(now)}</p>
          {methods && (
            <div className="dr-card dr-lockcard">
              {pins && (
                <div className="dr-pins" role="status" aria-label={`${digits.length} of ${LENGTH} digits entered`}>
                  {Array.from({ length: LENGTH }, (_, i) => (
                    <i key={i} className={i < digits.length ? "on" : undefined} />
                  ))}
                </div>
              )}
              {pad && (
                <div className="dr-keys">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                    <button key={d} type="button" className="dr-key" onClick={() => push(d)} disabled={busy}>
                      {d}
                    </button>
                  ))}
                  <span />
                  <button type="button" className="dr-key" onClick={() => push("0")} disabled={busy}>
                    0
                  </button>
                  <button
                    type="button"
                    className="dr-key dr-del"
                    onClick={() => setDigits(typedDigits.current.slice(0, -1))}
                    disabled={busy || digits.length === 0}
                    aria-label="Delete the last digit"
                  >
                    <BackspaceIcon />
                  </button>
                </div>
              )}
              {touch && (
                <Button kind={pad ? "quiet" : "solid"} className={waiting ? "dr-touch wait" : "dr-touch"} onClick={touchId} disabled={busy}>
                  <FingerprintIcon />
                  Unlock with Touch ID
                </Button>
              )}
              {usePw && (
                <form className="dr-form dr-pwform" onSubmit={submitPassword} noValidate>
                  <PasswordField
                    ref={passRef}
                    value={password}
                    onChange={(v) => {
                      setPassword(v);
                      setError("");
                      door.current?.spark();
                    }}
                    autoComplete="current-password"
                  />
                  <Button kind="solid" type="submit" className="dr-go" disabled={busy}>
                    {busy ? "Unlocking…" : "Unlock"}
                  </Button>
                </form>
              )}
              <DoorError text={error} />
              {usePw ? (
                back && (
                  <button
                    type="button"
                    className="dr-link"
                    onClick={() => {
                      setUsePw(false);
                      setError("");
                    }}
                  >
                    {back}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="dr-link"
                  onClick={() => {
                    setError("");
                    toPassword();
                  }}
                >
                  Use your password instead
                </button>
              )}
            </div>
          )}
        </>
      )}
    </Door>
  );
}
