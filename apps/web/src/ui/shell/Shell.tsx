/**
 * Orrama's frame (structure.md §1.1, §1.6), from the Today board's rail and phone tabs.
 *
 * Desktop: a rail on the paper ground with the eight places in order, then the update note
 * (only after a ship), Find, Ask Orr (his head) and your Orr at the foot, which opens
 * Settings → You. Reload and Back left the rail (§8 #4): ⌘R and the browser's own Back do
 * those now. Dark came back (Jules, 13 Oct, F3) as one button above Find; since 19 Oct it is a
 * sun and a moon at the top of the rail in both looks, the lit one the mode you're in (Jules
 * chose Clay's pair for Paper too). No keycaps on screen (§8 #5): a place's key is in its
 * tooltip.
 *
 * Clay (19 Oct 2026, canvas page 4h) draws the same places as the Vertix reel does: the rail is
 * a capsule of round icons with the sun and the moon at its top, and a top bar holds the page's own sections (SectionBar.tsx), Find,
 * and a pill with your Orr and name that opens Settings, so Find and your Orr leave the rail.
 * Settings has no top bar on its board: there they stay in the rail.
 *
 * Phone (≤ 760 px): a top bar (Back when the page is deeper than its tab, the title, Find),
 * and tabs Today · Planning · Ask Orr · Notes · More. More is a sheet: your Orr at the top,
 * then the Orrery, Projects, People, Mail, Money and Settings, so Settings is reachable on
 * the phone (§1.6).
 */
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.js";
import { Avatar, HeadMark } from "../orr/Orr.js";
import type { Look, Shown } from "../theme.js";
import { Sheet } from "../overlays.js";
import { goBack, isDeep, navigate, PLACES, placeOf, placeRoute, routeHref, type Place, type Route } from "../router.js";
import { ShellLookContext } from "./SectionBar.js";

const ICON: Record<Place, IconName> = {
  today: "sunrise",
  planning: "calendar",
  notes: "notes",
  orrery: "orbit",
  projects: "projects",
  people: "people",
  mail: "mail",
  money: "money",
};

const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
/** A link the app follows itself; a ⌘-click still opens a new tab. */
const follow = (to: Route) => (e: MouseEvent) => {
  if (!plainClick(e)) return;
  e.preventDefault();
  navigate(to);
};

export interface ShellProps {
  route: Route;
  /** The page's title on the phone's top bar and in the window title. */
  title: string;
  me: { displayName: string; avatar: string };
  updateReady: boolean;
  askOpen: boolean;
  onFind: () => void;
  onAsk: () => void;
  /** The page's New, beside Find on the phone's top bar; given the button, to hang a menu on. */
  onNew?: (button: HTMLElement) => void;
  /** How many of Orr's drafts wait for you: the rail's Mail dot (Jules, 11 Oct), never unread mail. */
  mailDot?: number;
  /** The theme the page shows, and App's changeTheme: the rail's light ↔ dark button. */
  shown: Shown;
  /** Paper or Clay: Clay draws its own rail and top bar. */
  look?: Look;
  onTheme: (choice: Shown) => void;
  children: ReactNode;
}

const YOU: Route = { kind: "settings", section: "you" };

