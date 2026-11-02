import { useEffect, useRef, useState } from "react";
import lockup from "../../../../packages/ui/brand/flow-lockup.svg";
import { DOCS, REPO, wrap } from "../ui";

const link = "rounded-[4px] text-[14px] font-medium text-fg no-underline hover:underline hover:underline-offset-4";
const menuLink = "max-md:border-b max-md:border-line max-md:py-3.5 max-md:text-[17px]";

export function Nav() {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header
      id="top"
      className="fixed inset-x-0 top-0 z-50 h-nav border-b border-line bg-white/90 backdrop-blur-md max-md:h-[68px]"
    >
      <div className={`${wrap} flex h-full items-center gap-6 max-md:justify-between`}>
        <a className="block flex-none rounded-md" href="#top" aria-label="Flow, back to top">
          <img src={lockup} alt="Flow" width="116" height="36" className="h-[34px] w-auto" />
        </a>
        <nav
          id="nav-links"
          aria-label="Main"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
          className={`flex flex-1 justify-center gap-9 max-md:absolute max-md:inset-x-0 max-md:top-[68px] max-md:flex-col max-md:gap-0 max-md:border-b max-md:border-line max-md:bg-white max-md:px-[clamp(20px,4vw,48px)] max-md:pt-2 max-md:pb-5 max-md:shadow-[0_20px_30px_-20px_rgba(23,30,25,0.3)] ${
            open ? "" : "max-md:hidden"
          }`}
        >
          <a className={`${link} ${menuLink}`} href="#how">How it works</a>
          <a className={`${link} ${menuLink}`} href="#proof">Proof</a>
          <a className={`${link} ${menuLink}`} href="#use">Use cases</a>
          <a className={`${link} ${menuLink}`} href={DOCS}>Docs</a>
          <a className={`${link} ${menuLink} hidden max-md:block`} href="#get">Download</a>
        </nav>
        <div className="flex items-center gap-[22px] max-md:gap-2.5">
          <a className={`${link} max-md:hidden`} href={REPO}>GitHub</a>
          <a
            className="inline-flex h-11 items-center rounded-full bg-charcoal px-6 text-[14px] font-bold text-white no-underline transition-[translate,box-shadow] hover:-translate-y-px hover:shadow-[0_14px_34px_-14px_rgba(23,30,25,0.28)] motion-reduce:hover:translate-none max-md:h-10 max-md:px-[18px]"
            href="#get"
          >
            Download
          </a>
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls="nav-links"
            onClick={() => setOpen((o) => !o)}
            className="hidden size-11 cursor-pointer items-center justify-center rounded-xl border border-line-2 bg-white max-md:inline-flex"
          >
            <span className="sr-only">Menu</span>
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
              <path d="M3 6h16M3 11h16M3 16h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
