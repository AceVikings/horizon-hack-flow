import type { ReactNode } from "react";

export const REPO = "https://github.com/AceVikings/horizon-hack-flow";
export const DOCS = `${REPO}#readme`;
export const JUDGE = `${REPO}/blob/main/docs/JUDGE.md`;

/** Page column: 1280px max with fluid side padding. */
export const wrap = "mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,48px)]";

/** Small caps label with the yellow dot. */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`inline-flex items-center gap-2.5 text-[12px] leading-[1.2] font-bold tracking-[0.16em] text-fg-2 uppercase before:size-2 before:rounded-full before:bg-yellow before:shadow-[0_0_0_1px_rgba(23,30,25,0.25)] ${className}`}
    >
      {children}
    </p>
  );
}

/** Section headline (Anton) under an eyebrow. */
export function SecTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="display mt-[18px] max-w-[14ch] text-[clamp(44px,2rem+4.2vw,104px)]">
      {children}
    </h2>
  );
}

/** Yellow slanted highlight bar behind a key word (from @ate/ui). */
export function Hl({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`ate-hl ${className}`}>{children}</span>;
}

/** "Read the docs" outline button. */
export function DocsButton({ onYellow = false }: { onYellow?: boolean }) {
  return (
    <a
      className={`group inline-flex items-center gap-2 rounded-xl border px-[26px] text-[16px] font-bold text-charcoal no-underline transition-colors hover:border-charcoal max-sm:justify-center ${
        onYellow
          ? "h-[68px] border-charcoal/35 bg-transparent hover:bg-white/35 max-sm:w-full"
          : "h-16 border-charcoal/20 bg-white"
      }`}
      href={DOCS}
    >
      Read the docs{" "}
      <span aria-hidden="true" className="transition-transform group-hover:translate-x-[3px]">
        →
      </span>
    </a>
  );
}
