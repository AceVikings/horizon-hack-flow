import type { ReactNode } from "react";
import { Eyebrow, Hl, SecTitle, wrap } from "../ui";

type Tone = "light" | "soft" | "dark";
const tones: Record<Tone, string> = {
  light: "bg-white border-line",
  soft: "bg-surface border-line",
  dark: "bg-charcoal text-white border-charcoal",
};

function Cell({ tone = "light", wide = false, className = "", children }: { tone?: Tone; wide?: boolean; className?: string; children: ReactNode }) {
  return (
    <article
      className={`relative flex flex-col gap-3 overflow-hidden rounded-[20px] border p-8 transition-[translate,box-shadow] hover:-translate-y-1 hover:shadow-[0_24px_48px_-24px_rgba(23,30,25,0.35)] motion-reduce:hover:translate-none max-sm:p-6 max-sm:[&>:last-child]:mt-4 ${
        wide ? "col-span-2 max-sm:col-span-1" : ""
      } ${tones[tone]} ${className}`}
    >
      {children}
    </article>
  );
}

const cellTitle = "display text-[34px] leading-[0.95] max-sm:text-[30px]";
function Text({ dark = false, children }: { dark?: boolean; children: ReactNode }) {
  return <p className={`max-w-[44ch] text-[16px] ${dark ? "text-sage" : "text-fg-2"}`}>{children}</p>;
}

const attacks: [string, string, string][] = [
  ["execute", "$5,000 buy", "TradeCap"],
  ["execute", "buy past $150 held", "Exposure"],
  ["execute", "minAmountOut = 1", "Slippage"],
  ["execute", "attacker's token", "PairNotAllowed"],
  ["withdraw", "all tUSDT to attacker", "NotOwner"],
  ["setLimits", "maxTrade = $1,000,000", "NotOwner"],
];

const journal: [string, string, string, string][] = [
  ["trade", "WBTC", "Buy $25, net edge +68.9 bps", "tx · EAS"],
  ["no_trade", "WBTC", "No signal, skipped", "journal"],
  ["veto", "HSK", "Agent turned down a stale buy", "journal"],
  ["trade", "WBTC", "Closed the lot, +70.11 bps", "tx · EAS"],
];
const kind: Record<string, string> = {
  trade: "bg-ok/10 text-ok",
  veto: "bg-yellow/55 text-umber",
  no_trade: "bg-bg-3 text-fg-2",
};
const jrow = "grid grid-cols-[110px_80px_1fr_90px] items-center gap-3 border-line px-4 py-2.5 max-sm:grid-cols-[82px_1fr] max-sm:gap-x-2.5 max-sm:gap-y-1 max-sm:px-3.5";
const jhide = "max-sm:hidden";

