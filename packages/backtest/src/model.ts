// Impact model calibration (lane STRAT). V3 in range: a buy of $x moves the average execution ≈ x·(1 − fee)/D above
// spot, with D = L·√P in USD. D comes from QuoterV2 when the daemon can quote (depthFromQuote), else from past swaps:
// each swap of $q that moved the price from p0 to p1 gives D ≈ q / (|p1 − p0| / 2p0) — the median is used.

/** Depth from one QuoterV2 sample: a $sizeUsd buy that executed impactBps above spot (fee excluded). */
export function depthFromQuote(sizeUsd: number, impactBps: number, feeBps = 30): number {
  if (!(impactBps > 0)) return Infinity;
  return (sizeUsd * (1 - feeBps / 1e4) * 1e4) / impactBps;
}

/** Median depth implied by consecutive swaps (price after each swap, USD size). null with too few moves. */
export function depthFromSwaps(swaps: readonly { t: number; v: number; vol?: number }[]): number | null {
  const xs: number[] = [];
  for (let k = 1; k < swaps.length; k++) {
    const p0 = swaps[k - 1]!.v;
    const p1 = swaps[k]!.v;
    const q = swaps[k]!.vol ?? 0;
    const move = Math.abs(p1 - p0) / (2 * p0);
    if (q > 1 && move > 1e-7) xs.push(q / move);
  }
  if (xs.length < 5) return null;
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)]!;
}
