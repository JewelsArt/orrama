/**
 * Settings → This device (structure.md §3.1 #6): the 4-digit passcode and Touch ID. Both are
 * conveniences over an account that already exists: the password stays the credential and the
 * only way out of a passcode lockout, so neither control can lock anyone out. Removing a Touch
 * ID device asks first (WEB-017): that device needs the password next time.
 */
import { useCallback, useEffect, useState } from "react";
import { api, enrolTouchId, touchIdAvailable, type Me } from "../api.js";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { Button } from "../ui/controls.js";
import { Field, Input } from "../ui/fields.js";
import { toast } from "../ui/overlays.js";
import { dateLabel } from "../ui/dates.js";
import { SectionHead, StateLine, SubHead, said, type SectionMeta } from "./parts.js";

interface Passkey {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export function DeviceSection({ meta, me }: { meta: SectionMeta; me: Me }) {
  const [passcode, setPasscode] = useState("");
  const [hasPasscode, setHasPasscode] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touch, setTouch] = useState(false);
  const [devices, setDevices] = useState<Passkey[]>([]);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);

  const loadState = useCallback(async () => {
    try {
      const r = await api<{ passcode: boolean; webauthn: boolean }>("POST", "/api/auth/unlock/options", { email: me.email });
      setHasPasscode(r.passcode);
    } catch {
      setHasPasscode(null);
    }
  }, [me.email]);
  const loadDevices = useCallback(async () => {
    try {
      setDevices(await api<Passkey[]>("GET", "/api/auth/webauthn/credentials"));
    } catch {
      setDevices([]);
    }
  }, []);
  useEffect(() => {
    void touchIdAvailable().then(setTouch);
    void loadState();
    void loadDevices();
  }, [loadState, loadDevices]);

  const save = async () => {
    setError(null);
    if (!/^\d{4}$/.test(passcode)) return setError("Four digits, please.");
    try {
      await api("POST", "/api/auth/passcode", { passcode });
      setPasscode("");
      toast(hasPasscode ? "Passcode changed." : "Passcode set.");
      await loadState();
    } catch (e) {
      setError(said(e, "The passcode didn't save."));
    }
  };
  const removePasscode = async () => {
    try {
      await api("DELETE", "/api/auth/passcode");
      toast("Passcode removed. You'll be asked for your password.");
      await loadState();
    } catch (e) {
      toast(said(e, "The passcode couldn't be removed."));
    }
  };
  const enrol = async () => {
    try {
      await enrolTouchId("This Mac");
      await loadDevices();
      toast("Touch ID is on.");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Cancelling the system prompt is a normal choice, not an error to report.
      if (!/NotAllowed|abort/i.test(msg)) toast("Touch ID couldn't be turned on for this device.");
    }
  };
  const revoke = (d: Passkey) =>
    setAsk({
      title: `Remove ${d.label}?`,
      body: "Touch ID stops unlocking Orrama there; it asks for the passcode or password instead.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: () =>
        void api("DELETE", `/api/auth/webauthn/credentials/${d.id}`)
          .then(loadDevices)
          .catch((e) => toast(said(e, "That device couldn't be removed."))),
    });

  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />

      <div>
        <SubHead>Passcode</SubHead>
        {hasPasscode !== null && (
          <StateLine
            tone={hasPasscode ? "ok" : "off"}
            title={hasPasscode ? "Passcode on" : "No passcode"}
            detail={hasPasscode ? "four digits unlock Orrama" : "Orrama asks for your password"}
            action={
              hasPasscode ? (
                <Button size="sm" onClick={() => void removePasscode()}>
                  Remove
                </Button>
              ) : undefined
            }
          />
        )}
        <form
          className="set-pinform"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field label={hasPasscode ? "New passcode" : "Passcode"} error={error} help="Five wrong tries wait a minute; ten turn it off until you sign in with your password.">
            <div className="set-keyrow set-pinrow">
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={passcode}
                placeholder="••••"
                autoComplete="off"
                className="set-pin"
                onChange={(e) => setPasscode(e.target.value.replace(/\D/g, "").slice(0, 4))}
              />
              <Button type="submit" kind="solid" disabled={passcode.length !== 4}>
                {hasPasscode ? "Change" : "Set"}
              </Button>
            </div>
          </Field>
        </form>
      </div>

      <div>
        <SubHead>Touch ID</SubHead>
        {devices.map((d) => (
          <div key={d.id} className="set-item">
            <span className="set-dot ok" aria-hidden="true" />
            <span className="set-item-x">
              <b>{d.label}</b>
              <small>
                added {dateLabel(d.createdAt)}
                {d.lastUsedAt ? ` · used ${dateLabel(d.lastUsedAt)}` : ""}
              </small>
            </span>
            <Button size="sm" kind="quiet" icon="trash" danger aria-label={`Remove ${d.label}`} tip="Remove" onClick={() => revoke(d)} />
          </div>
        ))}
        {touch ? (
          <div className="set-actions">
            <Button onClick={() => void enrol()}>{devices.length ? "Add this device" : "Turn on Touch ID"}</Button>
          </div>
        ) : (
          <p className="set-help">This device doesn't offer Touch ID to the browser, so the passcode is the quick way in.</p>
        )}
      </div>
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
