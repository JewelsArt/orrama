/**
 * Settings → Signed in (structure.md §3.1 #7): every session with its device and last use.
 * Signing one out ends it on the server: its token stops working and its live sync closes.
 * Signing another device out, and signing out everywhere, ask first (WEB-017).
 */
import { useCallback, useEffect, useState } from "react";
import { api, SESSION_ENDED, type SessionInfo } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { toast } from "../ui/overlays.js";
import { dateLabel } from "../ui/dates.js";
import { SectionHead, SubHead, said, type SectionMeta } from "./parts.js";

export function SignedInSection({ meta, onSignOut }: { meta: SectionMeta; onSignOut: () => void }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await api<SessionInfo[]>("GET", "/api/auth/sessions"));
    } catch {
      setSessions([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const end = (s: SessionInfo) =>
    setAsk({
      title: `Sign out ${s.label}?`,
      body: "It's signed out at once, wherever its sign-in was copied, and needs the password to come back.",
      confirmLabel: "Sign out",
      danger: true,
      onConfirm: () =>
        void api("DELETE", `/api/auth/sessions/${s.id}`)
          .then(load)
          .catch((e) => toast(said(e, "That session couldn't be signed out."))),
    });
  /** Everything ends, this browser too, so the app signs out like any ended session. */
  const everywhere = () =>
    setAsk({
      title: "Sign out everywhere?",
      body: "Every device is signed out, this one too, and every API token, Touch ID device, the passcode and the published planning link are removed.",
      confirmLabel: "Sign out everywhere",
      danger: true,
      onConfirm: () =>
        void api("POST", "/api/auth/revoke-all")
          .then(() => window.dispatchEvent(new Event(SESSION_ENDED)))
          .catch((e) => toast(said(e, "Couldn't sign out everywhere."))),
    });

  const seen = (s: SessionInfo) => (s.current ? "now" : s.lastSeenAt ? dateLabel(s.lastSeenAt) : "not since");

  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />
      <div>
        <SubHead>{sessions.length === 1 ? "1 device" : `${sessions.length} devices`}</SubHead>
        {sessions.map((s) => (
          <div key={s.id} className="set-item">
            <span className="set-dot ok" aria-hidden="true" />
            <span className="set-item-x">
              <b>
                {s.label}
                {s.current && <span className="set-this">This device</span>}
              </b>
              <small>
                since {dateLabel(s.createdAt)} · seen {seen(s)}
              </small>
            </span>
            {s.current ? (
              <Button size="sm" onClick={onSignOut}>
                Sign out
              </Button>
            ) : (
              <Button size="sm" danger onClick={() => end(s)} aria-label={`Sign out ${s.label}`}>
                Sign out
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="set-danger">
        <div>
          <b>Sign out everywhere</b>
          <span>Every session, API token and Touch ID device, the passcode and the planning link.</span>
        </div>
        <Button danger onClick={everywhere}>
          Sign out everywhere
        </Button>
      </div>
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
