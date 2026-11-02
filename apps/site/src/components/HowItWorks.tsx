import { Eyebrow, wrap } from "../ui";

const steps: [string, string][] = [
  [
    "Set the limits",
    "Flow deploys one vault per market (WHSK/USDT and WBTC/USDT) and you fund it. You choose the per-trade, per-day and exposure caps. The owner and guardian keys stay on your own devices, never on the agent's machine.",
  ],
  [
    "Let the agent trade",
    "Flow watches the HSKSwap pools on chain (price, TWAP, recent swaps) and the on-chain oracle price, and lines up candidate trades when the pool drifts from the oracle price. The agent picks one, sizes it down or skips. The vault checks the trade on-chain and swaps on HSKSwap. The output stays in the vault.",
  ],
  [
    "Check the record",
    "Every decision lands in the journal with its reason. Trades carry the reason hash on-chain and an EAS attestation. Stop-loss and take-profit run without asking the model, and you can pause any time.",
  ],
];

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="border-t border-line bg-white pt-26 pb-32 max-sm:py-22">
      <div className={`${wrap} grid grid-cols-[1fr_2fr] items-start gap-16 max-md:grid-cols-[1fr] max-md:gap-8`}>
        <div className="sticky top-[calc(var(--spacing-nav)+40px)] max-md:static">
          <Eyebrow>How it works</Eyebrow>
          <h2 id="how-title" className="display mt-[18px] text-[clamp(52px,1.5rem+4.6vw,112px)]">
            Three steps. Then let it run.
          </h2>
        </div>
        <ol className="grid">
          {steps.map(([title, text], i) => (
            <li
              key={title}
              className="group grid grid-cols-[180px_1fr] gap-7 border-t border-line py-10 last:border-b max-md:grid-cols-[110px_1fr] max-sm:grid-cols-[1fr] max-sm:gap-2.5 max-sm:py-8"
            >
              <span
                aria-hidden="true"
                className="display text-[128px] leading-[0.8] text-yellow/32 transition-[color,-webkit-text-stroke-color] [-webkit-text-stroke:1.5px_rgba(212,169,12,0.55)] group-hover:text-yellow group-hover:[-webkit-text-stroke-color:var(--color-charcoal)] max-md:text-[88px] max-sm:text-[72px]"
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="display text-[40px] max-sm:text-[34px]">{title}</h3>
                <p className="mt-3.5 max-w-[56ch] text-[17px] text-fg-2">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
