// Number/time formatting. Never abbreviate a value the user might sign (SPEC §15.3): exact decimals, no k/M.
import { MARKETS, type MarketId } from "@ate/core";

export function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Exact decimal from an integer string with `dp` implied decimals; trims trailing zeros down to `minDp`. */
export function fmtUnits(raw: string | bigint | null | undefined, dp: number, minDp = 2): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  let v = BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  const s = v.toString().padStart(dp + 1, "0");
  const i = s.slice(0, s.length - dp);
  let f = s.slice(s.length - dp);
  while (f.length > minDp && f.endsWith("0")) f = f.slice(0, -1);
  return `${neg ? "−" : ""}${group(i)}${f ? "." + f : ""}`;
}

export const usd = (raw: string | null | undefined, minDp = 2): string => {
  if (raw === null || raw === undefined) return "—";
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  const [i = "0", f = ""] = body.split(".");
  let frac = f;
  while (frac.length < minDp) frac += "0";
  return `${neg ? "−" : ""}$${group(i)}${frac ? "." + frac : ""}`;
};
export const signedUsd = (raw: string | null | undefined): string => (raw && !raw.startsWith("-") && Number(raw) > 0 ? "+" + usd(raw) : usd(raw));
export const px8 = (raw: string | null | undefined, minDp = 2): string => fmtUnits(raw, 8, minDp);
export const usdE8 = (raw: string | null | undefined): string => (raw === null || raw === undefined ? "—" : "$" + fmtUnits(raw, 8, 2));
export const bps = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)} bps`);
export const pctFromBps = (n: number): string => `${(n / 100).toFixed(2)}%`;

export function baseDecimals(m: MarketId): number {
  return MARKETS[m].baseDecimals;
}
export const label = (m: MarketId | string | undefined): string => (m && m in MARKETS ? MARKETS[m as MarketId].label : (m ?? "—"));
export const pair = (m: MarketId): string => `${MARKETS[m].base}/${MARKETS[m].quote}`;

const pad = (n: number) => String(n).padStart(2, "0");
export function clock(at: number): string {
  const d = new Date(at * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function dayKey(at: number): string {
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function dateTime(at: number): string {
  return `${dayKey(at)} ${clock(at)}`;
}
export function dur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}
export function ago(at: number, now = Math.floor(Date.now() / 1000)): string {
  const s = now - at;
  if (s < 90) return `${Math.max(0, s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}
export const short = (h: string, a = 8, b = 6): string => (h.length > a + b + 3 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);

/** Block explorer per chain: 133 = HashKey testnet (Blockscout), 177 = mainnet. Set from /status (`setChain`). */
export const EXPLORERS: Record<number, string> = { 133: "https://testnet-explorer.hskchain.net", 177: "https://hsk.blockscout.com" };
let chainId = 177;
export function setChain(id: number): void {
  if (id in EXPLORERS) chainId = id;
}
export const currentChain = (): number => chainId;
export const networkName = (id = chainId): string => (id === 133 ? "Testnet 133" : `Mainnet ${id}`);
export const explorerBase = (): string => EXPLORERS[chainId]!;
/** @deprecated read explorerBase(): the explorer follows the daemon's chain. */
export const EXPLORER = EXPLORERS[177]!;
export const explorer = {
  tx: (h: string) => `${explorerBase()}/tx/${h}`,
  address: (a: string) => `${explorerBase()}/address/${a}`,
  block: (n: string | number) => `${explorerBase()}/block/${n}`,
  /** EAS.getAttestation(uid) read on the EAS predeploy. */
  attestation: (_uid: string) => `${explorerBase()}/address/0x4200000000000000000000000000000000000021?tab=read_contract`,
};

/** "0xF80A…2Bd2" (board style: 6 + 4). */
export const addrShort = (a: string): string => short(a, 6, 4);
/** 8-dp integer string → number (display maths only; never for signable values). */
export const e8n = (raw: string | null | undefined): number => (raw ? Number(BigInt(raw)) / 1e8 : 0);
/** Number → "$1,234.56" (2 dp, grouped, sign-aware). Display only. */
export function money(n: number, dp = 2): string {
  const neg = n < 0;
  const [i, f] = Math.abs(n).toFixed(dp).split(".");
  return `${neg ? "−" : ""}$${group(i!)}${f ? "." + f : ""}`;
}
export const signedMoney = (n: number, dp = 2): string => (n > 0 ? "+" + money(n, dp) : money(n, dp));
/** Whole-dollar limit, exact: "$250" or "$250.50". */
export function usdE8Short(raw: string): string {
  const v = BigInt(raw);
  return v % 100_000_000n === 0n ? "$" + group((v / 100_000_000n).toString()) : "$" + fmtUnits(raw, 8, 2);
}
export const int = (n: number | string): string => group(String(n));
/** "8h 14m" / "41m" / "2h 12m" age from seconds. */
export function age(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  if (s < 90) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon 2 Nov" (local). */
export function dayName(at: number): string {
  const d = new Date(at * 1000);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
}
export const hm = (at: number): string => clock(at).slice(0, 5);

/** Display a token balance (not a signable value): truncated to `dp` (default 8 for WBTC's 8 dp, else 2), grouped. */
export function tokenAmt(raw: string | bigint | null | undefined, decimals: number, dp = decimals === 8 ? 8 : 2): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  let v = BigInt(raw);
  const neg = v < 0n;
  if (neg) v = -v;
  if (decimals > dp) v = v / 10n ** BigInt(decimals - dp);
  const s = fmtUnits(v, dp, dp === 8 ? 8 : 2);
  return neg ? "−" + s : s;
}

/** 8-dp price for display: 2 dp at ≥ $1 (BTC), 5 dp below (HSK ≈ $0.087). */
export const price8 = (raw: string | null | undefined): string => {
  if (!raw) return "—";
  const v = BigInt(raw);
  return "$" + (v >= 100_000_000n ? fmtUnits((v / 1_000_000n) * 1_000_000n, 8, 2) : fmtUnits((v / 1000n) * 1000n, 8, 5));
};
