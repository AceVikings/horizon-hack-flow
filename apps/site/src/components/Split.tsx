import type { ReactNode } from "react";
import { CheckCircleIcon, CrossIcon } from "./icons";

const oldWay: [string, string][] = [
  ["One bad prompt can spend everything.", "Nothing sits between the model and the wallet."],
  ["A stolen key can withdraw it all.", "The key that trades is the key that owns the money."],
  ["Any price goes through.", "A token allowance doesn't know what a fair price is."],
  ["No record of why.", "After a bad night you have balances, not reasons."],
];
const flowWay: [string, string][] = [
  ["Hard caps on-chain.", "$100 a trade, $250 a day and $150 held, per vault. The agent can't raise them."],
  ["The agent key can't withdraw.", "It can trade inside the limits or pause. Only your owner key moves funds out."],
  ["Bad prices revert.", "Each trade is checked against the Supra oracle price, with one pool and one router fixed at deploy."],
  ["Every decision is written down.", "Trades and skipped trades go in a journal; each trade's reason hash goes on-chain."],
];

const inner = "max-w-[620px] px-[clamp(24px,5vw,72px)]";
const title = "display text-[clamp(48px,1.5rem+4.4vw,96px)]";
const lede = "mt-[18px] text-[20px] font-medium";

function Items({ items, icon, ico, head, body }: { items: [string, string][]; icon: ReactNode; ico: string; head: string; body: string }) {
  return (
    <ul className="mt-11 grid gap-7">
      {items.map(([b, t]) => (
        <li key={b} className="grid grid-cols-[28px_1fr] items-start gap-4 text-[17px] leading-[1.5]">
          <span aria-hidden="true" className={`grid size-7 place-items-center rounded-full ${ico}`}>
            {icon}
          </span>
          <span className={body}>
            <b className={`mb-0.5 block text-[18px] ${head}`}>{b}</b> {t}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Split() {
  return (
    <section aria-label="Without Flow and with Flow" className="grid grid-cols-[repeat(2,1fr)] max-md:grid-cols-[1fr]">
      <div className="bg-charcoal py-28 text-sage max-md:py-20">
        <div className={`${inner} ml-auto max-md:ml-0`}>
          <h2 className={`${title} text-sage/85`}>The old way</h2>
          <p className={`${lede} text-sage`}>Give the agent a hot wallet and hope.</p>
          <Items items={oldWay} icon={<CrossIcon />} ico="bg-bad-dark/12 text-bad-dark" head="text-[#e2e9e7]" body="" />
        </div>
      </div>
      <div className="bg-dark py-28 text-white shadow-[inset_0_0_0_2px_var(--color-yellow)] max-md:py-20 max-md:shadow-none">
        <div className={inner}>
          <h2 className={`${title} text-yellow`}>The Flow way</h2>
          <p className={lede}>Put the money in a vault that checks every trade.</p>
          <Items items={flowWay} icon={<CheckCircleIcon />} ico="text-yellow" head="text-white" body="text-[#d6dedb]" />
        </div>
      </div>
    </section>
  );
}
