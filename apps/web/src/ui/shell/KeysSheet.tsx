/** `?`: every key, in one sheet (structure.md §1.5). The keys are not on screen anywhere else. */
import { Kbd } from "../controls.js";
import { KEY_TABLE } from "../keys.js";
import { Sheet } from "../overlays.js";

export function KeysSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Keys" onClose={onClose}>
      <dl className="keys-list">
        {KEY_TABLE.map(([keys, does]) => (
          <div key={keys}>
            <dt>
              {keys.split(/\s{2,}/).map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
