import type { ReactNode } from "react";
import { AppMock } from "./AppMock";
import { AppleIcon, WindowsIcon } from "./icons";
import { DocsButton, Hl, wrap } from "../ui";

const stats = [
  { label: "Per trade", value: "$100" },
  { label: "Per day, per vault", value: "$250" },
  { label: "Held per vault", value: "$150" },
];

function SoonButton({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span
      role="button"
      aria-disabled="true"
      title="Coming soon"
      className="inline-flex h-16 cursor-default items-center gap-3 rounded-xl border-2 border-charcoal bg-yellow px-8 font-display text-[22px] leading-none text-charcoal uppercase no-underline opacity-92 shadow-[5px_5px_0_var(--color-charcoal)] transition-[translate,box-shadow] hover:shadow-[4px_4px_0_var(--color-charcoal)] active:shadow-[4px_4px_0_var(--color-charcoal)] max-sm:justify-center"
    >
      {icon} {label}{" "}
      <small className="ml-1 font-sans text-[13px] leading-none font-semibold tracking-normal normal-case opacity-75">
        Coming soon
      </small>
    </span>
  );
}

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="ate-grid-bg relative overflow-hidden border-b border-line pt-[calc(var(--spacing-nav)+72px)] pb-24 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:z-0 after:h-[45%] after:bg-linear-to-b after:from-transparent after:to-white after:to-70% max-md:pt-[140px] max-sm:pt-[112px] max-sm:pb-16"
    >
      <div className={`${wrap} relative z-1 flex flex-col items-center text-center`}>
        <p className="inline-flex items-center gap-2 text-[15px] leading-[1.3] font-medium text-fg-2 max-sm:text-[14px]">
          <span
            aria-hidden="true"
            className="size-2 rounded-full bg-yellow shadow-[0_0_0_1px_rgba(23,30,25,0.35)] animate-blink"
          />
          Running on HashKey Chain testnet
        </p>
        <h1 id="hero-title" className="display mt-[30px] text-[clamp(54px,0.5rem+8vw,124px)] leading-[0.92]">
          <span className="block text-balance">Let your agent trade.</span>{" "}
          <span className="block text-balance">
            Cap what it can <Hl>lose.</Hl>
          </span>
        </h1>
        <p className="mt-[30px] max-w-xl text-[19px] leading-[1.55] text-charcoal/72 max-sm:text-[17px]">
          Flow lets an AI agent trade on HSKSwap by itself. Your money sits in a vault contract that checks every trade,
          so a bad prompt or a stolen key can't cost more than the limits you set.
        </p>
        <div className="mt-[38px] flex flex-wrap items-center justify-center gap-x-[18px] gap-y-3.5 max-sm:w-full max-sm:flex-col max-sm:items-stretch">
          <SoonButton icon={<AppleIcon />} label="macOS" />
          <SoonButton icon={<WindowsIcon />} label="Windows" />
          <DocsButton />
        </div>
        <p className="mt-[18px] text-[14px] text-fg-mute">
          Desktop apps for macOS and Windows are coming soon. Testnet today, mainnet next.
        </p>

        <dl className="mt-16 grid w-full max-w-[980px] grid-cols-[repeat(4,1fr)] overflow-hidden rounded-2xl border border-line-2 bg-white max-sm:mt-12 max-sm:grid-cols-[repeat(2,1fr)]">
          {stats.map((s, i) => (
            <div
              key={s.label}
              className={`border-line px-6 py-[22px] text-left max-sm:p-4 ${i === 0 ? "" : "border-l"} ${
                i === 2 ? "max-sm:border-l-0" : ""
              } ${i >= 2 ? "max-sm:border-t" : ""}`}
            >
              <dt className="text-[12px] font-bold tracking-[0.12em] text-fg-mute uppercase">{s.label}</dt>
              <dd className="mt-2.5 font-display text-[44px] leading-[0.9] max-sm:text-[36px]">{s.value}</dd>
            </div>
          ))}
          <div className="border-l border-line bg-charcoal px-6 py-[22px] text-left text-white max-sm:border-t max-sm:p-4">
            <dt className="text-[12px] font-bold tracking-[0.12em] text-sage uppercase">Max loss / day</dt>
            <dd className="mt-2.5 font-display text-[44px] leading-[0.9] text-yellow max-sm:text-[36px]">≤ $51.50</dd>
          </div>
        </dl>
        <p className="mt-3.5 max-w-[980px] text-[13px] text-fg-mute max-sm:text-left">
          Default limits, enforced on-chain. The $51.50 bound is for both vaults together and covers every trade path
          while the Supra price feed is live. Price moves on what the vault holds are handled by the stop-loss, not the
          contract.
        </p>
      </div>

      <div className={`${wrap} relative z-1`}>
        <AppMock />
      </div>
    </section>
  );
}
