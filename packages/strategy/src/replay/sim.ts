// `ate replay --days N` simulation (§11.3 Replay, E11). Pure: takes pool Swap points and CEX 1 m klines,
// runs the default-profile spread-revert rules on a cycleSeconds grid and measures gap persistence.
// Counterfactual, from logs, not realised P&L. Our own trades' pool impact is not simulated.

import { MARKETS, poolPriceFromSqrtPriceX96, type MarketId } from "@ate/core";

export interface SwapPoint {
  at: number;
  block: number;
  /** Pool price after the swap, 8 dp USD per whole priceToken. */
  priceE8: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** |amount1| (USDT, 6 dp) of the swap — volume. */
  usdtAbs: bigint;
  /** amount0 > 0 → pool received priceToken → someone sold the priceToken. */
  side: "buy" | "sell";
  sender: string;
}

export interface Kline {
  /** Open time, unix seconds. */
  t: number;
  close: number;
  /** Base volume traded in the minute (0 = no trade: the close is carried from the last trade). */
  volume?: number;
}

export interface ReplayParams {
  cycleSeconds: number;
  entrySpreadBps: number;
  minNetEdgeBps: number;
  tradeSizeUsd: number;
  feeBps: number;
  halfSpreadBps: number;
  minEntryIntervalSec: number;
  dailyTurnoverUsd: number;
  maxPositionUsd: number;
}

export interface CycleRow {
  at: number;
  pool: number;
  cex: number;
  gapBps: number;
  impactBps: number;
  costBps: number;
  netBps: number;
  fired: "buy" | "sell" | null;
  reject: "below_entry_spread" | "net_edge" | null;
}

export interface Episode {
  start: number;
  end: number | null;
  maxAbsGapBps: number;
  side: "buy" | "sell";
  peakAt: number;
}

export interface MarketReplay {
  market: MarketId;
  from: number;
  to: number;
  params: ReplayParams;
  swaps: number;
  volumeUsd: number;
  uniqueSenders: number;
  topSender: { address: string; share: number } | null;
  cycles: number;
  cyclesWithData: number;
  /** Share of window klines with no trade (stale close). */
  cexNoTradeMinutesShare: number;
  fired: { buy: number; sell: number };
  rejectedNetEdge: number;
  belowEntrySpread: number;
  netEdgeDist: Record<"p10" | "p50" | "p90" | "max", number>;
  gapDist: Record<"min" | "p10" | "p50" | "p90" | "max", number>;
  shareAboveCost: number;
  episodes: { count: number; closed: number; medianTimeToCloseSec: number | null; longestSec: number; open: number };
  verdict: string;
  counterfactual: {
    firedMeanNetBps: number | null;
    firedMeanNetUsd: number | null;
    firedSumNetUsd: number;
    taken: number;
    takenSumNetUsd: number;
    closedLots: number;
    realisedUsd: number;
    openLots: number;
    openExitUsd: number;
    openCexUsd: number;
  };
  topDecile: { at: number; gapBps: number; costBps: number; netBps: number; decision: string }[];
}

const Q96 = 2 ** 96;

export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i]!;
}

/** Impact of a $size buy at the pool state (V3 in-range): avg execution vs spot ≈ Δ√P / √P. */
export function impactBpsForUsd(sqrtPriceX96: bigint, liquidity: bigint, sizeUsd: number, feeBps: number): number {
  if (liquidity <= 0n) return 0;
  const a1 = sizeUsd * 1e6 * (1 - feeBps / 1e4); // USDT raw after fee
  const sqrtP = Number(sqrtPriceX96) / Q96;
  const dSqrt = a1 / Number(liquidity);
  return Math.round((dSqrt / sqrtP) * 1e4 * 100) / 100;
}

export function decodeSwapData(dataHex: string, d: number): { amount0: bigint; amount1: bigint; sqrtPriceX96: bigint; liquidity: bigint; tick: number; priceE8: bigint } {
  const h = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const word = (i: number) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
  const signed = (x: bigint, bits = 256) => (x >= 1n << BigInt(bits - 1) ? x - (1n << BigInt(bits)) : x);
  const amount0 = signed(word(0));
  const amount1 = signed(word(1));
  const sqrtPriceX96 = word(2);
  const liquidity = word(3);
  const tick = Number(signed(word(4)));
  return { amount0, amount1, sqrtPriceX96, liquidity, tick, priceE8: poolPriceFromSqrtPriceX96(sqrtPriceX96, d) };
}

function lastAtOrBefore<T extends { at?: number; t?: number }>(xs: T[], t: number, key: (x: T) => number): T | null {
  let lo = 0;
  let hi = xs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(xs[mid]!) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? xs[ans]! : null;
}

