/**
 * The door's frame (structure.md §2.14, take B): the dots on a canvas behind, Orr's head in the
 * middle, the screen's own content under it. Sign-in, lock and first run all stand in it.
 * Styles: styles/door.css (classes start with dr-).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { sessionStarted, type Me, type SignedIn } from "../api.js";
import { Field, Input } from "../ui/fields.js";
import { HeadMark } from "../ui/orr/Orr.js";
import { DoorDots, NARROW, type DotsOptions } from "./dots.js";
import { vaultShape } from "./shape.js";

/** Once in, the gathered vault shows for this long, then the app opens (Jules, 10 October). */
export const HOLD_MS = 2000;
/** How long the gather waits for the vault's shape before closing the halo without it. */
const SHAPE_WAIT_MS = 500;

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The phone's door: the halo above, the form below, a keypad on the lock. */
export function useNarrow(): boolean {
  const q = `(max-width: ${NARROW - 1}px)`;
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, [q]);
  return narrow;
}

export function greeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  if (hour < 22) return "Good evening";
  return "Good night";
}

export interface DoorHandle {
  spark(): void;
  think(on: boolean): void;
  /** The form says no: a small shake of the card. */
  shake(): void;
  dots(): DoorDots | null;
}

/** "You're in": what the door says while the vault gathers. */
export interface Entered {
  hi: string;
  sub: string;
}

/**
 * Getting in. The session is the cookie the server just set; the dots gather into the vault's real shape (if the
 * server says it within half a second); after HOLD_MS the app opens. With reduced motion the
 * app opens straight away. Returns `entered` for the door to show and `enter` to call.
 */
export function useEnter(door: React.RefObject<DoorHandle | null>) {
  const [entered, setEntered] = useState<Entered | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const enter = useCallback(
    async (res: SignedIn, sub: string, done: (me: Me) => void) => {
      sessionStarted();
      if (reducedMotion()) return done(res.user);
      const started = performance.now();
      setEntered({ hi: `${greeting(new Date().getHours())}.`, sub });
      const shape = await Promise.race([vaultShape().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), SHAPE_WAIT_MS))]);
      if (!alive.current) return;
      door.current?.dots()?.gather(shape);
      setTimeout(() => alive.current && done(res.user), Math.max(0, HOLD_MS - (performance.now() - started)));
    },
    [door],
  );
  return { entered, enter };
}

/** The frame: canvas, head, content. `in` hides the forms and lets the vault gather. */
export const Door = forwardRef<
  DoorHandle,
  { screen: "signin" | "lock" | "first"; isIn?: boolean; className?: string; dots?: Omit<DotsOptions, "reduce">; children: ReactNode }
>(function Door({ screen, isIn, className, dots: dotOpts, children }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const dots = useRef<DoorDots | null>(null);

  useEffect(() => {
    dots.current = new DoorDots(root.current!, canvas.current!, { ...dotOpts, reduce: reducedMotion() });
    return () => {
      dots.current?.destroy();
      dots.current = null;
    };
    // The dots are made once per screen; their options are the screen's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    (): DoorHandle => ({
      spark: () => dots.current?.spark(),
      think: (on) => dots.current?.think(on),
      shake: () => {
        const el = root.current;
        if (!el || reducedMotion()) return;
        el.classList.remove("shake");
        void el.offsetWidth; // restart the animation
        el.classList.add("shake");
      },
      dots: () => dots.current,
    }),
    [],
  );

  return (
    <div ref={root} className={["door", `door-${screen}`, isIn && "in", className].filter(Boolean).join(" ")}>
      <canvas ref={canvas} className="dr-dots" aria-hidden="true" />
      <main className="dr-mid">
        <div className="dr-head">
          <HeadMark size={104} />
        </div>
        {children}
      </main>
    </div>
  );
});

/** What the door says once you're in, while the vault gathers. */
export function After({ entered }: { entered: Entered }) {
  return (
    <div className="dr-after" aria-live="polite">
      <b className="dr-hi">{entered.hi}</b>
      <p className="dr-sub">{entered.sub}</p>
      <span className="dr-bar" aria-hidden="true">
        <i />
      </span>
    </div>
  );
}

/** The form's own error: a dot and a sentence. Never Orr. */
export function DoorError({ text }: { text: string }) {
  return text ? (
    <p className="dr-err" role="alert">
      {text}
    </p>
  ) : null;
}

/** "Your account and your notes stay on this server." */
export const DoorFoot = () => <p className="dr-foot">Your account and your notes stay on this server. Nothing leaves it unless you connect a service.</p>;

/** A password field with Show. */
export const PasswordField = forwardRef<
  HTMLInputElement,
  { label?: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean; disabled?: boolean }
>(function PasswordField({ label = "Password", value, onChange, autoComplete, autoFocus, disabled }, ref) {
  const [shown, setShown] = useState(false);
  const inner = useRef<HTMLInputElement | null>(null);
  return (
    <Field label={label}>
      <span className="dr-pw">
        <Input
          ref={(el) => {
            inner.current = el;
            if (typeof ref === "function") ref(el);
            else if (ref) ref.current = el;
          }}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          spellCheck={false}
        />
        <button
          type="button"
          className="dr-eye"
          aria-pressed={shown}
          onClick={() => {
            setShown((v) => !v);
            inner.current?.focus();
          }}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </span>
    </Field>
  );
});

/** A plain text field on the door. */
export const DoorField = forwardRef<
  HTMLInputElement,
  { label: string; value: string; onChange: (v: string) => void; type?: string; autoComplete: string; placeholder?: string; autoFocus?: boolean; disabled?: boolean }
>(function DoorField({ label, value, onChange, type = "text", ...rest }, ref) {
  return (
    <Field label={label}>
      <Input ref={ref} type={type} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...rest} />
    </Field>
  );
});

/** Touch ID's mark, from the door's board: the system's line icons have no fingerprint. */
export function FingerprintIcon() {
  return (
    <svg className="dr-fp" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.2 15.5c-.9-1.6-1.4-3.4-1.4-5.4a6.2 6.2 0 0 1 11-3.9" />
      <path d="M16.1 8.6c.2.6.3 1.2.3 1.9 0 2-.4 3.6-1 5" />
      <path d="M7.5 16.4c-.6-1.5-1-3.4-1-6a3.5 3.5 0 0 1 7 0c0 2.4-.3 4.3-.9 5.8" />
      <path d="M10 10.3c0 2.5-.4 4.6-1.1 6.2" />
    </svg>
  );
}

/** The keypad's delete key, from the board. */
export function BackspaceIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 4.5h9.5v11H7L2.5 10z" />
      <path d="m9.5 8 4 4m0-4-4 4" />
    </svg>
  );
}
