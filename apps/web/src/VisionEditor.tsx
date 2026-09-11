import { useEffect, useMemo, useRef, useState } from "react";
import { iconFor } from "./Finance.js";
import { IconX } from "./icons.js";
import { BRAND_SLOT, PALETTE_SLOTS, type VisionProfile, closestPair, contrast, deriveInk, profileVars } from "./palette.js";

/* Sample figures for the preview. Seeded, not Math.random: the numbers must sit
   still while you pick colours — a total that reshuffles on every keystroke
   turns "did that colour improve it?" into a spot-the-difference puzzle. */
function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
const eur = (n: number) => `€${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SAMPLE_NAMES = ["Groceries", "Home", "Transport", "Eating out", "Travel", "Software", "Sport & health"];

function sampleFigures() {
  const rnd = seeded(20260907);
  const cats = SAMPLE_NAMES.map((name) => {
    const last = Math.round(rnd() * 620 + 40) + rnd();
    return { name, last, typical: last * (0.75 + rnd() * 0.5) };
  });
  const spent = cats.reduce((t, c) => t + c.last, 0);
  return { cats, spent, typical: spent * 1.24 };
}

/**
 * Build-your-own palette. The seven fills are the whole input; the ink family
 * they imply is derived (see palette.ts), and status is pinned, so the only way
 * to make the app unreadable here is to pick a colour you cannot see — which the
 * contrast readout next to each swatch tells you before you save.
 */
export function VisionEditor({
  profile,
  surface,
  mode,
  pinned,
  heroFallback,
  onSave,
  onDelete,
  onClose,
}: {
  profile: VisionProfile;
  surface: string;
  mode: "light" | "dark";
  pinned: { ok: string; warn: string; danger: string };
  /** What --fin-hero-a resolves to right now, for profiles with no brand set. */
  heroFallback: string;
  onSave: (p: VisionProfile) => void;
  onDelete: ((id: string) => void) | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<VisionProfile>(profile);
  const figures = useMemo(sampleFigures, []);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => firstField.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setColor = (i: number, hex: string) =>
    setDraft((d) => ({ ...d, colors: d.colors.map((c, j) => (j === i ? hex : c)) }));
  // A profile saved before this slot existed keeps the card it already had.
  const brand = draft.brand ?? heroFallback;

  /* One row, rendered twice over: the seven categories and, below them, Basalt's
     own colour. Same control, different readout — a category's number is "can
     text in this hue be read", the brand's is "can the white on the balance card
     be read", because that card is the one place the colour IS the surface. */
  const row = (
    label: string,
    hint: string,
    hex: string,
    onPick: (v: string) => void,
    ratio: number,
    ratioTitle: string,
  ) => (
    <label className="vised-slot" key={label}>
      <input className="vised-well" type="color" value={hex} onChange={(e) => onPick(e.target.value)} aria-label={`${label} colour`} />
      <span className="vised-slot-txt">
        <strong>{label}</strong>
        <em>{hint}</em>
      </span>
      <input
        className="vised-hex"
        value={hex}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(v)) onPick(v.toLowerCase());
        }}
        aria-label={`${label} hex`}
      />
      <span className={`vised-ratio ${ratio < 4.5 ? "low" : ""}`} title={ratioTitle}>
        {ratio.toFixed(1)}:1
      </span>
    </label>
  );

  /* The preview is the real thing: these are the same custom properties the
     document gets on save, applied to one subtree. Nothing is mocked but the
     numbers, so what you see here is what the app becomes. */
  const vars = useMemo(
    () => profileVars({ ...draft, brand }, surface, mode, pinned) as React.CSSProperties,
    [draft, brand, surface, mode, pinned],
  );

  /* Contrast says whether a colour can be READ; this says whether two of them
     can be TOLD APART, which is the other half of a palette working and the one
     nobody notices until two categories in a legend have merged. */
  const close = useMemo(() => closestPair(draft.colors), [draft.colors]);

  return (
    <div className="vised-backdrop" onClick={onClose}>
      <div className="vised" role="dialog" aria-label="Edit colour profile" onClick={(e) => e.stopPropagation()}>
        <header className="vised-head">
          <input
            ref={firstField}
            className="vised-name"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Profile name"
            aria-label="Profile name"
          />
          <div className="vised-actions">
            {onDelete && (
              <button className="vised-del" onClick={() => onDelete(draft.id)}>Delete</button>
            )}
            <button className="vised-cancel" onClick={onClose}>Cancel</button>
            <button className="vised-save" onClick={() => onSave({ ...draft, brand, name: draft.name.trim() || "Custom" })}>
              Save
            </button>
            <button className="vised-x" onClick={onClose} aria-label="Close">
              <IconX />
            </button>
          </div>
        </header>

        <div className="vised-body">
          <div className="vised-slots">
            <p className="vised-note">
              Seven fills. The text-safe version of each is worked out for you, and money in and out keep the
              colours they have — a palette should not be able to change what red means.
            </p>
            {close.delta < 8 && (
              <p className="vised-warn">
                <strong>{PALETTE_SLOTS[close.a]?.label}</strong> and <strong>{PALETTE_SLOTS[close.b]?.label}</strong> are
                close enough to read as one colour (ΔE {close.delta.toFixed(1)}; the built-in palettes keep 9.6 or
                more). Fine if you never see them side by side — they do meet in the donut and the map.
              </p>
            )}
            {PALETTE_SLOTS.map((slot, i) => {
              const hex = draft.colors[i] ?? "#888888";
              return row(
                slot.label,
                slot.hint,
                hex,
                (v) => setColor(i, v),
                contrast(deriveInk(hex, surface, mode), surface),
                "Contrast of the derived text colour",
              );
            })}
            <span className="vised-sep" />
            {row(
              BRAND_SLOT.label,
              BRAND_SLOT.hint,
              brand,
              (v) => setDraft((d) => ({ ...d, brand: v })),
              contrast(brand, "#ffffff"),
              "Contrast of the white label on the balance card",
            )}
          </div>

          <div className="vised-preview" style={vars}>
            <span className="vised-strip" aria-hidden>
              {PALETTE_SLOTS.map(({ token }) => (
                <i key={token} style={{ background: `var(--v-${token})` }} />
              ))}
            </span>
            <div className="fin vised-fin" aria-label="Preview, with sample figures">
              <div className="fin-card fin-hero">
                <span className="fin-hero-lbl">Spent in September<em>day 7 of 30</em></span>
                <b className="fin-hero-num">{eur(figures.spent)}</b>
                <span className="fin-hero-pace">
                  <i className="track">
                    <i className="fill" style={{ width: "38%" }} />
                    <i className="typical" style={{ left: "55%" }} />
                  </i>
                  <em>typically {eur(figures.typical)} a month</em>
                </span>
                <span className="fin-hero-split">
                  {figures.cats.slice(0, 5).map((c, i) => (
                    <i key={c.name} style={{ width: `${(c.last / figures.spent) * 100}%`, ["--a" as string]: [0.9, 0.66, 0.48, 0.32, 0.2][i] }} />
                  ))}
                </span>
              </div>

              <div className="fin-tops">
                {figures.cats.slice(0, 3).map((c, i) => (
                  <div className="fin-card fin-top-cat" key={c.name} style={{ ["--c" as string]: `var(--v-${PALETTE_SLOTS[i]!.token})` }}>
                    <span className="fin-top-head"><i>{iconFor(c.name)}</i>{c.name}</span>
                    <b>{eur(c.last)}</b>
                    <span className="fin-top-sub">typically {eur(c.typical)}</span>
                    <span className={`fin-top-delta ${c.last > c.typical ? "over" : "under"}`}>
                      {c.last > c.typical ? "▲" : "▼"} {eur(Math.abs(c.last - c.typical))}
                    </span>
                  </div>
                ))}
              </div>

              <div className="fin-rest">
                {figures.cats.map((c, i) => (
                  <div className="fin-chip" key={c.name} style={{ ["--c" as string]: `var(--v-${PALETTE_SLOTS[i]!.token})` }}>
                    <i>{iconFor(c.name)}</i>
                    {c.name}
                    <b>{eur(c.last)}</b>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
