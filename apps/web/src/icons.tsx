/** Hand-drawn 16px stroke icons. One family, one weight — no emoji in the chrome. */

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Basalt mark: three interlocking columns, like the causeway. */
export const IconMark = ({ size = 18 }: { size?: number }) => (
  <svg {...base} width={size} height={size} strokeWidth={1.4}>
    <path d="M2.5 5.5 L5.5 4 L5.5 12.5 L2.5 14 Z" />
    <path d="M5.5 4 L8.5 2.5 L8.5 11 L5.5 12.5 Z" fill="currentColor" fillOpacity="0.18" />
    <path d="M8.5 2.5 L11.5 4 L11.5 12.5 L8.5 11 Z" />
    <path d="M11.5 4 L13.5 5 L13.5 13 L11.5 12.5" />
  </svg>
);

export const IconArchitecture = () => (
  <svg {...base}>
    <rect x="2" y="2.5" width="3.4" height="11" rx="0.5" />
    <rect x="6.3" y="4.5" width="3.4" height="9" rx="0.5" />
    <rect x="10.6" y="1.5" width="3.4" height="12" rx="0.5" />
  </svg>
);

export const IconPlanning = () => (
  <svg {...base}>
    <path d="M2 4.5 h7" />
    <path d="M2 8 h10" />
    <path d="M2 11.5 h5" />
    <circle cx="12.5" cy="4.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="14" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9.5" cy="11.5" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

export const IconOverview = () => (
  <svg {...base}>
    <path d="M1.5 9.5 L4.5 9.5 L6 5 L8.5 12.5 L10.5 7.5 L11.5 9.5 L14.5 9.5" />
  </svg>
);

export const IconAdmin = () => (
  <svg {...base}>
    <path d="M8 1.8 L13.5 4 V8 C13.5 11.2 11.2 13.4 8 14.4 C4.8 13.4 2.5 11.2 2.5 8 V4 Z" />
    <path d="M5.8 8 L7.4 9.6 L10.4 6.4" />
  </svg>
);

export const IconSearch = () => (
  <svg {...base}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.3 10.3 L14 14" />
  </svg>
);

export const IconAsk = () => (
  <svg {...base}>
    <path d="M2.5 3.5 h11 v7 h-6 l-3 3 v-3 h-2 Z" />
    <path d="M5.5 7 h5" />
  </svg>
);

export const IconPlus = () => (
  <svg {...base}>
    <path d="M8 3 v10 M3 8 h10" />
  </svg>
);

export const IconX = () => (
  <svg {...base}>
    <path d="M4 4 L12 12 M12 4 L4 12" />
  </svg>
);

export const IconGear = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8 V4 M8 12 V14.2 M14.2 8 H12 M4 8 H1.8 M12.4 3.6 L10.9 5.1 M5.1 10.9 L3.6 12.4 M12.4 12.4 L10.9 10.9 M5.1 5.1 L3.6 3.6" />
  </svg>
);

export const IconSun = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5 V3 M8 13 V14.5 M14.5 8 H13 M3 8 H1.5 M12.6 3.4 l-1 1 M4.4 11.6 l-1 1 M12.6 12.6 l-1-1 M4.4 4.4 l-1-1" />
  </svg>
);

export const IconMoon = () => (
  <svg {...base}>
    <path d="M13 9.5 A5.5 5.5 0 1 1 6.5 3 A4.5 4.5 0 0 0 13 9.5 Z" />
  </svg>
);

export const IconSignOut = () => (
  <svg {...base}>
    <path d="M6.5 2.5 H3 V13.5 H6.5" />
    <path d="M10 5 L13 8 L10 11 M13 8 H6" />
  </svg>
);

export const IconChevron = ({ open = false }: { open?: boolean }) => (
  <svg {...base} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
    <path d="M6 3.5 L10.5 8 L6 12.5" />
  </svg>
);

export const IconLock = () => (
  <svg {...base}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1" />
    <path d="M5.5 7 V5 a2.5 2.5 0 0 1 5 0 V7" />
  </svg>
);

export const IconPromote = () => (
  <svg {...base}>
    <path d="M8 2.5 L13 8 L8 13.5 L3 8 Z" />
  </svg>
);
