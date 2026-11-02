import { wrap } from "../ui";

const mk = "whitespace-nowrap transition-colors hover:text-charcoal";

export function BuiltOn() {
  return (
    <section aria-labelledby="built-title" className="border-b border-line bg-white">
      <div className={`${wrap} flex items-center gap-12 py-9 max-sm:flex-col max-sm:items-start max-sm:gap-5`}>
        <h2 id="built-title" className="flex-none text-[12px] leading-[1.2] font-bold tracking-[0.16em] text-fg-mute uppercase">
          Built on
        </h2>
        <ul className="flex flex-1 flex-wrap items-center justify-between gap-x-10 gap-y-7 text-charcoal/70 max-sm:justify-start max-sm:gap-x-7 max-sm:gap-y-[18px]">
          <li className={`${mk} text-[22px] leading-none font-bold tracking-[-0.02em] max-sm:text-[19px]`}>HashKey Chain</li>
          <li className={`${mk} font-display text-[26px] leading-none tracking-[0.04em] uppercase max-sm:text-[22px]`}>HSKSwap</li>
          <li className={`${mk} text-[24px] leading-none font-medium tracking-[0.22em] lowercase max-sm:text-[20px]`}>Supra</li>
          <li className={`${mk} font-mono text-[24px] leading-none font-bold tracking-[0.08em] max-sm:text-[20px]`}>EAS</li>
          <li className={`${mk} font-serif text-[23px] leading-none font-medium max-sm:text-[20px]`}>
            Claude{" "}
            <span className="ml-1 font-mono text-[15px] leading-none font-bold tracking-[0.04em]">/ MCP</span>
          </li>
        </ul>
      </div>
    </section>
  );
}
