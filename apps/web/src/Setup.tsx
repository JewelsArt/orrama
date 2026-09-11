import { useState } from "react";
import { api, rememberEmail, setToken, type Me } from "./api.js";
import { IconMark } from "./icons.js";

/**
 * First run. Shown when GET /api/auth/status reports an empty install, which is
 * the only time the register endpoint will accept a request without an invite:
 * the first account founds the workspace and owns it.
 *
 * This replaces the demo accounts as the way in. Seeding still exists for people
 * who want the sample vault, but it is no longer the only path to a login.
 */
export function Setup({ onDone }: { onDone: (me: Me) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** Derived, not asked for: it becomes a path segment under Personal/, so the
   *  fewer ways a person can hand-type something surprising, the better. */
  const username = (email.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords do not match.");
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (!username) return setError("That email does not give a usable username.");
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: Me }>("POST", "/api/auth/register", {
        email,
        username,
        displayName: displayName.trim() || (email.split("@")[0] ?? "You"),
        password,
      });
      setToken(res.token);
      rememberEmail(email.toLowerCase());
      onDone(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create the account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="wordmark login-wordmark">
          <IconMark size={24} /> basalt
        </div>
        <p className="login-tagline">Create your account. This is your vault and your server.</p>
        <label>
          Your name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus placeholder="Jules" />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            autoComplete="new-password"
          />
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Creating\u2026" : "Create account"}
        </button>
        <p className="login-hint">
          Stored on this machine only. Nothing is sent anywhere - there is no Basalt account service.
        </p>
      </form>
    </div>
  );
}
