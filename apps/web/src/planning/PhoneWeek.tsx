/**
 * The week on a phone (structure.md §2.2, the Planning board's phone frame): it stands up,
 * days down the screen. The days already gone fold into one line that keeps only what is
 * still open from them; Orr marks now on today's line; Orr's proposals carry their Book.
 */
import { dayOf, longMonth, longWeekday } from "../calendarMath.js";
import { Button } from "../ui/controls.js";
import { minutesLabel } from "../ui/dates.js";
import { Orr } from "../ui/orr/Orr.js";
import { DATED_LANE, itemsOn, type Item, type Proposal } from "./model.js";
import { TimeItem } from "./TimeItem.js";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function PhoneWeek({
  days,
  items,
  today,
  now,
  onOpen,
  onBook,
  colorOf,
}: {
  days: string[];
  items: Item[];
  today: string;
  now: Date;
  onOpen: (item: Item, el: HTMLElement) => void;
  onBook: (p: Proposal) => void;
  colorOf: (lane: string) => string | null;
}) {
  // Money stays on the desktop's dated row; the phone keeps to what you do.
  const week = items.filter((i) => i.kind !== "mn" && i.date >= days[0]! && i.date <= days[6]!);
  const gone = days.filter((d) => d < today);
  const open = week.filter((i) => gone.includes(i.date) && i.late);
  const rest = days.filter((d) => d >= today);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const item = (i: Item) => <TimeItem key={i.id} item={i} today={today} nowMin={nowMin} onOpen={onOpen} color={i.lane === DATED_LANE ? null : colorOf(i.lane)} />;

  return (
    <div className="pdays">
      {gone.length > 0 && (
        <div className="pd past">
          <b>
            {gone.length === 1 ? longWeekday(dayOf(gone[0]!)!) : `${WD[dayOf(gone[0]!)!.getDay()]} – ${WD[dayOf(gone[gone.length - 1]!)!.getDay()]}`}
            <span>{open.length ? `${open.length} still open` : "done with"}</span>
          </b>
          {open.map(item)}
        </div>
      )}
      {rest.map((date) => {
        const d = dayOf(date)!;
        const list = itemsOn(week, date);
        const isToday = date === today;
        return (
          <div key={date} className={`pd ${isToday ? "today" : ""}`}>
            {isToday && (
              <>
                <span className="vb" />
                <span className="porr">
                  <Orr pose="hello" size={30} label="Orr, at now" />
                </span>
              </>
            )}
            <b>
              {longWeekday(d)}
              <span>{isToday ? `now ${minutesLabel(nowMin)}` : `${d.getDate()} ${longMonth(d).slice(0, 3)}`}</span>
            </b>
            {list.map((i) =>
              i.kind === "pp" && i.proposal ? (
                <div key={i.id} className="prow">
                  {item(i)}
                  <Button size="sm" onClick={() => onBook(i.proposal!)}>
                    Book
                  </Button>
                </div>
              ) : (
                item(i)
              ),
            )}
            {list.length === 0 && <p className="plan-pd-none">Nothing yet.</p>}
          </div>
        );
      })}
    </div>
  );
}