export function Shell({ route, title, me, updateReady, askOpen, onFind, onAsk, onNew, mailDot = 0, shown, look = "paper", onTheme, children }: ShellProps) {
  const here = placeOf(route);
  const [more, setMore] = useState(false);
  const clay = look === "clay";
  // Clay's top bar: on every page but Settings, whose board keeps Find and you in the rail.
  const topBar = clay && route.kind !== "settings";
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const lookContext = useMemo(() => ({ look, slot: topBar ? slot : null }), [look, topBar, slot]);
  useEffect(() => {
    document.title = title ? `${title} · Orrama` : "Orrama";
  }, [title]);
  // Going somewhere from More closes it.
  useEffect(() => setMore(false), [route]);
  const inSettings = route.kind === "settings";
  const deep = isDeep(route);
  // A Settings section goes back to the list of sections (on the phone, each is its own screen).
  const backTo: Route = here ? placeRoute(here) : route.kind === "settings" && route.section ? { kind: "settings" } : { kind: "today" };
  const MORE: Place[] = ["orrery", "projects", "people", "mail", "money"];

  return (
    <ShellLookContext.Provider value={lookContext}>
    <div className="app">
      <nav className="rail ui" aria-label="Places">
        <DayOrNight shown={shown} onTheme={onTheme} />
        {PLACES.map(({ place, label, key }) => (
          <a
            key={place}
            className={here === place && !inSettings ? "ri on" : "ri"}
            href={routeHref(placeRoute(place))}
            aria-current={here === place && !inSettings ? "page" : undefined}
            data-tip={`${label}  ${key}`}
            onClick={follow(placeRoute(place))}
          >
            <Icon name={ICON[place]} />
            {label}
            {place === "mail" && mailDot > 0 && <span className="dot" role="img" aria-label={`${mailDot} ${mailDot === 1 ? "draft" : "drafts"} waiting`} />}
          </a>
        ))}
        <div className="grow" />
        {updateReady && (
          <button type="button" className="update" onClick={() => location.reload()} data-tip="A new version is ready  ⌘R">
            Update ready<span>Reload</span>
          </button>
        )}
        {!topBar && (
          <button type="button" className="ri" data-tip="Find  ⌘K" onClick={onFind}>
            <Icon name="search" />
            Find
          </button>
        )}
        <button type="button" className="ri" aria-pressed={askOpen} data-tip="Ask Orr  ⌘J" onClick={onAsk}>
          <HeadMark size={22} />
          Ask Orr
        </button>
        {!topBar && (
          <a
            className={inSettings ? "me on" : "me"}
            href={routeHref(YOU)}
            data-tip={`${me.displayName} · Settings  ⌘,`}
            aria-label={`${me.displayName}: Settings`}
            onClick={follow(YOU)}
          >
            <Avatar name={me.avatar} size={38} />
          </a>
        )}
      </nav>

      <div className="frame">
        <header className="ptop ui">
          {deep && (
            <button type="button" className="back" onClick={() => goBack(backTo)} aria-label="Back">
              <Icon name="chev-l" size={22} />
            </button>
          )}
          <h1>{title}</h1>
          {onNew && (
            <button type="button" className="ib" onClick={(e) => onNew(e.currentTarget)} aria-label="New">
              <Icon name="plus" />
            </button>
          )}
          <button type="button" className="ib" onClick={onFind} aria-label="Find">
            <Icon name="search" />
          </button>
        </header>
        {topBar && (
          <div className="ctop ui">
            {/* the page's sections land here (SectionBar) */}
            <div className="ctop-sections" ref={setSlot} />
            <div className="sp" />
            <div className="cright">
              <button type="button" className="btn icon" aria-label="Find" data-tip="Find  ⌘K" onClick={onFind}>
                <Icon name="search" />
              </button>
              <a className="cme" href={routeHref(YOU)} aria-label={`${me.displayName}: Settings`} data-tip="Settings  ⌘," onClick={follow(YOU)}>
                <Avatar name={me.avatar} size={30} />
                <span className="cmn">
                  <b>{me.displayName}</b>
                  <small>Settings</small>
                </span>
                <Icon name="chev-d" size={16} />
              </a>
            </div>
          </div>
        )}
        <main className="main" id="main">
          {children}
        </main>
      </div>

      <nav className="ptabs ui" aria-label="Places">
        {(["today", "planning"] as Place[]).map((p) => (
          <PhoneTab key={p} place={p} on={here === p && !inSettings && !more && !askOpen} />
        ))}
        <button type="button" className={askOpen ? "pt on" : "pt"} aria-pressed={askOpen} onClick={onAsk}>
          <HeadMark size={24} />
          Ask Orr
        </button>
        <PhoneTab place="notes" on={here === "notes" && !inSettings && !more && !askOpen} />
        <button
          type="button"
          className={more || inSettings || (here !== null && MORE.includes(here) && !askOpen) ? "pt on" : "pt"}
          aria-haspopup="dialog"
          aria-expanded={more}
          onClick={() => setMore(true)}
        >
          <Icon name="dots" />
          More
          {updateReady && <span className="dot" aria-label="Update ready" />}
        </button>
      </nav>

      {more && (
        <Sheet title="More" onClose={() => setMore(false)} className="more-sheet">
          <a
            className="more-me"
            href={routeHref(YOU)}
            onClick={follow(YOU)}
          >
            <Avatar name={me.avatar} size={44} />
            <span>
              <b>{me.displayName}</b>
              <small>Your Orr, your account</small>
            </span>
          </a>
          {updateReady && (
            <button type="button" className="update wide" onClick={() => location.reload()}>
              Update ready<span>Reload</span>
            </button>
          )}
          <nav aria-label="More places">
            {MORE.map((p) => {
              const { label } = PLACES.find((x) => x.place === p)!;
              return (
                <a key={p} className={here === p ? "more-row on" : "more-row"} href={routeHref(placeRoute(p))} onClick={follow(placeRoute(p))} aria-current={here === p ? "page" : undefined}>
                  <Icon name={ICON[p]} />
                  {label}
                </a>
              );
            })}
            <a
              className={inSettings ? "more-row on" : "more-row"}
              href={routeHref({ kind: "settings" })}
              onClick={follow({ kind: "settings" })}
            >
              <Icon name="settings" />
              Settings
            </a>
          </nav>
        </Sheet>
      )}
    </div>
    </ShellLookContext.Provider>
  );
}

/**
 * Day and night at the top of the rail, as in the Vertix reel (Clay, 19 Oct; Paper too, Jules's
 * choice the same day): both always there, the lit one is the mode you're in (never drawn like
 * where you are). Picking one sets the account's theme, and this device stops matching its
 * system (App's changeTheme). It replaces F3's single light ↔ dark button.
 */
function DayOrNight({ shown, onTheme }: { shown: Shown; onTheme: (choice: Shown) => void }) {
  return (
    <>
      <div className="cmode" role="group" aria-label="Day or night">
        <button type="button" className="sun" aria-label="Day" aria-pressed={shown === "light"} data-tip="Day" onClick={() => onTheme("light")}>
          <Icon name="sun" />
        </button>
        <button type="button" className="moon" aria-label="Night" aria-pressed={shown === "dark"} data-tip="Night" onClick={() => onTheme("dark")}>
          <Icon name="moon" />
        </button>
      </div>
      <span className="cmode-sep" aria-hidden="true" />
    </>
  );
}

function PhoneTab({ place, on }: { place: Place; on: boolean }) {
  const { label } = PLACES.find((x) => x.place === place)!;
  const to = placeRoute(place);
  return (
    <a className={on ? "pt on" : "pt"} href={routeHref(to)} aria-current={on ? "page" : undefined} onClick={follow(to)}>
      <Icon name={ICON[place]} />
      {label}
    </a>
  );
}
