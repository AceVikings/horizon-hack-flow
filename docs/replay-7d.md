# ATE replay — last 7 days (E11)

> **Counterfactual, from logs, not realised P&L.** Generated 2026-11-02T04:58:28Z by `ate replay --days 7`. Sources: HSK Chain blocks 29321786–29624186, pool `Swap` logs via batched JSON-RPC eth_getLogs (https://mainnet.hsk.xyz; timestamps interpolated between block-header anchors); HashKey Global 1 m klines (site glb).

## Headline

- HSK: 664 of 5040 cycles fired spread-revert (543 buy / 121 sell), mean counterfactual net edge 35.46 bps ($0.09 per $25); 10 would have been taken under the default-profile caps; gap > cost in 29.0% of cycles; verdict: transient (median time-to-close 4 min).
- BTC: 3214 of 5040 cycles fired spread-revert (1491 buy / 1723 sell), mean counterfactual net edge 76.16 bps ($0.19 per $25); 6 would have been taken under the default-profile caps; gap > cost in 79.0% of cycles; verdict: persistent (> 1 days).

## HSK — `hsk-dex:WHSK/USDT:3000`

Window 2026-10-26T04:58:28Z → 2026-11-02T04:58:28Z; cycle 120 s; default profile: entrySpreadBps 60, minNetEdgeBps 15, tradeSizeUsd $25, fee 30 bps, CEX half-spread 22.83 bps (top of book at run time), minEntryIntervalSec 0, daily turnover share $100, maxPositionUsd $150.

| Metric | Value |
|---|---|
| Pool swaps / volume | 327 / $5,490.06 |
| Unique swap senders (top sender share) | 4 (`0x56d15c…` 91%) |
| Cycles evaluated (with pool + CEX data) | 5040 (5040) |
| CEX 1 m klines with no trade (close carried forward) | 61% |
| Candidates fired — spread-revert buy / sell | 543 / 121 |
| Rejected on net edge (gap ≥ 60 but net < 15) | 384 |
| Below entry spread (gap < 60 bps) | 3992 |
| edgeBps − costBps: p10 / p50 / p90 / max | -47.35 / -14.27 / 21.11 / 728.35 |
| Counterfactual net edge per fired candidate | 35.46 bps = $0.09 at $25 (Σ over all fired: $58.87) |
| Taken under rule 3/7 + position caps (buys) | 10 (Σ net edge at entry $2.31) |
| Close leg: lots closed / realised (exit-executable) | 4 / $0.16 |
| Open lots at window end: exit-executable / CEX-marked | 6 lots: $-3.06 / $-2.54 |
| Signed gap (pool − CEX) bps: min / p10 / p50 / p90 / max | -782.3 / -70.6 / -32.73 / 32.96 / 202.36 |
| Share of cycles with |gap| > cost | 29.0% |
| Episodes |gap| > cost (closed / still open) | 323 (323 / 0) |
| Median time for a gap > cost to fall below cost | 4 min |
| Longest episode | 4.7 h |
| **Verdict** | **transient (median time-to-close 4 min)** |

### Top-decile gaps (HSK, one row per hour) — default-profile decision

| Time (UTC) | Gap bps | Cost bps | Net bps | Decision |
|---|---|---|---|---|
| 2026-10-28T03:38:00Z | -782.3 | 53.95 | 728.35 | spread-revert buy (net 728.35 ≥ 15) |
| 2026-11-01T11:42:00Z | -309.76 | 53.4 | 256.36 | spread-revert buy (net 256.36 ≥ 15) |
| 2026-10-27T13:40:00Z | -206.54 | 53.95 | 152.59 | spread-revert buy (net 152.59 ≥ 15) |
| 2026-10-26T05:22:00Z | 202.36 | 53.95 | 148.41 | spread-revert sell (net 148.41 ≥ 15) |
| 2026-10-29T03:16:00Z | 195.35 | 53.95 | 141.4 | spread-revert sell (net 141.4 ≥ 15) |
| 2026-10-29T21:04:00Z | 164.45 | 53.96 | 110.49 | spread-revert sell (net 110.49 ≥ 15) |
| 2026-10-28T06:10:00Z | -159.62 | 53.95 | 105.67 | spread-revert buy (net 105.67 ≥ 15) |
| 2026-10-30T02:02:00Z | 147.33 | 53.96 | 93.37 | spread-revert sell (net 93.37 ≥ 15) |
| 2026-10-30T03:00:00Z | 147.33 | 53.96 | 93.37 | spread-revert sell (net 93.37 ≥ 15) |
| 2026-11-01T10:58:00Z | -146.24 | 53.4 | 92.84 | spread-revert buy (net 92.84 ≥ 15) |

## BTC — `hsk-dex:WBTC/USDT:3000`

Window 2026-10-26T04:58:28Z → 2026-11-02T04:58:28Z; cycle 120 s; default profile: entrySpreadBps 60, minNetEdgeBps 15, tradeSizeUsd $25, fee 30 bps, CEX half-spread 0.01 bps (top of book at run time), minEntryIntervalSec 1800, daily turnover share $100, maxPositionUsd $150.

| Metric | Value |
|---|---|
| Pool swaps / volume | 36 / $1,492.13 |
| Unique swap senders (top sender share) | 3 (`0x2c16f7…` 64%) |
| Cycles evaluated (with pool + CEX data) | 5040 (5040) |
| CEX 1 m klines with no trade (close carried forward) | 59% |
| Candidates fired — spread-revert buy / sell | 1491 / 1723 |
| Rejected on net edge (gap ≥ 60 but net < 15) | 0 |
| Below entry spread (gap < 60 bps) | 1826 |
| edgeBps − costBps: p10 / p50 / p90 / max | -19.76 / 44.36 / 106.15 / 232.12 |
| Counterfactual net edge per fired candidate | 76.16 bps = $0.19 at $25 (Σ over all fired: $611.91) |
| Taken under rule 3/7 + position caps (buys) | 6 (Σ net edge at entry $0.60) |
| Close leg: lots closed / realised (exit-executable) | 0 / $0.00 |
| Open lots at window end: exit-executable / CEX-marked | 6 lots: $-7.08 / $-4.68 |
| Signed gap (pool − CEX) bps: min / p10 / p50 / p90 / max | -185.51 / -123.08 / 4.6 / 129.22 / 267.01 |
| Share of cycles with |gap| > cost | 79.0% |
| Episodes |gap| > cost (closed / still open) | 71 (70 / 1) |
| Median time for a gap > cost to fall below cost | 8 min |
| Longest episode | 1.9 d |
| **Verdict** | **persistent (> 1 days)** |

### Top-decile gaps (BTC, one row per hour) — default-profile decision

| Time (UTC) | Gap bps | Cost bps | Net bps | Decision |
|---|---|---|---|---|
| 2026-10-30T02:06:00Z | 267.01 | 34.89 | 232.12 | spread-revert sell (net 232.12 ≥ 15) |
| 2026-10-30T13:52:00Z | 264.98 | 34.89 | 230.09 | spread-revert sell (net 230.09 ≥ 15) |
| 2026-10-30T14:16:00Z | 249.46 | 34.89 | 214.57 | spread-revert sell (net 214.57 ≥ 15) |
| 2026-10-30T01:52:00Z | 249.18 | 34.89 | 214.29 | spread-revert sell (net 214.29 ≥ 15) |
| 2026-10-30T00:34:00Z | 225.24 | 34.89 | 190.35 | spread-revert sell (net 190.35 ≥ 15) |
| 2026-10-29T20:42:00Z | 192.55 | 34.82 | 157.73 | spread-revert sell (net 157.73 ≥ 15) |
| 2026-11-02T01:22:00Z | -185.51 | 34.93 | 150.58 | spread-revert buy (net 150.58 ≥ 15) |
| 2026-10-29T23:52:00Z | 184.44 | 34.87 | 149.57 | spread-revert sell (net 149.57 ≥ 15) |
| 2026-10-30T12:44:00Z | 180.11 | 34.89 | 145.22 | spread-revert sell (net 145.22 ≥ 15) |
| 2026-10-30T03:16:00Z | 176.47 | 34.89 | 141.58 | spread-revert sell (net 141.58 ≥ 15) |

## Method and caveats

- Pool price per cycle = price after the last `Swap` at or before the cycle (from `sqrtPriceX96` in the event); impact for a `tradeSizeUsd` buy from the event's active `liquidity` (V3 in-range approximation).
- CEX reference = HashKey Global 1 m kline close (`/quote/v1/klines`, `hashkey-public-market` endpoint map); the half-spread is a constant read from the live top of book at run time.
- The kline close is the last trade price, not a book mid: on HSKUSDT the 0.0001 tick is ~11 bps of price, and on BTCUSDT many minutes have no trade (share above), so a stale close inflates |gap| in both directions. Treat single-cycle gaps as noisy; the persistence statistics and the realised close-leg result are the robust numbers.
- The pool price only moves on swaps (few per day on WBTC/USDT), so a gap is frequently the CEX moving while the pool stands still; a buy marked at the CEX shows paper edge that is realised only if a later swap moves the pool toward the CEX.
- One-legged: a spread-revert buy realises only if the pool reverts toward the CEX (close leg, fee-inclusive exit mark ≥ entry + minNetEdgeBps). Our own trades' pool impact is not simulated; sells need inventory and are counted as fired, not taken.
- A zero or negative result is stated as such: the market gave no edge after fees, and the agent correctly did nothing.
