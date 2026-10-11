import { useRef, useState } from "react";
import { api, rememberEmail, type Me } from "./api.js";
import { After, Door, DoorError, DoorField, DoorFoot, PasswordField, useEnter, type DoorHandle } from "./door/Door.js";
import { doorError } from "./door/voice.js";
import { Button } from "./ui/controls.js";

/**
 * Sign-in (structure.md §2.14, take B): Orr's head, Orrama, the promise, email and password.
 * Nothing of the vault shows before the server says yes; then the dots gather into it and the
 * app opens by itself. Rate limits and sessions are the server's (routes/auth.ts), unchanged.
 */
export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const door = useRef<DoorHandle>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const { entered, enter } = useEnter(door);

  const fail = (text: string, focus: HTMLInputElement | null) => {
    setError(text);
    door.current?.shake();
    focus?.focus();
    focus?.select();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!email.trim() || !password) return fail("Enter your email and your password.", email.trim() ? passRef.current : emailRef.current);
    setBusy(true);
    setError("");
    door.current?.think(true);
    try {
      const res = await api<{ token: string; user: Me }>("POST", "/api/auth/login", { email: email.trim(), password });
      rememberEmail(email.trim().toLowerCase());
      await enter(res, "Your notes are all here.", onLogin);
    } catch (err) {
      door.current?.think(false);
      setBusy(false);
      fail(doorError(err, "signin").text, passRef.current);
    }
  };

  const typed = (set: (v: string) => void) => (v: string) => {
    set(v);
    setError("");
    door.current?.spark();
  };

  return (
    <Door ref={door} screen="signin" isIn={!!entered}>
      {entered ? (
        <After entered={entered} />
      ) : (
        <>
          <h1 className="dr-word">Orrama</h1>
          <p className="dr-tag">Your knowledge. Your files. Your server.</p>
          <form className="dr-card dr-form" onSubmit={submit} noValidate>
            <DoorField
              ref={emailRef}
              label="Email"
              type="email"
              value={email}
              onChange={typed(setEmail)}
              autoComplete="username"
              placeholder="you@example.com"
              autoFocus
            />
            <PasswordField ref={passRef} value={password} onChange={typed(setPassword)} autoComplete="current-password" />
            <DoorError text={error} />
            <Button kind="solid" type="submit" className="dr-go" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <DoorFoot />
        </>
      )}
    </Door>
  );
}
