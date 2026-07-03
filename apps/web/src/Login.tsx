import { useState } from "react";
import { api, setToken, type Me } from "./api.js";
import { IconMark } from "./icons.js";

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ token: string; user: Me }>("POST", "/api/auth/login", { email, password });
      setToken(res.token);
      onLogin(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
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
        <p className="login-tagline">Your team's knowledge. Your files. Your server.</p>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="login-hint">
          Demo accounts: jules / erin / mara <code>@basalt.dev</code>, password <code>basalt-demo</code>
        </p>
      </form>
    </div>
  );
}
