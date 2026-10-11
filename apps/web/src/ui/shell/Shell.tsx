/**
 * Orrama's frame (structure.md §1.1, §1.6), from the Today board's rail and phone tabs.
 *
 * Desktop: a rail on the paper ground with the eight places in order, then the update note
 * (only after a ship), Find, Ask Orr (his head) and your Orr at the foot, which opens
 * Settings → You. Reload, Dark and Back left the rail (§8 #4): ⌘R, Settings and ⌘K, and the
 * browser's own Back, do those now. No keycaps on screen (§8 #5): a place's key is in its
 * tooltip.
 *
 * Phone (≤ 760 px): a top bar (Back when the page is deeper than its tab, the title, Find),
 * and tabs Today · Planning · Ask Orr · Notes · More. More is a sheet: your Orr at the top,
 * then the Orrery, Projects, People, Mail, Money and Settings, so Settings is reachable on
 * the phone (§1.6).
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconName } from "../Icon.js";
import { Avatar, HeadMark } from "../orr/Orr.js";
import { Sheet } from "../overlays.js";
import { goBack, isDeep, navigate, PLACES, placeOf, placeRoute, routeHref, type Place, type Route } from "../router.js";

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
  children: ReactNode;
}

const YOU: Route = { kind: "settings", section: "you" };

export function Shell({ route, title, me, updateReady, askOpen, onFind, onAsk, children }: ShellProps) {
  const here = placeOf(route);
  const [more, setMore] = useState(false);
  useEffect(() => {
    document.title = title ? `${title} · Orrama` : "Orrama";
  }, [title]);
  // Going somewhere from More closes it.
  useEffect(() => setMore(false), [route]);
  const inSettings = route.kind === "settings";
  const deep = isDeep(route);
  const backTo = here ? placeRoute(here) : { kind: "today" as const };
  const MORE: Place[] = ["orrery", "projects", "people", "mail", "money"];

  return (
    <div className="app">
      <nav className="rail ui" aria-label="Places">
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
          </a>
        ))}
        <div className="grow" />
        {updateReady && (
          <button type="button" className="update" onClick={() => location.reload()} data-tip="A new version is ready  ⌘R">
            Update ready<span>Reload</span>
          </button>
        )}
        <button type="button" className="ri" data-tip="Find  ⌘K" onClick={onFind}>
          <Icon name="search" />
          Find
        </button>
        <button type="button" className={askOpen ? "ri on" : "ri"} aria-pressed={askOpen} data-tip="Ask Orr  ⌘J" onClick={onAsk}>
          <HeadMark size={22} />
          Ask Orr
        </button>
        <a
          className={inSettings ? "me on" : "me"}
          href={routeHref(YOU)}
          data-tip={`${me.displayName} · Settings  ⌘,`}
          aria-label={`${me.displayName}: Settings`}
          onClick={follow(YOU)}
        >
          <Avatar name={me.avatar} size={38} />
        </a>
      </nav>

      <div className="frame">
        <header className="ptop ui">
          {deep && (
            <button type="button" className="back" onClick={() => goBack(backTo)} aria-label="Back">
              <Icon name="chev-l" size={22} />
            </button>
          )}
          <h1>{title}</h1>
          <button type="button" className="ib" onClick={onFind} aria-label="Find">
            <Icon name="search" />
          </button>
        </header>
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
