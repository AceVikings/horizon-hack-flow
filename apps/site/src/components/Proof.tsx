import type { ReactNode } from "react";
import { Eyebrow, Hl, JUDGE, SecTitle, wrap } from "../ui";

const EXPLORER = "https://testnet-explorer.hskchain.net";
const tx = (h: string) => `${EXPLORER}/tx/${h}`;
const VAULT_HSK = "0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2";
const VAULT_BTC = "0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693";

type Row = { href: string; label: ReactNode; code: string };

function Card({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <article className={`flex flex-col gap-4 rounded-[18px] border border-sage/14 bg-dark p-7 max-sm:px-[18px] max-sm:py-[22px] ${wide ? "col-span-2 max-sm:col-span-1" : ""}`}>
      <header className="flex items-center justify-between gap-3">
        <h3 className="display text-[30px] max-sm:text-[26px]">{title}</h3>
        <span className="flex-none rounded-full border border-yellow/50 px-2.5 py-1 text-[11px] font-bold tracking-[0.12em] text-yellow uppercase">
          Testnet
        </span>
      </header>
      {children}
    </article>
  );
}

function Links({ rows, cols = "", errors = false, ordered = false }: { rows: Row[]; cols?: string; errors?: boolean; ordered?: boolean }) {
  const List = ordered ? "ol" : "ul";
  return (
    <List className={`grid gap-2 ${cols}`}>
      {rows.map((r) => (
        <li key={r.href}>
          <a
            href={r.href}
            className="flex min-h-[52px] items-center justify-between gap-3 rounded-xl border border-sage/12 bg-sage/6 px-4 py-2.5 text-[15px] font-medium text-white no-underline transition-[border-color,background-color,translate] after:ml-0.5 after:font-bold after:text-yellow after:content-['↗'] hover:-translate-y-px hover:border-yellow hover:bg-yellow/8 motion-reduce:hover:translate-none"
          >
            <span>{r.label}</span>
            <code className={`ml-auto text-[13px] whitespace-nowrap ${errors ? "text-bad-dark" : "text-sage"}`}>{r.code}</code>
          </a>
        </li>
      ))}
    </List>
  );
}

const note = "text-[14px] text-sage";
const noteLink = "text-yellow underline underline-offset-3";