export function Bento() {
  return (
    <section id="features" aria-labelledby="bento-title" className="bg-white pt-32 pb-26 max-sm:py-22">
      <div className={wrap}>
        <Eyebrow>What you get</Eyebrow>
        <SecTitle id="bento-title">
          Autonomy with a <Hl>ceiling.</Hl>
        </SecTitle>
        <div className="mt-14 grid auto-rows-[400px] grid-cols-[repeat(3,1fr)] gap-5 max-lg:auto-rows-[minmax(360px,auto)] max-lg:grid-cols-[repeat(2,1fr)] max-sm:auto-rows-auto max-sm:grid-cols-[1fr] max-sm:gap-4">
          <Cell tone="dark" wide>
            <h3 className={cellTitle}>A stolen key can't drain it</h3>
            <Text dark>We took the real agent key and tried to break the vault. Every attack reverted on-chain with a named error.</Text>
            <div
              role="img"
              aria-label="Six attacks sent with the agent key, each reverted: TradeCap, Exposure, Slippage, PairNotAllowed, NotOwner, NotOwner"
              className="mt-auto overflow-hidden rounded-xl border border-sage/14 bg-ink font-mono text-[13.5px] leading-[1.5] max-sm:text-[12px]"
            >
              <div aria-hidden="true" className="flex justify-between border-b border-sage/12 px-4 py-2.5 text-sage">
                <span>agent key → Vault-HSK</span>
                <span className="text-yellow">Testnet</span>
              </div>
              <ol aria-hidden="true" className="py-2">
                {attacks.map(([fn, what, err], i) => (
                  <li key={i} className="grid grid-cols-[92px_1fr_auto] gap-3.5 px-4 py-1 text-[#d6dedb] max-sm:grid-cols-[1fr_auto] max-sm:gap-x-2.5 max-sm:gap-y-0.5 max-sm:px-3.5 max-sm:py-1.5">
                    <span className="text-sage opacity-80 max-sm:hidden">{fn}</span>
                    <span>{what}</span>
                    <b className="font-semibold text-bad-dark">✕ {err}</b>
                  </li>
                ))}
              </ol>
            </div>
          </Cell>

          <Cell tone="soft" className="justify-between">
            <h3 className={cellTitle}>Know the worst day</h3>
            <p className="display mt-auto text-[clamp(64px,2rem+4vw,96px)] leading-none">
              <Hl>≤ $51.50</Hl>
            </p>
            <Text>
              The most bad trades can cost across both vaults in one UTC day, on every path, while the Supra price is
              live. That's $25.75 per vault.
            </Text>
          </Cell>

          <Cell tone="soft">
            <h3 className={cellTitle}>Steer it in plain words</h3>
            <Text>Tell it what you want. Tightening applies at once; loosening asks you first.</Text>
            <div aria-hidden="true" className="mt-auto grid gap-2">
              <Bubble you>Go to cash on HSK, keep the BTC.</Bubble>
              <Bubble chip={<Chip className="bg-ok/10 text-ok">✓</Chip>}>Target assets: BTC only. Guard sold the HSK lot.</Bubble>
              <Bubble you>Trade HSK again.</Bubble>
              <Bubble chip={<Chip className="bg-yellow/50 text-warn">!</Chip>}>Loosening. Confirm on this Mac.</Bubble>
            </div>
          </Cell>

          <Cell wide>
            <h3 className={cellTitle}>Every decision on the record</h3>
            <Text>
              Trades, skips and vetoes go into a hash-chained journal. Each trade puts its reason hash on-chain and gets
              an EAS attestation, so anyone can match what happened to why.
            </Text>
            <div role="table" aria-label="Sample journal rows from the testnet run" className="mt-auto overflow-hidden rounded-xl border border-line text-[14px]">
              <div role="row" className={`${jrow} bg-surface text-[11px] font-bold tracking-[0.12em] text-fg-mute uppercase`}>
                <span role="columnheader">Kind</span>
                <span role="columnheader" className={jhide}>Market</span>
                <span role="columnheader">What happened</span>
                <span role="columnheader" className={`${jhide} font-mono text-[12.5px] leading-[normal] font-normal`}>Proof</span>
              </div>
              {journal.map(([k, m, what, proof], i) => (
                <div role="row" key={i} className={`${jrow} border-t`}>
                  <span role="cell">
                    <em className={`rounded-md px-2 py-0.5 font-mono text-[12.5px] leading-[normal] font-semibold not-italic ${kind[k]}`}>{k}</em>
                  </span>
                  <span role="cell" className={jhide}>{m}</span>
                  <span role="cell">{what}</span>
                  <span role="cell" className={`${jhide} font-mono text-[12.5px] leading-[normal] text-fg-mute`}>{proof}</span>
                </div>
              ))}
            </div>
          </Cell>

          <Cell>
            <h3 className={cellTitle}>Pause from another device</h3>
            <Text>The guardian key lives off the agent's machine. It pauses the vault in one transaction. Only the owner can unpause.</Text>
            <div aria-hidden="true" className="mt-auto flex h-[120px] items-center justify-center gap-4 rounded-[14px] bg-charcoal">
              <span className="relative size-[18px] rounded-[4px] bg-yellow after:absolute after:inset-0 after:animate-ring after:rounded-[4px] after:border-2 after:border-yellow" />
              <span className="display text-[34px] text-yellow">Paused</span>
            </div>
          </Cell>

          <Cell tone="dark">
            <h3 className={cellTitle}>Bring your own agent</h3>
            <Text dark>Flow speaks MCP. Our trader runs on Claude; any MCP agent can use the same tools.</Text>
            <ul aria-label="Works with" className="mt-auto flex flex-wrap gap-2">
              {["Claude Code", "Codex", "opencode", "Any MCP client"].map((t, i) => (
                <li
                  key={t}
                  className={`rounded-full border px-3.5 py-2 text-[14px] ${
                    i === 0 ? "border-yellow bg-yellow font-bold text-charcoal" : "border-sage/25 font-medium text-white"
                  }`}
                >
                  {t}
                </li>
              ))}
            </ul>
          </Cell>

          <Cell tone="soft" className="max-lg:col-span-2 max-sm:col-span-1">
            <h3 className={cellTitle}>Open, and tested</h3>
            <Text>Apache-2.0. The vault contract has 148 tests and fuzzed invariants, and the deployed source is verified on Sourcify.</Text>
            <p className="display mt-auto text-[72px] leading-none">
              148<span className="text-[28px] text-fg-mute"> tests</span>
            </p>
          </Cell>
        </div>
      </div>
    </section>
  );
}

function Chip({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-[9px] py-[3px] text-[11.5px] font-bold whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}

function Bubble({ you = false, chip, children }: { you?: boolean; chip?: ReactNode; children: ReactNode }) {
  return you ? (
    <p className="max-w-[90%] justify-self-end rounded-[14px] rounded-br-[4px] bg-charcoal px-[13px] py-[9px] text-[14px] leading-[1.4] text-white">
      {children}
    </p>
  ) : (
    <p className="flex max-w-[90%] items-center gap-2 justify-self-start rounded-[14px] rounded-bl-[4px] border border-line bg-white px-[13px] py-[9px] text-[14px] leading-[1.4]">
      {chip} {children}
    </p>
  );
}
