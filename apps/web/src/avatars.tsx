/**
 * Characters. Every member picks a little stone creature instead of uploading a
 * photo — friendlier than initials, zero storage. Each is a hex column head with
 * its own mineral palette and face; drawn here so they render crisp at any size.
 */

export interface Character {
  id: string;
  name: string;
  bg: string;
  face: string;
  accent: string;
}

export const CHARACTERS: Character[] = [
  { id: "basalt", name: "Basalt", bg: "#3a4150", face: "#e6e9ee", accent: "#22d3ee" },
  { id: "magma", name: "Magma", bg: "#4a2f2a", face: "#ffd9c2", accent: "#fb7185" },
  { id: "moss", name: "Moss", bg: "#2e4034", face: "#d9f2dd", accent: "#34d399" },
  { id: "tide", name: "Tide", bg: "#283a4d", face: "#d4e9f7", accent: "#60a5fa" },
  { id: "ash", name: "Ash", bg: "#42424a", face: "#e3e3e8", accent: "#a1a1aa" },
  { id: "quartz", name: "Quartz", bg: "#463c52", face: "#efe4f5", accent: "#c084fc" },
  { id: "ember", name: "Ember", bg: "#4d3a24", face: "#ffe8c2", accent: "#fbbf24" },
  { id: "fog", name: "Fog", bg: "#374244", face: "#dcebe9", accent: "#7dd3c8" },
];

const FACES: Record<string, (c: Character) => React.ReactNode> = {
  // each character gets its own expression — same skull, different soul
  basalt: (c) => (
    <>
      <circle cx="12.4" cy="15" r="1.6" fill={c.bg} />
      <circle cx="19.6" cy="15" r="1.6" fill={c.bg} />
      <path d="M12.5 20.5 Q16 22.5 19.5 20.5" stroke={c.bg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </>
  ),
  magma: (c) => (
    <>
      <path d="M10.8 14.6 l3-1.2 M21.2 14.6 l-3-1.2" stroke={c.bg} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12.6" cy="16" r="1.4" fill={c.bg} />
      <circle cx="19.4" cy="16" r="1.4" fill={c.bg} />
      <path d="M13 21 h6" stroke={c.bg} strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  moss: (c) => (
    <>
      <path d="M11 15.4 a1.7 1.7 0 0 0 3.2 0 M17.8 15.4 a1.7 1.7 0 0 0 3.2 0" stroke={c.bg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M13 20.6 Q16 23 19 20.6" stroke={c.bg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </>
  ),
  tide: (c) => (
    <>
      <circle cx="12.4" cy="15.4" r="1.9" fill="none" stroke={c.bg} strokeWidth="1.4" />
      <circle cx="19.6" cy="15.4" r="1.9" fill="none" stroke={c.bg} strokeWidth="1.4" />
      <path d="M14.3 15.4 h3.4" stroke={c.bg} strokeWidth="1.4" />
      <path d="M14 20.8 Q16 21.8 18 20.8" stroke={c.bg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </>
  ),
  ash: (c) => (
    <>
      <path d="M11.2 15.2 h2.8 M18 15.2 h2.8" stroke={c.bg} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M13.4 20.6 h5.2" stroke={c.bg} strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  quartz: (c) => (
    <>
      <path d="M11.4 16 l1.6-1.8 1.6 1.8 M17.4 16 l1.6-1.8 1.6 1.8" stroke={c.bg} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="20.6" r="1.3" fill={c.bg} />
    </>
  ),
  ember: (c) => (
    <>
      <circle cx="12.4" cy="15" r="1.5" fill={c.bg} />
      <circle cx="19.6" cy="15" r="1.5" fill={c.bg} />
      <path d="M12.6 20 Q16 23.4 19.4 20 Q16 21.4 12.6 20 Z" fill={c.bg} />
    </>
  ),
  fog: (c) => (
    <>
      <path d="M11.2 15.6 q1.6-1.4 3.2 0 M17.6 15.6 q1.6-1.4 3.2 0" stroke={c.bg} strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M13.6 20.8 h4.8" stroke={c.bg} strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2 2" />
    </>
  ),
};

export function CharacterAvatar({ id, size = 28 }: { id: string; size?: number }) {
  const c = CHARACTERS.find((x) => x.id === id) ?? CHARACTERS[0]!;
  const face = FACES[c.id] ?? FACES["basalt"]!;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label={c.name}>
      {/* hex column head */}
      <path d="M16 2 L27 8.5 V23.5 L16 30 L5 23.5 V8.5 Z" fill={c.bg} />
      <path d="M16 2 L27 8.5 V23.5 L16 30 L5 23.5 V8.5 Z" fill="none" stroke={c.accent} strokeWidth="1.2" strokeOpacity="0.65" />
      {/* facet line */}
      <path d="M16 2 V8.2" stroke={c.accent} strokeWidth="1" strokeOpacity="0.4" />
      <path d="M8.5 10.5 h15 v13 l-7.5 4.4 L8.5 23.5 Z" fill={c.face} fillOpacity="0.92" transform="translate(0,-1.5)" />
      {face(c)}
    </svg>
  );
}
