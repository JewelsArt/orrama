/**
 * Settings → Appearance (structure.md §3.1 #2, §9 #2): the theme per account, plus Match this
 * device, and colour vision (four built-in profiles and your own, with the palette editor).
 *
 * Each colour-vision row previews its own palette: the swatch strip carries data-vision, so
 * vision.css re-declares the colours for that strip alone, and you compare the modes side by
 * side in the theme you use, without switching. A hand-built profile's swatches are its own
 * values instead: that is the whole difference between those and the four built in.
 */
import { useState } from "react";
import { Confirm, type ConfirmRequest } from "../Confirm.js";
import { PALETTE_SLOTS, type VisionProfile } from "../palette.js";
import { Button } from "../ui/controls.js";
import { RadioGroup } from "../ui/fields.js";
import { VisionEditor } from "../VisionEditor.js";
import { SectionHead, SubHead, WhereMark, type SectionMeta } from "./parts.js";

export type ThemeChoice = "light" | "dark" | "match";

const VISIONS = [
  { id: "none", label: "Standard", hint: "The default colours" },
  { id: "deuteranopia", label: "Deuteranopia", hint: "Reduced green sensitivity, the most common form" },
  { id: "protanopia", label: "Protanopia", hint: "Reduced red sensitivity" },
  { id: "tritanopia", label: "Tritanopia", hint: "Reduced blue sensitivity, rare" },
];
/** The five life areas, then the three status colours: everything a profile changes. */
const SWATCHES = ["--c1", "--c2", "--c3", "--c4", "--c5", "--ok", "--warn", "--late"];

/* Which of a hand-built profile's seven fills become the five areas (palette.ts profileVars). */
const AREA_SLOTS = ["pink", "amber", "cyan", "lilac", "green"].map((t) => PALETTE_SLOTS.findIndex((s) => s.token === t));

export function AppearanceSection({
  meta,
  theme,
  onTheme,
  shown,
  vision,
  onVision,
  profiles,
  onProfiles,
}: {
  meta: SectionMeta;
  theme: ThemeChoice;
  onTheme: (t: ThemeChoice) => void;
  /** What the page shows now, light or dark (Match resolves to one). */
  shown: "light" | "dark";
  vision: string;
  onVision: (v: string) => void;
  profiles: VisionProfile[];
  onProfiles: (p: VisionProfile[]) => void;
}) {
  /** The profile being edited; `isNew` decides whether Cancel leaves anything behind. */
  const [editing, setEditing] = useState<{ profile: VisionProfile; isNew: boolean } | null>(null);
  const [ask, setAsk] = useState<ConfirmRequest | null>(null);
  const css = () => getComputedStyle(document.documentElement);

  /* A new profile starts from the palette on screen, not from black: the seven wells are
     pre-filled with whatever the active mode resolves to, so editing is a nudge from something
     that already works rather than a blank canvas. */
  const newProfile = (): VisionProfile => {
    const cs = css();
    return {
      id: `p${Date.now().toString(36)}`,
      name: "My palette",
      colors: PALETTE_SLOTS.map(({ token }) => cs.getPropertyValue(`--v-${token}`).trim() || "#888888"),
      brand: cs.getPropertyValue("--fin-hero-a").trim() || "#6f49ca",
    };
  };

  return (
    <section className="set-sec" aria-label={meta.label}>
      <SectionHead meta={meta} />

      <div>
        <SubHead>Theme</SubHead>
        <div className="set-opts">
          <RadioGroup<ThemeChoice>
            label="Theme"
            value={theme}
            onChange={onTheme}
            options={[
              { id: "light", label: "Light", help: "Warm paper. Every device you sign in on." },
              { id: "dark", label: "Dark", help: "Night blue. Every device you sign in on." },
              {
                id: "match",
                label: (
                  <>
                    Match this device <WhereMark where="device" />
                  </>
                ),
                help: `Follows this device's own light or dark setting; your other devices keep yours. Now ${shown}.`,
              },
            ]}
          />
        </div>
      </div>

      <div>
        <SubHead>Colour vision</SubHead>
        <p className="set-help set-lead">
          Where colour carries meaning (life areas, status, money in and out), these swap the colours for ones that stay
          apart for your eyes. Ground, type and layout stay the same.
        </p>
        <div className="set-opts set-vision" role="radiogroup" aria-label="Colour vision">
          {VISIONS.map((v) => (
            <button key={v.id} type="button" role="radio" aria-checked={vision === v.id} className="set-vrow" onClick={() => onVision(v.id)}>
              <span className={vision === v.id ? "radio on" : "radio"} aria-hidden="true" />
              <span className="set-vtxt">
                <b>{v.label}</b>
                <span>{v.hint}</span>
              </span>
              <span className="set-swatches" data-vision={v.id} aria-hidden="true">
                {SWATCHES.map((c) => (
                  <i key={c} style={{ background: `var(${c})` }} />
                ))}
              </span>
            </button>
          ))}
          {profiles.map((p) => {
            const on = vision === `custom:${p.id}`;
            return (
              <div key={p.id} className="set-vrow-wrap">
                <button type="button" role="radio" aria-checked={on} className="set-vrow" onClick={() => onVision(`custom:${p.id}`)}>
                  <span className={on ? "radio on" : "radio"} aria-hidden="true" />
                  <span className="set-vtxt">
                    <b>{p.name}</b>
                    <span>Your colours</span>
                  </span>
                  <span className="set-swatches" aria-hidden="true">
                    {AREA_SLOTS.map((i) => (
                      <i key={i} style={{ background: p.colors[i] ?? "#888888" }} />
                    ))}
                  </span>
                </button>
                <Button size="sm" kind="quiet" icon="pen" onClick={() => setEditing({ profile: p, isNew: false })} aria-label={`Edit ${p.name}`}>
                  Edit
                </Button>
              </div>
            );
          })}
        </div>
        <div className="set-actions">
          <Button icon="plus" onClick={() => setEditing({ profile: newProfile(), isNew: true })}>
            New profile
          </Button>
        </div>
      </div>

      {editing && (
        <VisionEditor
          profile={editing.profile}
          surface={css().getPropertyValue("--surface").trim()}
          mode={shown}
          heroFallback={css().getPropertyValue("--fin-hero-a").trim()}
          pinned={{
            ok: css().getPropertyValue("--ok").trim(),
            warn: css().getPropertyValue("--warn").trim(),
            danger: css().getPropertyValue("--danger").trim(),
          }}
          onSave={(p) => {
            onProfiles(editing.isNew ? [...profiles, p] : profiles.map((x) => (x.id === p.id ? p : x)));
            onVision(`custom:${p.id}`);
            setEditing(null);
          }}
          onDelete={
            editing.isNew
              ? null
              : (id) =>
                  setAsk({
                    title: `Delete ${editing.profile.name}?`,
                    body: "Its colours are gone for good; the built-in profiles stay.",
                    confirmLabel: "Delete profile",
                    danger: true,
                    onConfirm: () => {
                      onProfiles(profiles.filter((x) => x.id !== id));
                      // Deleting the profile you are wearing has to put something back on,
                      // or every colour stays at its last value.
                      if (vision === `custom:${id}`) onVision("none");
                      setEditing(null);
                    },
                  })
          }
          onClose={() => setEditing(null)}
        />
      )}
      <Confirm request={ask} onClose={() => setAsk(null)} />
    </section>
  );
}
