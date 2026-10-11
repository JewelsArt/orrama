/**
 * Settings → You (structure.md §3.1 #1): your name, your Orr, and the account's address. The
 * eight Orrs are a small row (§3.3: set once, fun, not at the weight of a form). Email and
 * password are shown, not changed: that is one command on the Mac (Jules, 11 October).
 */
import { useState } from "react";
import { api, type Me } from "../api.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";
import { Avatar, AVATAR_NAMES, avatarName } from "../ui/orr/Orr.js";
import { Notice } from "../ui/states.js";
import { SectionHead, SubHead, said, type SectionMeta } from "./parts.js";

export function YouSection({ meta, me, onUpdate }: { meta: SectionMeta; me: Me; onUpdate: (me: Me) => void }) {
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [how, setHow] = useState(false);
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
          <div>
            <dt>Password</dt>
            <dd>
              Changed on the Mac that runs Orrama.{" "}
              <button type="button" className="set-how" aria-expanded={how} onClick={() => setHow(!how)}>
                How?
              </button>
            </dd>
          </div>
        </dl>
        {how && (
          <p className="set-help">
            In Terminal, in the Orrama folder, run <code>pnpm --dir apps/server account</code>. It asks for the new
            email or password without showing it, and a new password signs every device out.
          </p>
        )}
      </div>

      {error && <Notice title="Not saved" text={error} />}
    </section>
  );
}
