import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

/** One-keystroke capture (`c`): appends to the user's inbox note (spec §6.5). */
export function QuickCapture({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => ref.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return onClose();
    await api("POST", "/api/capture", { text: text.trim() });
    setSaved(true);
    setTimeout(onClose, 450);
  };

  return (
    <div className="overlay" onClick={onClose} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <form className="capture-box" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <span className="capture-icon">{saved ? "✓" : "+"}</span>
        <input
          ref={ref}
          placeholder="Capture a task to your inbox…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Quick capture"
        />
        <kbd>↵</kbd>
      </form>
    </div>
  );
}