export function Proof() {
  return (
    <section
      id="proof"
      aria-labelledby="proof-title"
      className="bg-charcoal bg-[linear-gradient(to_right,#b7c6c214_1px,transparent_1px),linear-gradient(to_bottom,#b7c6c214_1px,transparent_1px)] bg-size-[var(--spacing-grid)_var(--spacing-grid)] py-32 text-white [--fg-2:var(--color-sage)] [--focus:var(--color-yellow)] [--line:var(--ate-line-dark)] max-sm:py-22"
    >
      <div className={wrap}>
        <Eyebrow>Proof, not promises</Eyebrow>
        <SecTitle id="proof-title">
          It already ran on <Hl className="ml-[0.14em] text-charcoal before:top-[-0.04em]">testnet.</Hl>
        </SecTitle>
        <p className="mt-9 max-w-[62ch] text-[18px] text-sage">
          These are real transactions on HashKey Chain testnet (chain 133) with test tokens, from 2 Nov 2026. Nobody else
          trades the test pools, so we moved two pool prices with our own swaps to create a gap; rows that depend on that
          say “staged”. Mainnet is next.
        </p>

        <div className="mt-14 grid grid-cols-[repeat(2,1fr)] gap-5 max-sm:grid-cols-[1fr]">
          <Card title="The two vaults">
            <Links
              rows={[
                { href: `${EXPLORER}/address/${VAULT_HSK}?tab=contract`, label: "Vault-HSK · WHSK/USDT", code: "0xF80A…Bcd2" },
                { href: `${EXPLORER}/address/${VAULT_BTC}?tab=contract`, label: "Vault-BTC · WBTC/USDT", code: "0x6Da0…6693" },
              ]}
            />
            <p className={note}>
              Same source on both, verified on Sourcify (
              <a className={noteLink} href={`https://repo.sourcify.dev/133/${VAULT_HSK}`}>HSK</a>,{" "}
              <a className={noteLink} href={`https://repo.sourcify.dev/133/${VAULT_BTC}`}>BTC</a>).{" "}
              <code className="text-white">limits()</code> reads $100 / $250 / $150.
            </p>
          </Card>

          <Card title="A trade the AI decided">
            <Links
              rows={[
                { href: tx("0x4ff2ad5176975fed3b45e5242894cce949b68b626051e82ec3d270474fde9c0d"), label: "WBTC buy, $25 (staged gap)", code: "0x4ff2…9c0d" },
                { href: tx("0x1f042937320537b9e3b749d327eb2648613aeb1c6319a476f48341bba0a798f8"), label: "EAS attestation for it", code: "0x1f04…98f8" },
                { href: tx("0xfb0a8f69cbab91888e03d5f33cfe9139be8a3ead5bc70e081498d6840081695b"), label: "Closing sell, +70.11 bps", code: "0xfb0a…695b" },
              ]}
            />
            <p className={note}>The trade event carries the journal record hash; the attestation repeats it.</p>
          </Card>

          <Card title="Attacks with the agent key" wide>
            <Links
              errors
              cols="grid-cols-[repeat(3,1fr)] max-lg:grid-cols-[repeat(2,1fr)] max-sm:grid-cols-[1fr]"
              rows={[
                { href: tx("0x7213dfc80d876804e3232bc572b2ecc99faae25f75e4457da71b8616ca091e24"), label: "$5,000 buy", code: "TradeCap" },
                { href: tx("0x39f56ce9b6e78e866ee74200d4cc87093f037098e842dbb5a2a6de5351f68856"), label: "Buy past the $150 cap", code: "Exposure" },
                { href: tx("0x0677fb8896195c736201374805876d0aa0122b0ea57ecdf08b5f78f40b531558"), label: "“Take any price”", code: "Slippage" },
                { href: tx("0xf3e465a59deb84b297f6e9a8c56eb6420e7b0a831fb2e22fe0056d8f549bcb04"), label: "Attacker's token", code: "PairNotAllowed" },
                { href: tx("0x6f5d929c9591a028c811eb7f841cc77bf435619f799b344f8ff4881cfb139a8c"), label: "Withdraw everything", code: "NotOwner" },
                { href: tx("0x83f807a8f22886a881e5d461156c9e415676b03c832b55baa0c51b202b737410"), label: "Raise its own limits", code: "NotOwner" },
              ]}
            />
            <p className={note}>Each link opens a failed transaction from the agent key, with the decoded error.</p>
          </Card>

          <Card title="Kill switch" wide>
            <Links
              ordered
              cols="grid-cols-[repeat(3,1fr)] max-[740px]:grid-cols-[1fr]"
              rows={[
                ["0xaba62b83fd096241a703c4f4ced8b7a7eb4a3e9101a127c71c60e1c11c4a221a", "Guardian pauses", "0xaba6…221a"],
                ["0x62f96834dfa5ff64bb0ddd378c56f2a42d5b83b96d951f7a0803ca6029b31a8b", "Agent trade refused", "VaultPaused"],
                ["0x530bafc2456b50dd35ee58359f02b1c4b8e44c9719f154caff7e599680f9e949", "Owner unpauses", "0x530b…9949"],
              ].map(([h, label, code], i) => ({
                href: tx(h!),
                code: code!,
                label: (
                  <>
                    <span className="font-bold text-yellow">{i + 1} · </span>
                    {label}
                  </>
                ),
              }))}
            />
          </Card>
        </div>
        <p className="mt-9">
          <a href={JUDGE} className="text-[17px] font-bold text-yellow underline underline-offset-5">
            Every testnet link, with what to look for <span aria-hidden="true">→</span>
          </a>
        </p>
      </div>
    </section>
  );
}