export function simulate(market: MarketId, swaps: SwapPoint[], klines: Kline[], from: number, to: number, p: ReplayParams): { report: MarketReplay; rows: CycleRow[] } {
  const d = MARKETS[market].baseDecimals;
  const sw = [...swaps].sort((a, b) => a.at - b.at);
  const kl = [...klines].sort((a, b) => a.t - b.t);
  const inWindow = sw.filter((s) => s.at >= from && s.at <= to);
  const volumeUsd = inWindow.reduce((a, s) => a + Number(s.usdtAbs) / 1e6, 0);
  const bySender = new Map<string, number>();
  for (const s of inWindow) bySender.set(s.sender, (bySender.get(s.sender) ?? 0) + 1);
  const top = [...bySender.entries()].sort((a, b) => b[1] - a[1])[0];

  const rows: CycleRow[] = [];
  const startCycle = Math.ceil(from / p.cycleSeconds) * p.cycleSeconds;
  let cycles = 0;
  for (let t = startCycle; t <= to; t += p.cycleSeconds) {
    cycles++;
    const s = lastAtOrBefore(sw, t, (x) => x.at);
    const k = lastAtOrBefore(kl, t, (x) => x.t);
    if (!s || !k || t - k.t > 300) continue;
    const pool = Number(s.priceE8) / 1e8;
    const cex = k.close;
    if (!(cex > 0) || !(pool > 0)) continue;
    void d;
    const gapBps = ((pool - cex) / cex) * 1e4;
    const impactBps = impactBpsForUsd(s.sqrtPriceX96, s.liquidity, p.tradeSizeUsd, p.feeBps);
    const costBps = p.feeBps + impactBps + p.halfSpreadBps;
    const netBps = Math.abs(gapBps) - costBps;
    let fired: CycleRow["fired"] = null;
    let reject: CycleRow["reject"] = null;
    if (Math.abs(gapBps) < p.entrySpreadBps) reject = "below_entry_spread";
    else if (netBps < p.minNetEdgeBps) reject = "net_edge";
    else fired = gapBps < 0 ? "buy" : "sell";
    rows.push({ at: t, pool, cex, gapBps, impactBps, costBps, netBps, fired, reject });
  }

  // Default-profile execution constraints on the fired candidates (taken), with a buy-side lot book.
  let lastEntry = -Infinity;
  let day = "";
  let dayTurnover = 0;
  let positionUsd = 0;
  const lots: { entry: number; qtyUsd: number; impact: number }[] = [];
  let taken = 0;
  let takenSumNetUsd = 0;
  let realisedUsd = 0;
  let closedLots = 0;
  for (const r of rows) {
    const today = new Date(r.at * 1000).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dayTurnover = 0;
    }
    // Close leg: FIFO lots whose exit-executable mark beats entry by ≥ minNetEdgeBps.
    const exitMark = r.pool * (1 - (p.feeBps + r.impactBps) / 1e4);
    while (lots.length && ((exitMark - lots[0]!.entry) / lots[0]!.entry) * 1e4 >= p.minNetEdgeBps) {
      const l = lots.shift()!;
      realisedUsd += l.qtyUsd * (exitMark / l.entry - 1);
      positionUsd -= l.qtyUsd;
      closedLots++;
    }
    if (r.fired !== "buy") continue; // sells need inventory we would not hold from spread-revert alone
    if (r.at - lastEntry < Math.max(p.minEntryIntervalSec, p.cycleSeconds - 10)) continue;
    if (dayTurnover + p.tradeSizeUsd > p.dailyTurnoverUsd) continue;
    if (positionUsd + p.tradeSizeUsd > p.maxPositionUsd) continue;
    lastEntry = r.at;
    dayTurnover += p.tradeSizeUsd;
    positionUsd += p.tradeSizeUsd;
    taken++;
    takenSumNetUsd += (r.netBps / 1e4) * p.tradeSizeUsd;
    lots.push({ entry: r.pool * (1 + (p.feeBps + r.impactBps) / 1e4), qtyUsd: p.tradeSizeUsd, impact: r.impactBps });
  }
  const last = rows[rows.length - 1];
  const openExitUsd = last ? lots.reduce((a, l) => a + l.qtyUsd * ((last.pool * (1 - (p.feeBps + last.impactBps) / 1e4)) / l.entry - 1), 0) : 0;
  const openCexUsd = last ? lots.reduce((a, l) => a + l.qtyUsd * (last.cex / l.entry - 1), 0) : 0;

  // Persistence: episodes of |gap| > cost.
  const episodes: Episode[] = [];
  let cur: Episode | null = null;
  for (const r of rows) {
    const above = Math.abs(r.gapBps) > r.costBps;
    if (above) {
      if (!cur) cur = { start: r.at, end: null, maxAbsGapBps: Math.abs(r.gapBps), side: r.gapBps < 0 ? "buy" : "sell", peakAt: r.at };
      else if (Math.abs(r.gapBps) > cur.maxAbsGapBps) {
        cur.maxAbsGapBps = Math.abs(r.gapBps);
        cur.peakAt = r.at;
      }
    } else if (cur) {
      cur.end = r.at;
      episodes.push(cur);
      cur = null;
    }
  }
  if (cur) episodes.push(cur);
  const closed = episodes.filter((e) => e.end !== null);
  const ttc = closed.map((e) => e.end! - e.start);
  const longestSec = Math.max(0, ...episodes.map((e) => (e.end ?? to) - e.start));
  const shareAboveCost = rows.length ? rows.filter((r) => Math.abs(r.gapBps) > r.costBps).length / rows.length : 0;
  const span = to - from;
  const medianTtc = ttc.length ? quantile(ttc, 0.5) : null;
  let verdict: string;
  if (rows.length === 0) verdict = "no data";
  else if (episodes.length === 0) verdict = "transient (gap never exceeded cost)";
  // Persistent = some gap > cost stayed open for ≥ 1 day (or more than half the window); otherwise transient.
  else if (longestSec >= Math.min(86_400, span * 0.5)) verdict = `persistent (> ${Math.max(1, Math.floor(longestSec / 86_400))} day${longestSec >= 2 * 86_400 ? "s" : ""}; longest episode ${fmtDur(longestSec)})`;
  else verdict = `transient (median time-to-close ${medianTtc === null ? "n/a" : fmtDur(medianTtc)}; longest ${fmtDur(longestSec)})`;

  const fired = rows.filter((r) => r.fired);
  const nets = rows.map((r) => r.netBps);
  const gaps = rows.map((r) => r.gapBps);
  // Top decile by |gap|, then one row per episode (or per distinct hour) for readability.
  const sorted = [...rows].sort((a, b) => Math.abs(b.gapBps) - Math.abs(a.gapBps));
  const decile = sorted.slice(0, Math.max(1, Math.ceil(rows.length / 10)));
  const seenHour = new Set<number>();
  const topDecile: MarketReplay["topDecile"] = [];
  for (const r of decile) {
    const h = Math.floor(r.at / 3600);
    if (seenHour.has(h)) continue;
    seenHour.add(h);
    topDecile.push({
      at: r.at,
      gapBps: round2(r.gapBps),
      costBps: round2(r.costBps),
      netBps: round2(r.netBps),
      decision: r.fired ? `spread-revert ${r.fired} (net ${round2(r.netBps)} ≥ ${p.minNetEdgeBps})` : r.reject === "net_edge" ? `no_trade: net ${round2(r.netBps)} < ${p.minNetEdgeBps}` : `no_trade: gap ${round2(Math.abs(r.gapBps))} < ${p.entrySpreadBps}`,
    });
    if (topDecile.length >= 10) break;
  }

  const report: MarketReplay = {
    market,
    from,
    to,
    params: p,
    swaps: inWindow.length,
    volumeUsd: round2(volumeUsd),
    uniqueSenders: bySender.size,
    topSender: top ? { address: top[0], share: round2(top[1] / inWindow.length) } : null,
    cycles,
    cyclesWithData: rows.length,
    cexNoTradeMinutesShare: (() => {
      const w = kl.filter((k) => k.t >= from && k.t <= to && k.volume !== undefined);
      return w.length ? round2(w.filter((k) => k.volume === 0).length / w.length) : 0;
    })(),
    fired: { buy: fired.filter((r) => r.fired === "buy").length, sell: fired.filter((r) => r.fired === "sell").length },
    rejectedNetEdge: rows.filter((r) => r.reject === "net_edge").length,
    belowEntrySpread: rows.filter((r) => r.reject === "below_entry_spread").length,
    netEdgeDist: { p10: round2(quantile(nets, 0.1)), p50: round2(quantile(nets, 0.5)), p90: round2(quantile(nets, 0.9)), max: round2(Math.max(...nets)) },
    gapDist: { min: round2(Math.min(...gaps)), p10: round2(quantile(gaps, 0.1)), p50: round2(quantile(gaps, 0.5)), p90: round2(quantile(gaps, 0.9)), max: round2(Math.max(...gaps)) },
    shareAboveCost: round2(shareAboveCost),
    episodes: { count: episodes.length, closed: closed.length, medianTimeToCloseSec: medianTtc, longestSec, open: episodes.length - closed.length },
    verdict,
    counterfactual: {
      firedMeanNetBps: fired.length ? round2(fired.reduce((a, r) => a + r.netBps, 0) / fired.length) : null,
      firedMeanNetUsd: fired.length ? round4((fired.reduce((a, r) => a + r.netBps, 0) / fired.length / 1e4) * p.tradeSizeUsd) : null,
      firedSumNetUsd: round2(fired.reduce((a, r) => a + (r.netBps / 1e4) * p.tradeSizeUsd, 0)),
      taken,
      takenSumNetUsd: round2(takenSumNetUsd),
      closedLots,
      realisedUsd: round2(realisedUsd),
      openLots: lots.length,
      openExitUsd: round2(openExitUsd),
      openCexUsd: round2(openCexUsd),
    },
    topDecile,
  };
  return { report, rows };
}

const round2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function fmtDur(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)} h`;
  return `${(sec / 86_400).toFixed(1)} d`;
}
