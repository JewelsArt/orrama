import { useCallback, useEffect, useState } from "react";
import { api, lastEmail, setToken, touchIdAvailable, unlockWithTouchId, type Me } from "./api.js";
import { IconMark } from "./icons.js";

const LENGTH = 4;

/**
 * Quick unlock for a device that has signed in before. Two ways in, and a way past.
 *
 * The passcode is NOT checked here - it is posted to /api/auth/unlock and verified
 * against an argon2 hash with a server-side attempt counter. A four-digit secret is
 * 10,000 combinations, so a lock screen that decided the answer in the browser would
 * be decoration. Wrong entries cool down, and ten of them disable the passcode until
 * a real password login.
 *
 * Touch ID is offered only when the platform actually reports a user-verifying
 * authenticator AND the account has one enrolled, so a browser or webview without
 * it simply never sees the button.
 */
export function Lock({ onUnlock, onUsePassword }: { onUnlock: (me: Me) => void; onUsePassword: () => void }) {
  const email = lastEmail();
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [methods, setMethods] = useState<{ passcode: boolean; webauthn: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const opts = await api<{ passcode: boolean; webauthn: boolean }>("POST", "/api/auth/unlock/options", { email });
        const platform = await touchIdAvailable();
        if (alive) setMethods({ passcode: opts.passcode, webauthn: opts.webauthn && platform });
      } catch {
        if (alive) setMethods({ passcode: false, webauthn: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, [email]);

  const submit = useCallback(
    async (code: string) => {
      setBusy(true);
      setError("");
      try {
        const res = await api<{ token: string; user: Me }>("POST", "/api/auth/unlock", { email, passcode: code });
        setToken(res.token);
        onUnlock(res.user);
      } catch (err) {
        setDigits("");
        setError(err instanceof Error ? err.message : "incorrect passcode");
      } finally {
        setBusy(false);
      }
    },
    [email, onUnlock],
  );

  const push = useCallback(
    (d: string) => {
      if (busy) return;
      setDigits((prev) => {
        if (prev.length >= LENGTH) return prev;
        const next = prev + d;
        if (next.length === LENGTH) void submit(next);
        return next;
      });
    },
    [busy, submit],
  );

  // A physical keyboard is the fastest way in on a laptop; the pad is for touch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) push(e.key);
      else if (e.key === "Backspace") setDigits((p) => p.slice(0, -1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [push]);

  const touchId = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await unlockWithTouchId(email);
      setToken(res.token);
      onUnlock(res.user);
    } catch (err) {
      // A cancelled biometric prompt is a normal thing to do, not a failure worth shouting about.
      const msg = err instanceof Error ? err.message : "";
      setError(/NotAllowed|abort/i.test(msg) ? "" : "Touch ID did not work - use your passcode.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card lock-card">
        <div className="wordmark login-wordmark">
          <IconMark size={24} /> basalt
        </div>
        <p className="login-tagline">{email || "Locked"}</p>

        {methods?.passcode !== false && (
          <>
            <div className="lock-dots" aria-label={`${digits.length} of ${LENGTH} digits entered`}>
              {Array.from({ length: LENGTH }, (_, i) => (
                <span key={i} className={i < digits.length ? "lock-dot is-filled" : "lock-dot"} />
              ))}
            </div>
            <div className="lock-pad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} type="button" className="lock-key" onClick={() => push(d)} disabled={busy}>
                  {d}
                </button>
              ))}
              <span />
              <button type="button" className="lock-key" onClick={() => push("0")} disabled={busy}>
                0
              </button>
              <button
                type="button"
                className="lock-key lock-key-soft"
                onClick={() => setDigits((p) => p.slice(0, -1))}
                disabled={busy || digits.length === 0}
                aria-label="Delete last digit"
              >
                &#9003;
              </button>
            </div>
          </>
        )}

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}

        {methods?.webauthn && (
          <button type="button" className="lock-touchid" onClick={touchId} disabled={busy}>
            Unlock with Touch ID
          </button>
        )}

        <button type="button" className="lock-password-link" onClick={onUsePassword}>
          Use password instead
        </button>
      </div>
    </div>
  );
}
