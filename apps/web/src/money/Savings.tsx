/**
 * The savings plan in full (`/money/savings`): where the figure comes from, line by line. A single
 * "you could save €240" is a claim; the same number as surplus plus a per-category gap between a
 * typical month and a good one is an argument, and you can disagree with any one line of it.
 */
import type { FinanceData } from "@basalt/schema/responses";
import { eur, monthName } from "./format.js";
import { link, to } from "./links.js";

export function SavingsPage({ d }: { d: FinanceData }) {
  const s = d.savings;
  if (s.basedOn < 3)
    return (
      <section className="mod" aria-label="Saving">
        <p className="q3">
          Three complete months are needed before a typical month means anything. There {s.basedOn === 1 ? "is" : "are"} {s.basedOn}.
        </p>
      </section>
    );
  // The longest bar is the largest typical month among the rows, so none runs past its box.
  const top = Math.max(1, ...s.headroom.map((h) => Math.max(h.typical, h.good)));

  return (
    <>
      <section className="mod" aria-label="Saving">
        <div className="mh">
          <h2>Saving</h2>
          <span className="c">from {s.basedOn} complete months of your own statement</span>
        </div>
        <div className="mbig">
          <b>{eur(s.target)}</b>
          <span>
            a month is realistic
            {s.targetRate !== null && <> · {s.targetRate}% of what comes in</>}
          </span>
        </div>
        {/* The arithmetic, laid out rather than asserted. */}
        <div className="marith wide">
          <span>
            Average month in
            <em>
              {s.incomeSource === "balance"
                ? "what must have landed for the balance to move as it did"
                : s.incomeSource === "payslips"
                  ? "median payslip"
                  : s.incomeSource === "ledger"
                    ? "the income note"
                    : "nothing on record"}
            </em>
          </span>
          <b>{eur(s.incomeMonthly)}</b>
          {/* Money OUT, not money spent: they differ by every transfer the rules never claimed,
              and this has to be the row the surplus is computed from or the three stop adding up. */}
          <span>
            Average month out<em>everything that left, transfers included, over {s.basedOn} months</em>
          </span>
          <b>−{eur(s.outflowMonthly)}</b>
          <span className="sub">
            Left over<em>{s.incomeSource === "balance" ? "the balance trend itself" : "before changing anything"}</em>
          </span>
          <b className="sub">{eur(s.surplus)}</b>
          <span>
            Proven headroom
            <em>{s.typicalMonth && s.goodMonth ? `${monthName(s.typicalMonth)} against ${monthName(s.goodMonth)}, per category` : "a typical month against a good one, per category"}</em>
          </span>
          <b>+{eur(s.trimmable)}</b>
          <span className="tot">
            Target<em>surplus + headroom</em>
          </span>
          <b className="tot">{eur(s.target)}</b>
        </div>
        {s.observed !== null && (
          <p className="q3">
            Your balance is moving {s.observed >= 0 ? "up" : "down"} by <b>{eur(Math.abs(s.observed))}</b> a month across {s.basedOn} months. That is the bank's own arithmetic, so the target is that figure plus {eur(s.trimmable)} of headroom
            you have already shown you can live inside: {eur(s.target - s.observed)} more a month than you are saving now.
          </p>
        )}
      </section>

      <div className="mlower">
        <section className="mod" aria-label="Where the headroom is">
          <div className="mh">
            <h2>Where the headroom is</h2>
            <span className="c">{eur(s.trimmable)}</span>
          </div>
          {s.typicalMonth && s.goodMonth && (
            <p className="q3">
              {monthName(s.typicalMonth)} against {monthName(s.goodMonth)}: two months you have had, so the rows add up to the total rather than to quantiles of months that never coincided. A negative row is a category the good month spent more on.
            </p>
          )}
          {s.headroom.length === 0 ? (
            <p className="q3">No category varies enough to trim.</p>
          ) : (
            s.headroom.map((h) => (
              <a key={h.category} className="row mheadroom" {...link(to.category(h.category))}>
                <span className="x">
                  <span className="t">{h.category}</span>
                  <span className="m">
                    {eur(h.good)} vs {eur(h.typical)}
                  </span>
                </span>
                {/* Typical is the bar; the good month is the notch. The distance between them IS the saving. */}
                <span className="ui-bar">
                  <i style={{ width: `${(h.typical / top) * 100}%` }} />
                  <u style={{ left: `${(h.good / top) * 100}%` }} />
                </span>
                <span className="r">{eur(h.save)}</span>
              </a>
            ))
          )}
        </section>

        <section className="mod" aria-label="What it buys">
          <div className="mh">
            <h2>What it buys</h2>
          </div>
          <div className="marith wide">
            <span>
              Emergency fund<em>three typical months{s.monthsToFund !== null && ` · ${s.monthsToFund} months away`}</em>
            </span>
            <b>{eur(s.emergencyFund)}</b>
            <span>
              A year at this rate<em>if nothing else changes</em>
            </span>
            <b>{eur(s.target * 12)}</b>
            {/* The typical month's own figures, so the two rows add up to a month that happened (FIN-016). */}
            <span>
              Committed<em>{s.typicalMonth && `in ${monthName(s.typicalMonth)} · `}only a cancellation moves this</em>
            </span>
            <b>{eur(s.committedMonthly)}</b>
            <span>
              Discretionary<em>{s.typicalMonth && `in ${monthName(s.typicalMonth)} · `}where the headroom lives</em>
            </span>
            <b>{eur(s.discretionaryMonthly)}</b>
          </div>
          {d.summary.balance !== null && (
            <p className="q3">
              The account holds {eur(d.summary.balance)}
              {d.summary.drift !== null && `, ${d.summary.drift >= 0 ? "+" : ""}${eur(d.summary.drift)} a month on the account itself`}
              {d.summary.runwayMonths !== null && `; at this pace it lasts ${d.summary.runwayMonths} months`}.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
