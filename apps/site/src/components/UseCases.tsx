import type { ReactNode } from "react";
import { Eyebrow, Hl, SecTitle, wrap } from "../ui";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 3.2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const cases: { icon: ReactNode; text: string; initials: string; who: string }[] = [
  {
    icon: <path d="M13 12l-8 8 8 8M27 12l8 8-8 8M23 8l-6 24" {...stroke} />,
    text: "You built a trading agent and want to leave it running overnight. Connect it to Flow's MCP server. It gets candidates, quotes and an execute tool, and the vault decides what's allowed.",
    initials: "AB",
    who: "Agent builder",
  },
  {
    icon: (
      <>
        <path d="M20 4l13 5v10c0 9-6 14.5-13 17C13 33.5 7 28 7 19V9z" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinejoin="round" />
        <path d="M14 20l4.5 4.5L27 16" {...stroke} />
      </>
    ),
    text: "You want to know the worst case before you fund anything. Set the caps once. A bad prompt or a stolen key can't go past them, and you can pause from another device.",
    initials: "RO",
    who: "Risk-conscious operator",
  },
  {
    icon: (
      <>
        <circle cx="17" cy="17" r="10" fill="none" stroke="currentColor" strokeWidth="3.2" />
        <path d="M25 25l10 10" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" />
      </>
    ),
    text: "You need to check what happened and why. Each trade's ID matches a journal record, its reason hash is in the event, and an EAS attestation ties them together.",
    initials: "AU",
    who: "Auditor",
  },
];

export function UseCases() {
  return (
    <section id="use" aria-labelledby="use-title" className="border-b border-line bg-surface pt-32 pb-38 max-sm:py-22">
      <div className={wrap}>
        <Eyebrow>Use cases</Eyebrow>
        <SecTitle id="use-title">
          What it does <Hl>for you.</Hl>
        </SecTitle>
        <p className="mt-[22px] text-[18px] text-fg-2">Three people Flow is built for. These are use cases, not quotes from customers.</p>
        <div className="mt-14 grid grid-cols-[repeat(3,1fr)] items-start gap-6 max-md:grid-cols-[1fr]">
          {cases.map((c, i) => {
            const mid = i === 1;
            return (
              <article
                key={c.who}
                className={`flex flex-col gap-[22px] rounded-[20px] border p-[34px] transition-[translate,box-shadow] hover:shadow-[0_24px_48px_-24px_rgba(23,30,25,0.3)] max-sm:p-[26px] ${
                  mid ? "translate-y-4 border-charcoal bg-charcoal text-white max-md:translate-none" : "border-line bg-white"
                }`}
              >
                <span aria-hidden="true" className="grid size-14 place-items-center rounded-[14px] bg-yellow text-charcoal">
                  <svg viewBox="0 0 40 40" className="size-8">
                    {c.icon}
                  </svg>
                </span>
                <p className={`text-[18px] leading-[1.55] font-medium ${mid ? "text-[#e8eeec]" : ""}`}>{c.text}</p>
                <footer className={`mt-auto flex items-center gap-3.5 border-t pt-[22px] ${mid ? "border-sage/18" : "border-line"}`}>
                  <span
                    aria-hidden="true"
                    className={`grid size-12 flex-none place-items-center rounded-full font-display text-[18px] leading-none grayscale ${
                      mid ? "bg-[#3a423d] text-[#cfd6d3]" : "bg-[#d3d8d6] text-[#3b423e]"
                    }`}
                  >
                    {c.initials}
                  </span>
                  <span>
                    <b className="display block text-[20px] leading-none">{c.who}</b>
                    <small className={`mt-1 block text-[12px] font-bold tracking-[0.12em] uppercase ${mid ? "text-sage" : "text-fg-mute"}`}>
                      Use case
                    </small>
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
