# CLAY: the Clay theme (day, night, two navs, tiles, motion, the wavy switch)

Built to canvas page "4h · Theme: Clay" (approved by Jules 19 Oct 2026), the prompt
`~/orrama-next/build/CLAY-theme.md`, and the spec `~/orrama-redesign/mockups/system/theme-clay.css`,
`gen_theme_clay.py` and `clay-switch.js`. Branch `theme/CLAY-clay-theme` from `sep-2026-redesign`.

## Built
- Appearance is two choices: the look (Paper or Clay, account `appearance.look`, absent = Paper)
  and light or dark (Day, Night, Match this device). `resolveTheme` grows the look; the page's
  data-theme is light | dark | clay | clay-dark; `boot-theme.js` reads `orrama-look` before the
  first frame; one wipe for every theme change keeps the look (d7dee14)
- Clay at night counts as night everywhere: tokens' night blocks, colour-vision profiles, Orr's
  night drawings, /dev/ui; `isNight()`/`modeOf()` in `ui/theme.ts` (617254c)
- Inter, self-hosted beside Figtree, OFL beside it, only clay.css names it (c9098e2)
- `packages/ui/src/clay.css`: tokens day and night, type, the frame, the rail capsule, pills,
  tabs as a track, orange switches, the now block, Orr's wash, status pills (59d2605)
- The two navs: `ui/shell/SectionBar.tsx` (a page wraps its sections once; Paper in place, Clay
  in the shell's top bar via a portal; `useLook()`), the top bar (sections, Find, your Orr pill),
  the sun and moon at the top of Clay's rail (2771bc5)
- The hero card (Money's month, Today's Money), grey tiles (Today, Money, a project), spending
  bars in ink and orange when a category is past its typical month (0550342)
- Today greets you in Clay: "Good morning, Jules" with the date under it (f3d370f)
- Motion under `prefers-reduced-motion: no-preference` only; the hero's figure counts up
  (`ui/CountUp.tsx`, registered integers, real figure kept as text) (070ec57)
- The wavy day ↔ night reveal on `::view-transition-new(root)`, 780 ms (`ui/wavy.ts`) (562eeaf)
- changes/CLAY.md (this file)

## Audit tickets fixed
- None (none were in this prompt).

## Changelog lines (user-facing, for [Unreleased] → Changed / Added / Fixed / Removed)
- Added: Clay, a second look next to Paper (Settings → Appearance → Look): cool grey and burnt
  orange by day, near black after dark, in Inter, with the places on the left and a page's
  sections at the top, a sun and a moon to switch, and motion (none if your device asks for less).
- Changed: Settings → Appearance asks for the look first, then light or dark (Day, Night, Match
  this device). Match this device works for either look.

## CLAUDE.md changes to apply (exact text, and where)
- "Design rules", first paragraph, after "(accounts store dark as `command`, read as an alias).":
  > A second look, **Clay** (19 Oct 2026, canvas page 4h), is `[data-theme="clay"]` by day and
  > `[data-theme="clay-dark"]` at night, all in `packages/ui/src/clay.css` (loaded last, every
  > selector scoped to Clay: `theme.dom.test.ts` holds it). The account keeps the look
  > (`appearance.look`, absent = Paper) apart from light or dark; `ui/theme.ts` turns the two into
  > the page's data-theme, and code that cares about night asks `isNight()`, never `=== "dark"`.
  > Clay is Inter (served beside Figtree; only clay.css names it). A page hands its own sections
  > to the shell by wrapping them in `<SectionBar>` (`ui/shell/SectionBar.tsx`): in place in Paper,
  > in Clay's top bar in Clay. Clay-only markers on a page are plain classes only clay.css styles:
  > `hero` (the page's one big number), `tiles` (lists you open), `ahead` (Money's categories), and
  > `<CountUp>` for a hero figure. Clay's motion lives inside its
  > `prefers-reduced-motion: no-preference` block, nowhere else.
- "Conventions & gotchas", the bullet "**The first frame**", replace its last two sentences
  ("The account keeps light or dark; …" to the end) with:
  > The account keeps light or dark and the look (Paper or Clay); "Match this device" is a
  > per-device key, `orrama-theme-device`, and the look is cached as `orrama-look`. The rail's
  > light ↔ dark button (`ThemeButton`, `ui/shell/Shell.tsx`) in Paper, and the sun and moon at the
  > top of the rail in Clay, call App's `changeTheme("light" | "dark")`, which keeps the look and
  > stops Match this device. Every theme change goes through `wipeTo` (App.tsx): Paper's plain
  > circle (`html.rippling`), Clay's wavy edge (`ui/wavy.ts`, played on
  > `::view-transition-new(root)` with the Web Animations API), nothing with reduced motion.
