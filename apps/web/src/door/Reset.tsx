/**
 * "Forgot your password?" (2C, Jules 25 Oct 2026: "Reset it on this computer"). In the app, the
 * sign-in's link sends the window to a path the shell catches; the shell asks the server for a
 * one-time ticket with a token only it holds and opens `/reset#ticket=…` (desktop.ts,
 * window.rs). This screen spends the ticket: the email and a new password, then you're in, and
 * every other device is signed out (`POST /api/auth/reset`). Nothing else changes: the notes,
 * the mail account and Orr's AI stay as they are.
 *
 * In a browser elsewhere the sign-in only says to reset on the computer Orrama runs on.
 */
import { useRef, useState } from "react";
import { api, lastEmail, type Me, rememberEmail, type SignedIn } from "../api.js";
import { Button } from "../ui/controls.js";
import { After, Door, DoorError, DoorField, DoorFoot, PasswordField, useEnter, type DoorHandle } from "./Door.js";
import { doorError } from "./voice.js";

export function Reset({ ticket, onDone, onBack }: { ticket: string | null; onDone: (me: Me) => void; onBack: () => void }) {
  const [email, setEmail] = useState(lastEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(ticket ? "" : "Orrama couldn't start the reset. Try again from the sign-in screen.");
  const [busy, setBusy] = useState(false);
  const door = useRef<DoorHandle>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const { entered, enter } = useEnter(door);

  const fail = (text: string, focus: HTMLInputElement | null) => {
    setError(text);
    door.current?.shake();
    focus?.focus();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !ticket) return;
    if (!email.trim() || !password) return fail("Enter your email and a new password.", email.trim() ? passRef.current : emailRef.current);
    if (password.length < 8) return fail("Make the password at least 8 characters.", passRef.current);
    setBusy(true);
    setError("");
    door.current?.think(true);
    try {
      const res = await api<SignedIn>("POST", "/api/auth/reset", { ticket, email: email.trim(), password });
      rememberEmail(email.trim().toLowerCase());
      await enter(res, "Your new password is set.", onDone);
    } catch (err) {
      door.current?.think(false);
      setBusy(false);
      fail(doorError(err, "reset").text, null);
    }
  };

  const typed = (set: (v: string) => void) => (v: string) => {
    set(v);
    setError("");
  };

  return (
    <Door ref={door} screen="signin" isIn={!!entered}>
      {entered ? (
        <After entered={entered} />
      ) : (
        <>
          <div className="dr-card dr-first1">
            <h1 className="dr-h">Choose a new password</h1>
            <p className="dr-p">Your notes, your mail and Orr's settings stay as they are. Every other device is signed out.</p>
            <form className="dr-form" onSubmit={submit} noValidate>
              {ticket && (
                <>
                  <DoorField ref={emailRef} label="Email" type="email" value={email} onChange={typed(setEmail)} autoComplete="username" placeholder="you@example.com" autoFocus={!email} />
                  <PasswordField ref={passRef} label="New password" value={password} onChange={typed(setPassword)} autoComplete="new-password" autoFocus={!!email} />
                </>
              )}
              <DoorError text={error} />
              {ticket && (
                <Button kind="solid" type="submit" className="dr-go" disabled={busy}>
                  {busy ? "Setting it…" : "Set the new password"}
                </Button>
              )}
              <button type="button" className="dr-link" onClick={onBack}>
                Back to sign in
              </button>
            </form>
          </div>
          <DoorFoot />
        </>
      )}
    </Door>
  );
}
