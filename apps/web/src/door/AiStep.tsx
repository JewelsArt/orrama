/**
 * First run, step 3 (2C): Orr's AI, after the account and the notes, before the gather. Three
 * ways: Sign in with ChatGPT, Use a key, or Later ("Orr stays off; nothing is sent anywhere").
 * The form is Settings → Orr & AI's own (`useAiForm` and `AiFields`, settings/Ai.tsx), in the
 * door's cards; whatever is chosen here can be changed there.
 *
 * ChatGPT: in the app the sign-in runs in the system browser and this step waits for it, then
 * moves on by itself. A key is checked with its provider before it is saved.
 */
import { useEffect, useState } from "react";
import { AiFields, DEFAULT_MODEL, useAiForm } from "../settings/Ai.js";
import { said } from "../settings/parts.js";
import { Button } from "../ui/controls.js";

type Way = "chatgpt" | "key" | "later";

export function AiStep({ onDone }: { onDone: () => void }) {
  const form = useAiForm({ start: "chatgpt" });
  const [way, setWay] = useState<Way>("chatgpt");
  const [busy, setBusy] = useState(false);
  const { cfg } = form;

  // The sign-in in the browser landed: on to the gather.
  useEffect(() => {
    if (form.signedIn) onDone();
  }, [form.signedIn, onDone]);

  const choose = (w: Way) => {
    setWay(w);
    form.setError(null);
    if (w === "chatgpt" || w === "key") form.setKind(w);
    if (w === "key" && !form.model.trim()) form.setModel(DEFAULT_MODEL[form.company]);
  };

  const go = async () => {
    if (busy) return;
    if (way === "later") return onDone();
    if (way === "chatgpt") {
      if (form.connected) return onDone();
      return void form.signIn();
    }
    setBusy(true);
    form.setError(null);
    try {
      await form.saveConfig();
      onDone();
    } catch (e) {
      setBusy(false);
      form.setError(said(e, "That key wasn't saved. Try again in a moment."));
    }
  };

  const option = (id: Way, title: string, detail: string) => (
    <button key={id} type="button" role="radio" aria-checked={way === id} className={way === id ? "dr-ch-opt on" : "dr-ch-opt"} disabled={busy || form.waiting} onClick={() => choose(id)}>
      <b>{title}</b>
      <span>{detail}</span>
    </button>
  );

  if (cfg === undefined) return null;
  if (cfg === null)
    return (
      <div className="dr-ch">
        <p className="dr-err" role="alert">
          Orrama couldn't load this step. You can set Orr up later in Settings.
        </p>
        <div className="dr-ch-acts">
          <Button kind="solid" className="dr-go" onClick={onDone}>
            Continue
          </Button>
        </div>
      </div>
    );

  const label =
    way === "later" ? "Continue" : way === "chatgpt" ? (form.connected ? "Continue" : "Continue with ChatGPT") : busy ? "Checking the key…" : "Check the key and continue";
  const ready = way !== "key" || (!!form.model.trim() && form.apiKey.trim().length >= 10);

  return (
    <form
      className="dr-ch dr-ai"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void go();
      }}
      noValidate
    >
      <div className="dr-ch-opts" role="radiogroup" aria-label="How Orr thinks">
        {option("chatgpt", "Sign in with ChatGPT", form.connected ? "Signed in. Orr uses your ChatGPT plan." : "Use your ChatGPT Plus or Pro plan. You sign in on OpenAI's page, in your browser.")}
        {option("key", "Use a key", "A key from Anthropic or Google. You pay them for what Orr asks.")}
        {option("later", "Later", "Orr stays off, and nothing is sent anywhere. Set him up in Settings when you like.")}
      </div>
      {way !== "later" && <AiFields form={form} place="first" />}
      {form.error && (
        <p className="dr-err" role="alert">
          {form.error}
        </p>
      )}
      {!form.waiting && (
        <div className="dr-ch-acts">
          <Button kind="solid" type="submit" className="dr-go" disabled={busy || !ready}>
            {label}
          </Button>
        </div>
      )}
    </form>
  );
}
