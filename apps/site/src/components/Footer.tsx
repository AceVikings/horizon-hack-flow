import lockupDark from "../../../../packages/ui/brand/flow-lockup-dark.svg";
import { DOCS, JUDGE, REPO, wrap } from "../ui";

const head = "text-[12px] leading-[1.2] font-bold tracking-[0.16em] text-sage uppercase";
const list = "mt-[18px] grid gap-3 text-[15px]";

export function Footer() {
  return (
    <footer className="ate-dark pt-20 pb-10 [&_a]:text-white [&_a]:no-underline [&_a:hover]:text-yellow [&_a:hover]:underline [&_a:hover]:underline-offset-4">
      <div className={`${wrap} grid grid-cols-[2fr_1fr_1fr] gap-12 max-md:grid-cols-[repeat(2,1fr)] max-sm:grid-cols-[1fr] max-sm:gap-9`}>
        <div className="max-md:col-span-2 max-sm:col-span-1">
          <img src={lockupDark} alt="Flow" width="129" height="40" className="h-[38px] w-auto" />
          <p className="mt-5 max-w-[36ch] text-sage">
            An AI agent trades on HSKSwap by itself. A vault contract on HashKey Chain caps what it can lose.
          </p>
        </div>
        <nav aria-label="Product">
          <h2 className={head}>Product</h2>
          <ul className={list}>
            <li><a href="#how">How it works</a></li>
            <li><a href="#proof">Testnet proof</a></li>
            <li><a href="#get">Download for macOS and Windows</a></li>
          </ul>
        </nav>
        <nav aria-label="Docs">
          <h2 className={head}>Docs</h2>
          <ul className={list}>
            <li><a href={DOCS}>README</a></li>
            <li><a href={`${REPO}/blob/main/SPEC.md`}>Full design (SPEC)</a></li>
            <li><a href={JUDGE}>All testnet links</a></li>
            <li><a href={REPO}>Source on GitHub</a></li>
          </ul>
        </nav>
      </div>
      <div
        className={`${wrap} relative mt-16 flex justify-between gap-8 pt-7 text-[13px] text-sage/85 before:absolute before:inset-x-[clamp(20px,4vw,48px)] before:top-0 before:border-t before:border-(--ate-line-dark-strong) max-sm:flex-col max-sm:gap-3`}
      >
        <p className="max-w-[70ch]">
          Apache-2.0 · Testnet today, mainnet next. Flow doesn't promise profit; the pools are thin. What it gives you is a
          hard, known limit on loss. Not financial advice.
        </p>
        <p>No cookies, no analytics.</p>
      </div>
    </footer>
  );
}
