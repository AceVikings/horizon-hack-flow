import { useState, type FormEvent } from "react";
import { DocsButton, wrap } from "../ui";
import { downloads } from "../downloads";

const WAITLIST_TO = "hello@flowverse.cloud";

function DownloadButton({ label, href }: { label: string; href: string | null }) {
  const cls =
    "inline-flex h-[68px] items-center rounded-xl bg-charcoal px-9 font-display text-[24px] leading-none text-white uppercase no-underline shadow-[0_20px_40px_-12px_rgba(23,30,25,0.5)] transition-shadow hover:shadow-[0_26px_50px_-14px_rgba(23,30,25,0.55)] max-sm:w-full max-sm:justify-center";
  if (href)
    return (
      <a href={href} className={`${cls} cursor-pointer`} download>
        {label}
      </a>
    );
  return (
    <span role="button" aria-disabled="true" className={`${cls} cursor-default opacity-92`}>
      {label} · coming soon
    </span>
  );
}

/** Waitlist: client-side only. Builds a mailto: link and hands it to the user's mail app. No network, no storage. */
function Waitlist() {
  const [status, setStatus] = useState("");
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = e.currentTarget.elements.namedItem("body") as HTMLInputElement;
    if (!email.checkValidity()) {
      email.reportValidity();
      return;
    }
    const subject = "Flow mainnet waitlist";
    const body = `Please email me at ${email.value.trim()} when Flow is live on mainnet.`;
    window.location.href = `mailto:${WAITLIST_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setStatus("Your email app should open with the note ready to send.");
  };

  return (
    <form
      id="wait"
      action={`mailto:${WAITLIST_TO}`}
      method="get"
      encType="text/plain"
      onSubmit={onSubmit}
      className="mt-14 w-full max-w-[560px] text-left"
    >
      <label htmlFor="wait-email" className="block text-[13px] font-bold tracking-[0.14em] uppercase">
        Hear when mainnet is live
      </label>
      <div className="mt-2.5 flex gap-2.5 rounded-2xl border border-charcoal/12 bg-white p-2 shadow-[0_20px_40px_-18px_rgba(23,30,25,0.4)] max-sm:flex-col">
        <input
          id="wait-email"
          name="body"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          aria-describedby="wait-note"
          className="h-[52px] min-w-0 flex-1 rounded-[10px] border border-charcoal/20 bg-white px-4 text-[16px] placeholder:text-charcoal/50 max-sm:flex-none"
        />
        <input type="hidden" name="subject" value="Flow mainnet waitlist" />
        <button
          type="submit"
          className="display h-[52px] flex-none cursor-pointer rounded-[10px] bg-charcoal px-6 text-[20px] text-yellow transition-[scale] hover:scale-104 motion-reduce:hover:scale-100 max-sm:w-full"
        >
          Notify me
        </button>
      </div>
      <p id="wait-note" className="mt-3 text-[13.5px] text-charcoal/78">
        No sign-up server. This opens your email app with a short note to hello@flowverse.cloud. Nothing is stored or
        tracked on this site.
      </p>
      <p role="status" aria-live="polite" className="mt-1.5 min-h-[1.4em] text-[14px] font-bold">
        {status}
      </p>
    </form>
  );
}

export function Cta() {
  return (
    <section
      id="get"
      aria-labelledby="cta-title"
      className="relative overflow-hidden bg-yellow py-36 text-center text-charcoal max-sm:py-24 [&_:focus-visible]:shadow-[0_0_0_5px_#fff] [&_:focus-visible]:outline-charcoal"
    >
      <div
        aria-hidden="true"
        className="display pointer-events-none absolute inset-0 text-[clamp(150px,24vw,380px)] leading-[0.8] text-nowrap whitespace-nowrap text-charcoal/10 select-none"
      >
        <span className="absolute top-[-0.16em] left-[-0.04em]">Flow.</span>
        <span className="absolute right-[-0.04em] bottom-[-0.2em]">Flow.</span>
      </div>
      <div className={`${wrap} relative flex flex-col items-center`}>
        <h2 id="cta-title" className="display text-[clamp(52px,1rem+7.2vw,128px)]">
          <span className="block text-balance">Let it trade.</span> <span className="block text-balance">Know the worst case.</span>
        </h2>
        <p className="mt-7 max-w-2xl text-[clamp(19px,1rem+0.6vw,24px)] font-medium">
          {downloads.win ? "Flow runs on your computer. Get it for macOS or Windows." : "Flow runs on your computer. Get it for macOS; Windows is coming soon."}
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-x-[18px] gap-y-3.5 max-sm:w-full max-sm:flex-col">
          <DownloadButton label="macOS" href={downloads.mac} />
          <DownloadButton label="Windows" href={downloads.win} />
          <DocsButton onYellow />
        </div>
        <Waitlist />
      </div>
    </section>
  );
}
