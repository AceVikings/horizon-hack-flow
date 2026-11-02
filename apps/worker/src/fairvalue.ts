// The premium signal (§9.1): a 15-minute WHSK fair-value estimate from HashKey Global ORDER BOOK DEPTH
// (not just the ticker), recent pool swap flow and the pool's depth profile.

export type Level = [price: number, qty: number];
export interface DepthBook {
  bids: Level[];
  asks: Level[];
  at: number;
}
export interface PoolSwap {
  price: number;
  usd: number;
  at: number;
}
export interface PoolDepth {
  /** USD needed to move the pool price ±1% (from the tick liquidity profile). */
  usdToMoveUp1Pct: number;
  usdToMoveDown1Pct: number;
}

export interface FairValueSignal {
  product: "whsk-fair-value-15m";
  market: "hsk-dex:WHSK/USDT:3000";
  /** 8-dp USD price, decimal string. */
  fairValue: string;
  /** Components, for the journal's `context.signal`. */
  components: { depthMicroprice: number; bookImbalance: number; poolVwap: number | null; poolSkew: number | null; weights: { depth: number; pool: number } };
  confidenceBps: number;
  horizonSec: 900;
  at: number;
}

/** Depth-weighted microprice over levels within `bandBps` of mid. */
export function depthMicroprice(book: DepthBook, bandBps = 50): { price: number; imbalance: number; mid: number } {
  const bb = book.bids[0];
  const ba = book.asks[0];
  if (!bb || !ba || bb[0] <= 0 || ba[0] <= bb[0]) throw new Error("depth book empty or crossed");
  const mid = (bb[0] + ba[0]) / 2;
  const lo = mid * (1 - bandBps / 10_000);
  const hi = mid * (1 + bandBps / 10_000);
  const bidQ = book.bids.filter(([p]) => p >= lo).reduce((s, [, q]) => s + q, 0);
  const askQ = book.asks.filter(([p]) => p <= hi).reduce((s, [, q]) => s + q, 0);
  const imbalance = bidQ + askQ > 0 ? (bidQ - askQ) / (bidQ + askQ) : 0;
  // Microprice: lean towards the side with less resting size.
  const price = (ba[0] * bidQ + bb[0] * askQ) / Math.max(bidQ + askQ, Number.EPSILON);
  return { price, imbalance, mid };
}

export function computeFairValue(input: { book: DepthBook; swaps?: PoolSwap[]; pool?: PoolDepth; now: number }): FairValueSignal {
  const d = depthMicroprice(input.book);
  const recent = (input.swaps ?? []).filter((s) => input.now - s.at <= 900 && s.usd > 0);
  const vol = recent.reduce((s, x) => s + x.usd, 0);
  const vwap = vol > 0 ? recent.reduce((s, x) => s + x.price * x.usd, 0) / vol : null;
  const skew = input.pool ? (input.pool.usdToMoveUp1Pct - input.pool.usdToMoveDown1Pct) / Math.max(input.pool.usdToMoveUp1Pct + input.pool.usdToMoveDown1Pct, 1) : null;
  const wPool = vwap === null ? 0 : Math.min(0.4, vol / 5_000); // pool flow weight grows with traded USD, capped
  const wDepth = 1 - wPool;
  let fv = wDepth * d.price + wPool * (vwap ?? 0);
  if (skew !== null) fv *= 1 + skew * 0.001; // thin side above → price drifts that way (≤ 10 bps)
  const spreadBps = ((input.book.asks[0]![0] - input.book.bids[0]![0]) / d.mid) * 10_000;
  const disagreeBps = vwap === null ? 0 : (Math.abs(vwap - d.price) / d.mid) * 10_000;
  return {
    product: "whsk-fair-value-15m",
    market: "hsk-dex:WHSK/USDT:3000",
    fairValue: fv.toFixed(8),
    components: { depthMicroprice: d.price, bookImbalance: d.imbalance, poolVwap: vwap, poolSkew: skew, weights: { depth: wDepth, pool: wPool } },
    confidenceBps: Math.round(spreadBps / 2 + disagreeBps / 2),
    horizonSec: 900,
    at: input.now,
  };
}

/** HashKey Global public depth (GET /quote/v1/depth). Tolerates {b,a} or {bids,asks}. */
export async function fetchDepth(symbol = "HSKUSDT", base = "https://api-glb.hashkey.com", fetchImpl: typeof fetch = fetch): Promise<DepthBook> {
  const r = await fetchImpl(`${base}/quote/v1/depth?symbol=${encodeURIComponent(symbol)}&limit=50`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`depth ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  const lv = (x: unknown): Level[] => (Array.isArray(x) ? x.map((l) => [Number((l as unknown[])[0]), Number((l as unknown[])[1])] as Level) : []);
  return { bids: lv(j.b ?? j.bids), asks: lv(j.a ?? j.asks), at: Math.floor(Number(j.t ?? Date.now()) / 1000) };
}
