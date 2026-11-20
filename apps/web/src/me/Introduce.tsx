/**
 * Introduce me (ME): who it's for, how long, which language and what for; Orr writes an
 * introduction from the persona alone and shows it, with Copy and Use in an email. A number the
 * note doesn't hold is said before it goes anywhere. While a generated draft is reviewed, Orr
 * writes from the draft; with no mailbox connected the text is copied instead of sent to Mail.
 */
import { useState } from "react";
import type { PersonaWrite } from "@orrama/schema/responses";
import { api } from "../api.js";
import { Button } from "../ui/controls.js";
import { Dialog } from "../ui/overlays.js";
import { navigate } from "../ui/router.js";
import { useWrite } from "../ui/writes.js";
import { holdForComposer } from "../mail/compose.js";
import { useMe } from "./context.js";
import { copyText } from "./copy.js";
import { Seg } from "./Side.js";

const AUDIENCES = [
  ["recruiter", "Recruiter"],
  ["lecturer", "Lecturer"],
  ["client", "Client"],
  ["colleague", "Colleague"],
  ["other", "Other"],
] as const;
const LENGTHS = [
  ["line", "One line"],
  ["s30", "30 seconds"],
  ["min2", "2 minutes"],
] as const;

export function Introduce({ langs, onClose }: { langs: string[]; onClose: () => void }) {
  const { ai, mail, draftId } = useMe();
  const [who, setWho] = useState<(typeof AUDIENCES)[number][0]>("recruiter");
  const [len, setLen] = useState<(typeof LENGTHS)[number][0]>("s30");
  const [lang, setLang] = useState(langs[0] ?? "EN");
  const [purpose, setPurpose] = useState("");
  const [out, setOut] = useState<PersonaWrite | null>(null);
  const w = useWrite();
  const write = () =>
    void w.run("Orr couldn't write it.", async () => {
      setOut(
        await api<PersonaWrite>("POST", "/api/persona/write", {
          kind: "intro",
          audience: who,
          length: len,
          language: lang,
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          ...(draftId ? { draftId } : {}),
        }),
      );
    });
  return (
    <Dialog
      title="Introduce me"
      onClose={onClose}
      className="me-intro"
      actions={
        out ? (
          <>
            <Button kind={mail ? undefined : "solid"} onClick={() => void copyText(out.text)}>
              Copy
            </Button>
            {mail && (
              <Button
                kind="solid"
                icon="mail"
                onClick={() => {
                  holdForComposer({ subject: "", body: out.text });
                  onClose();
                  navigate("/mail?write=new");
                }}
              >
                Use in an email
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="solid" orr disabled={!ai || w.busy} onClick={write}>
              {w.busy ? "Writing…" : "Write it"}
            </Button>
          </>
        )
      }
    >
      {!ai && (
        <p className="me-err">
          Orr needs AI to write this.{" "}
          <a
            className="me-link"
            href="/settings/ai"
            onClick={(e) => {
              e.preventDefault();
              onClose();
              navigate({ kind: "settings", section: "ai" });
            }}
          >
            Connect AI in Settings
          </a>
        </p>
      )}
      <h4>For</h4>
      <Seg label="For" value={who} items={AUDIENCES} onChange={setWho} />
      <h4>Length and language</h4>
      <div className="me-segrow">
        <Seg label="Length" value={len} items={LENGTHS} onChange={setLen} />
        <Seg label="Language" value={lang} items={[...new Set([...langs, "EN", "FR"])].map((l) => [l, l] as const)} onChange={setLang} />
      </div>
      <h4>What it's for</h4>
      <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="A cover letter, a networking event…" aria-label="What it's for" />
      {w.error && <p className="me-err">{w.error}</p>}
      {out && (
        <>
          <h4>Orr's introduction</h4>
          <div className="me-draft">{out.text}</div>
          {out.unsourced.length > 0 && (
            <p className="me-err">
              Check before using it: {out.unsourced.join(", ")} {out.unsourced.length === 1 ? "isn't" : "aren't"} in your persona note.
            </p>
          )}
          <button type="button" className="me-again" onClick={write} disabled={w.busy}>
            {w.busy ? "Writing…" : "Write it again"}
          </button>
        </>
      )}
    </Dialog>
  );
}
