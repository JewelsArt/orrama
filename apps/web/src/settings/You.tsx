/**
 * Settings → You (structure.md §3.1 #1): your name, your Orr, the account's address and its
 * password. The eight Orrs are a small row (§3.3: set once, fun, not at the weight of a form).
 * The email is shown, not changed (one command on the Mac, Jules, 11 October); the password is
 * changed here (1A): this device stays signed in, every other way in ends.
 */
import { useState } from "react";
import { api, ApiError, type Me } from "../api.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";
import { Avatar, AVATAR_NAMES, avatarName } from "../ui/orr/Orr.js";
import { Notice } from "../ui/states.js";
import { SectionHead, SubHead, said, type SectionMeta } from "./parts.js";

export function YouSection({ meta, me, onUpdate }: { meta: SectionMeta; me: Me; onUpdate: (me: Me) => void }) {
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState<string | null>(null);
  const current = avatarName(me.avatar);

  const patch = async (body: { avatar?: string; displayName?: string }) => {
    setBusy(true);
    setError(null);
    try {
      onUpdate(await api<Me>("PATCH", "/api/me", body));
    } catch (e) {
      setError(said(e, "That didn't save. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };
  const changePassword = async () => {
    if (pwBusy) return;
    setPwDone(null);
    if (!oldPw || !newPw) return setPwError("Type your current password and the new one.");
    if (newPw.length < 8) return setPwError("Make the new password at least 8 characters.");
    setPwBusy(true);
    setPwError(null);
    try {
      const r = await api<{ sessions: number; tokens: number; devices: number }>("POST", "/api/auth/password", { current: oldPw, next: newPw });
      setOldPw("");
      setNewPw("");
      setPwDone(r.sessions === 0 ? "Password changed." : `Password changed. ${r.sessions === 1 ? "1 other device was" : `${r.sessions} other devices were`} signed out.`);
    } catch (e) {
      setPwError(e instanceof ApiError && e.status === 403 ? "That isn't your current password." : said(e, "The password wasn't changed. Try again in a moment."));
    } finally {
      setPwBusy(false);
    }
  };
  const nameChanged = name.trim() !== "" && name.trim() !== me.displayName;
  const who = AVATAR_NAMES.find((a) => a.id === current)!;

  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} aside={<Avatar name={me.avatar} size={96} label={`Your Orr: ${who.name}`} />} />

      <form
        className="set-row-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (nameChanged && !busy) void patch({ displayName: name });
        }}
      >
        <Field label="Name" help="How Orrama greets you, and what others see beside your work.">
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </Field>
        <Button type="submit" kind="solid" disabled={busy || !nameChanged}>
          Save
        </Button>
      </form>

      <div>
        <SubHead>Your Orr</SubHead>
        <div className="set-orrs" role="radiogroup" aria-label="Your Orr">
          {AVATAR_NAMES.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={a.id === current}
              className={a.id === current ? "set-orr on" : "set-orr"}
              disabled={busy}
              title={`${a.name}: ${a.prop}`}
              onClick={() => a.id !== current && void patch({ avatar: a.id })}
            >
              <Avatar name={a.id} size={52} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
        <p className="set-help">
          {who.name}, with {who.prop}. Your Orr sits at the foot of the rail and beside your comments.
        </p>
      </div>

      <div>
        <SubHead>Account</SubHead>
        <dl className="set-facts">
          <div>
            <dt>Email</dt>
            <dd>{me.email}</dd>
          </div>
        </dl>
      </div>

      <div>
        <SubHead>Password</SubHead>
        <form
          className="set-pw"
          onSubmit={(e) => {
            e.preventDefault();
            void changePassword();
          }}
          noValidate
        >
          <Field label="Current password">
            <Input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" disabled={pwBusy} />
          </Field>
          <Field label="New password" help="At least 8 characters." error={pwError}>
            <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" disabled={pwBusy} />
          </Field>
          <Button type="submit" kind="solid" disabled={pwBusy || !oldPw || !newPw}>
            {pwBusy ? "Changing…" : "Change password"}
          </Button>
        </form>
        <p className="set-help">
          {pwDone ??
            "This device stays signed in. Every other device is signed out, API tokens and Touch ID are removed, and the passcode and the planning link are turned off."}
        </p>
      </div>

      {error && <Notice title="Not saved" text={error} />}
    </section>
  );
}
