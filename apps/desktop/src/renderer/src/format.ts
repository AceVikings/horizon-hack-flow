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

export const EXPLORER = "https://hsk.blockscout.com";
export const explorer = {
  tx: (h: string) => `${EXPLORER}/tx/${h}`,
  address: (a: string) => `${EXPLORER}/address/${a}`,
  /** EAS.getAttestation(uid) read on the EAS contract. */
  attestation: (_uid: string) => `${EXPLORER}/address/0x4200000000000000000000000000000000000021?tab=read_contract`,
};
