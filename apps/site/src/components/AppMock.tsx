import mark from "../../../../packages/ui/brand/flow-mark.svg";

const checks: [string, string][] = [
  ["Trade size", "$25 of $100"],
  ["Used today", "$25 of $250"],
  ["Held after trade", "$25 of $150"],
  ["Price vs Supra", "within 250 bps"],
];
const limits: [string, string][] = [
  ["Per trade", "$100"],
  ["Per day", "$250"],
  ["Exposure", "$150"],
  ["Slippage", "250 bps"],
  ["Cooldown", "60 s"],
];
const nav = ["Overview", "Decisions", "Trade", "Positions", "Agents", "Chat"];

const propTitle = "display text-[20px]";

/** Abstract app window: the agent proposes a trade and the vault checks it against the limits. */
export function AppMock() {
  return (
    <figure
      aria-label="Illustration of the Flow desktop app: the agent proposes a trade and the vault checks it against the limits"
      className="mt-20 overflow-hidden rounded-2xl border border-line-2 bg-white shadow-[0_50px_100px_-30px_rgba(23,30,25,0.35),0_1px_2px_rgba(23,30,25,0.06)] max-sm:mt-14"
    >
      <div aria-hidden="true" className="relative flex h-[46px] items-center justify-center border-b border-line bg-surface">
        <span className="absolute left-[18px] flex gap-2">
          <i className="size-3 rounded-full bg-[#ff6159]" />
          <i className="size-3 rounded-full bg-[#ffbd2e]" />
          <i className="size-3 rounded-full bg-[#28c941]" />
        </span>
        <span className="text-[13px] font-bold text-fg-2">Flow · Decisions</span>
        <span className="absolute right-4 rounded-full bg-yellow/45 px-2.5 py-1 text-[11px] font-bold tracking-[0.1em] text-umber uppercase">
          Testnet 133
        </span>
      </div>

      <div
        aria-hidden="true"
        className="grid min-h-[480px] grid-cols-[210px_1fr_270px] text-left max-lg:grid-cols-[180px_1fr_240px] max-md:min-h-0 max-md:grid-cols-[1fr]"
      >
        <aside className="flex flex-col gap-[22px] bg-charcoal px-3.5 py-5 text-sage max-md:hidden">
          <img src={mark} alt="" width="28" height="28" className="rounded-[7px] shadow-[0_0_0_1px_rgba(183,198,194,0.25)]" />
          <ul className="grid gap-1 text-[14px] font-medium">
            {nav.map((n) => (
              <li key={n} className={`px-3 py-[9px] ${n === "Decisions" ? "rounded-lg bg-yellow/14 text-yellow" : "rounded-[9px]"}`}>
                {n}
              </li>
            ))}
          </ul>
          <div className="mt-auto flex items-center gap-2 text-[12px]">
            <span className="size-2 rounded-full bg-ok-dark animate-live" />
            Supra price live
          </div>
        </aside>

        <div className="relative grid place-items-center bg-surface bg-[radial-gradient(rgba(23,30,25,0.12)_1px,transparent_1px)] bg-size-[20px_20px] px-7 py-10 max-sm:px-3.5 max-sm:pt-5 max-sm:pb-14">
          <div className="w-full max-w-[440px] rounded-[14px] border border-line bg-white px-6 py-[22px] shadow-[0_24px_48px_-24px_rgba(23,30,25,0.3)] max-sm:p-[18px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-bold tracking-[0.12em] text-fg-mute uppercase">Agent proposal · Vault-BTC</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-ok/10 px-[9px] py-[3px] text-[11.5px] font-bold whitespace-nowrap text-ok">
                ✓ Passed
              </span>
            </div>
            <div className="mt-3.5 flex items-baseline justify-between text-[40px] max-sm:text-[32px]">
              <span className="display">Buy WBTC</span>
              <span className="display rounded-[4px] bg-yellow px-2 pt-0.5">$25.00</span>
            </div>
            <p className="mt-2.5 text-[14px] text-fg-2">
              Pool sits 132.9 bps under the exchange mid. Net edge after costs: +68.9 bps.
            </p>
            <ul className="mt-4 border-t border-line">
              {checks.map(([k, v]) => (
                <li key={k} className="grid grid-cols-[1fr_auto_22px] items-center gap-3 border-b border-line py-[9px] text-[14px]">
                  <span className="text-fg-2">{k}</span>
                  <b className="font-bold tabular-nums">{v}</b>
                  <i className="text-right font-bold text-ok not-italic">✓</i>
                </li>
              ))}
            </ul>
            <div className="mt-3.5 flex justify-between font-mono text-[12px] leading-[1.4] text-fg-mute max-sm:flex-col max-sm:gap-0.5">
              <span>TradeExecuted · 0x4ff2…9c0d</span>
              <span>EAS ✓</span>
            </div>
          </div>
          <div className="absolute right-[4%] bottom-[3%] flex items-start gap-0.5 animate-drift max-sm:right-[8%] max-sm:bottom-3.5">
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path d="M2 1l13 7-6 1.5L6.5 16z" fill="#171e19" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className="mt-3.5 rounded-full bg-charcoal px-2.5 py-1 text-[12px] font-bold whitespace-nowrap text-yellow">
              Claude · agent
            </span>
          </div>
        </div>

        <aside className="flex flex-col gap-3 border-l border-line p-[22px] max-md:hidden">
          <p className={propTitle}>Limits</p>
          <dl className="grid">
            {limits.map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line py-[7px] text-[14px]">
                <dt className="text-fg-2">{k}</dt>
                <dd className="font-bold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          <p className={`${propTitle} mt-2.5`}>Profile</p>
          <div className="grid grid-cols-[repeat(2,1fr)] rounded-[10px] bg-bg-3 p-[3px] text-center text-[13px] font-bold">
            <span className="rounded-lg bg-white p-1.5 text-fg shadow-[0_1px_3px_rgba(23,30,25,0.15)]">Default</span>
            <span className="rounded-lg p-1.5 text-fg-mute">Demo</span>
          </div>
          <p className={`${propTitle} mt-2.5`}>Keys</p>
          <ul className="grid gap-2 text-[13px] text-fg-2">
            {[
              ["bg-yellow", "Agent: trade, pause"],
              ["bg-charcoal", "Guardian: pause"],
              ["bg-charcoal", "Owner: withdraw, limits"],
            ].map(([sw, t]) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className={`size-4 rounded-[4px] shadow-[inset_0_0_0_1px_rgba(23,30,25,0.2)] ${sw}`} />
                {t}
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <figcaption className="border-t border-line bg-white px-[18px] py-2.5 text-left text-[12px] text-fg-mute">
        Illustration. Numbers from the real testnet WBTC trade on 2 Nov 2026 (staged pool gap).
      </figcaption>
    </figure>
  );
}
