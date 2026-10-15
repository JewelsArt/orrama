/**
 * To plan (structure.md §2.2, §11 #2): the steps in your notes with time still to book. Beside
 * the hours it is a panel you drag from; in Lanes and Month it is a button that opens it as a
 * sheet (Jules, 11 Oct: as the boards). A step opens its task card, where a day and a time can
 * be typed instead of dragged.
 */
import type { CSSProperties } from "react";
import type { PlanTask } from "@orrama/schema/responses";
import { Tabs } from "../ui/controls.js";
import { Sheet } from "../ui/overlays.js";
import { dueWords, type ToPlanCut } from "./model.js";
import { TASK_MIME, type DraggedStep } from "./Hours.js";

const hours = (h: number) => (Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`);

export interface ToPlanProps {
  cuts: Record<ToPlanCut, PlanTask[]>;
  cut: ToPlanCut;
  onCut: (c: ToPlanCut) => void;
  today: string;
  onOpen: (task: PlanTask, el: HTMLElement) => void;
  colorOf: (noteId: string) => string | null;
  /** Drag onto the hours (only beside them). */
  draggable?: boolean;
}

function ToPlanList({ cuts, cut, onCut, today, onOpen, colorOf, draggable }: ToPlanProps) {
  const list = cuts[cut];
  return (
    <>
      <Tabs
        label="Which steps"
        value={cut}
        onChange={onCut}
        items={[
          { id: "late", label: "Late", count: cuts.late.length },
          { id: "week", label: "This week", count: cuts.week.length },
          { id: "all", label: "All", count: cuts.all.length },
        ]}
      />
      <p className="hint">{draggable ? "Drag one onto the hours, or open it and type a day and a time." : "Open one and type a day and a time, or switch to Hours and drag it in."}</p>
      <div className="tp-list" role="list">
        {list.map((t) => {
          const due = dueWords(t.due, today);
          const color = colorOf(t.noteId);
          return (
            <button
              key={`${t.noteId}:${t.line}`}
              type="button"
              role="listitem"
              className="tk"
              style={color ? ({ "--lane": color } as CSSProperties) : undefined}
              onClick={(e) => onOpen(t, e.currentTarget)}
              draggable={draggable}
              onDragStart={
                draggable
                  ? (e) => {
                      const step: DraggedStep = { noteId: t.noteId, line: t.line, blockId: t.blockId, text: t.text, estimateHours: t.estimateHours, remainingHours: t.remainingHours };
                      e.dataTransfer.setData(TASK_MIME, JSON.stringify(step));
                      e.dataTransfer.effectAllowed = "copy";
                    }
                  : undefined
              }
            >
              <b>{t.text}</b>
              <small>
                {due?.late && <span className="late">{due.text}</span>}
                {[t.project, due && !due.late ? due.text : "", t.atRisk && !due?.late ? "at risk" : ""].filter(Boolean).join(" · ")}
                <span className="r">{hours(t.remainingHours)}</span>
              </small>
            </button>
          );
        })}
        {list.length === 0 && <p className="hint">{cut === "late" ? "Nothing late." : cut === "week" ? "Nothing else due this week." : "Every step has its time."}</p>}
      </div>
    </>
  );
}

/** Beside the hours: always open, and what you drag from. */
export function ToPlanPanel(props: ToPlanProps) {
  return (
    <aside className="tp" aria-label="To plan">
      <div className="tp-h">
        <h2>To plan</h2>
        <span className="c">
          {props.cuts.all.length} open step{props.cuts.all.length === 1 ? "" : "s"} with no time
        </span>
      </div>
      <ToPlanList {...props} draggable />
    </aside>
  );
}

/** From the button in Lanes and Month. */
export function ToPlanSheet({ onClose, ...props }: ToPlanProps & { onClose: () => void }) {
  return (
    <Sheet title="To plan" onClose={onClose} className="plan-tp-sheet">
      <div className="tp">
        <span className="c">
          {props.cuts.all.length} open step{props.cuts.all.length === 1 ? "" : "s"} with no time
        </span>
        <ToPlanList {...props} />
      </div>
    </Sheet>
  );
}
