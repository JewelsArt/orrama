import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./ui/controls.js";
import { Layer } from "./ui/overlays.js";
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

  const setColor = (i: number, hex: string) =>
    setDraft((d) => ({ ...d, colors: d.colors.map((c, j) => (j === i ? hex : c)) }));
  // A profile saved before this slot existed keeps the card it already had.
  const brand = draft.brand ?? heroFallback;

  /* One row, rendered twice over: the seven categories and, below them, Orrama's
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
    // A sheet in the overlay stack, over Settings: what it asks (Delete's confirm) is a dialog,
    // so it goes over the editor instead of replacing it and losing the edits.
    <Layer kind="sheet" label="Edit colour profile" scrim className="vised" onClose={onClose}>
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
              <Button danger onClick={() => onDelete(draft.id)}>
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="solid" onClick={() => onSave({ ...draft, brand, name: draft.name.trim() || "Custom" })}>
              Save
            </Button>
            <Button kind="quiet" icon="x" onClick={onClose} aria-label="Close" />
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
            {/* Money's own rows, where the categorical colours do their work. */}
            <div className="money vised-money" aria-label="Preview, with sample figures">
              <section className="mod">
                <div className="mh">
                  <h2>Spent in September</h2>
                  <span className="c">day 7 of 30</span>
                  <a className="go" href="#" onClick={(e) => e.preventDefault()}>
                    All spending →
                  </a>
                </div>
                <div className="mbig">
                  <b>{eur(figures.spent)}</b>
                  <span>of a typical {eur(figures.typical)} a month</span>
                </div>
                <div className="mpace">
                  <div className="ui-bar">
                    <i style={{ width: `${(figures.spent / figures.typical) * 100}%` }} />
                    <u style={{ left: "23%" }} />
                  </div>
                </div>
              </section>
              <section className="mod">
                <div className="mh">
                  <h2>This month by category</h2>
                </div>
                {/* Money paints its first five categories --c1…--c5, which the profile sets. */}
                {figures.cats.slice(0, 5).map((c, i) => (
                  <div className="mcat" key={c.name} style={{ ["--cc" as string]: `var(--c${i + 1})` }}>
                    <span className="nm">
                      <i className="sw" />
                      {c.name}
                    </span>
                    <span className="ui-bar">
                      <i style={{ width: `${Math.min(c.last / c.typical, 1) * 100}%` }} />
                    </span>
                    <span className="amt">{eur(c.last)}</span>
                    <span className="vs">typical {eur(c.typical)}</span>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </div>
    </Layer>
  );
}