- Layout table, `apps/web/src/` row, after "`ui/Icon.tsx` (line icons; no glyphs, no emoji),":
  > `ui/shell/SectionBar.tsx` (a page's sections: in place, or in Clay's top bar), `ui/wavy.ts`
  > (Clay's reveal), `ui/CountUp.tsx` (a hero figure that counts up in Clay),

## Board vs app: differences left on purpose
- Money's category bars: the board turns a bar orange when a category runs ahead of "a typical
  month by this day" ("+€20 vs €64 by now"). No per-category figure by day exists, so the app
  turns it orange only once a category has spent more than a whole typical month
  (`aheadOfTypical`). The "by now" comparison needs a server figure first.
- The counting number: the board's CSS counter drew "1520" for €1,520 and would be read twice by
  a screen reader. The app counts thousands and three padded digits separately, keeps the real
  figure as text (the digits' alternative text is empty), and counts from the first thousand.
- The board's per-category "typical by day 8: €964" band on the hero, "Basic-Fit charged…" and
  Mail's drafts are data the scratch vault does not have; the slots are the existing app's.
- Planning's board shows "Lanes · Hours" as a grey track next to the title (kept) and "Day ·
  Week · Month" in the top bar (done). Hours' current event is not drawn as "now" in Paper either;
  left alone.
- Money on the phone keeps the app's own header (New, then the month and the export below):
  the phone board simplified it, and it is the same in Paper.
- Settings has no top bar (as its board): Find and your Orr stay in the rail there.
- Orr's sprite in the top bar is the account's own Orr (the board drew victOrr).

## Not done (and why) / needs Jules
Decisions asked with the question tool at the end of the session (built with the
recommendation meanwhile):
1. Pages with no board: every page but Settings gets Clay's top bar (Find and you, top right);
   only Money, a project, Planning and Projects hand it sections. Should Mail's categories (All,
   Primary, Updates…) move up too? People's search and sector? (Built: they stay in place.)
2. The greeting's hours: morning 5–12, afternoon 12–18, evening otherwise (built), the first word
   of the display name.
3. Paper keeps F3's single button; the sun and moon are Clay's only (built). Give Paper the pair?

## Files touched outside my ownership
- `apps/web/src/Finance.tsx`, `Project.tsx`, `Planning.tsx`, `Overview.tsx`: wrap their sections
  in `<SectionBar>` (a few lines each).
- `apps/web/src/today/modules.tsx`: `tiles` on People today and Coming up, `hero` on Money,
  `<CountUp>` on its figure.
- `apps/web/src/money/Overview.tsx`: `hero`, three `tiles`, `ahead` and `aheadOfTypical`,
  `<CountUp>` on the month's figure.
- `apps/web/src/ProjectOverview.tsx`: a `tiles` prop on `Log` (Decisions), `tiles` on People.
- `apps/web/src/Today.tsx`: the greeting (`useLook`, `me` prop); `App.tsx` passes `me`.
- `apps/web/src/main.tsx`: imports `@orrama/ui/clay.css` last.
- `apps/web/src/ui/ui.css`: `.orrsp` night rule names clay-dark.
- `apps/web/src/ui/dev/Gallery.tsx`: its light ↔ dark switch asks `isNight` and keeps the look.
- `apps/web/src/Settings.tsx` (beyond Appearance: the phone list's summary line), `Settings.dom.test.tsx`,
  `App.dom.test.tsx`, `Today.dom.test.tsx`, `Finance.dom.test.tsx`, `licenses.test.ts`,
  `test/app-harness.tsx` (stub buttons for the look; Today's stub shows who it greets).
- `apps/server/test/server.test.ts`: a row for the look on the account.
- `codebase-graph.md`: regenerated for the new files.

## Verification
- Every commit: `pnpm typecheck --force` and `pnpm test` green, except path-identity's STO-012
  case-only rename, the watcher flake plan.md lists under load (passes alone every time).
- Every behaviour's test sabotage-checked (each commit message lists them).
- Screenshots (WebKit, scripts-style WKWebView probe), board beside app, day and night, desktop
  and phone: `~/basalt-scratch/CLAY/shots/*.png`; the sweep of screens with no board:
  `~/basalt-scratch/CLAY/shots/sheet-*.png`; Paper before and after:
  `~/basalt-scratch/CLAY/shots/paper/` (pixel-identical but for the clock: `clock-only-diff.png`).
- WebKit (macOS 26.6): View Transitions, `animate()` on `::view-transition-new(root)`, `@property`
  and the counters all work; frames of the reveal captured at 200 and 420 ms.
