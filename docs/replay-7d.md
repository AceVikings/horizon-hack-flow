# ATE replay — last 7 days (E11)

> **Counterfactual, from logs, not realised P&L.** Generated 2026-11-02T05:15:16Z by `ate replay --days 7`. Sources: HSK Chain blocks 29322290–29624691, pool `Swap` logs via batched JSON-RPC eth_getLogs (https://mainnet.hsk.xyz; timestamps interpolated between block-header anchors); HashKey Global 1 m klines (site glb).

## Headline

- HSK: 1047 of 5040 cycles fired spread-revert (867 buy / 180 sell), mean counterfactual net edge 37.41 bps ($0.09 per $25); 10 would have been taken under the default-profile caps (close leg realised $0.16 on 4 lots; 6 lots still open at $-3.07 exit-executable / $-3.04 CEX-marked); gap > cost in 47.0% of cycles; verdict: transient (median time-to-close 4 min; longest 6.7 h).
- BTC: 3214 of 5040 cycles fired spread-revert (1499 buy / 1715 sell), mean counterfactual net edge 76.22 bps ($0.19 per $25); 6 would have been taken under the default-profile caps (close leg realised $0.00 on 0 lots; 6 lots still open at $-7.08 exit-executable / $-5.04 CEX-marked); gap > cost in 79.0% of cycles; verdict: persistent (> 1 day; longest episode 2.0 d).

## HSK — `hsk-dex:WHSK/USDT:3000`

Window 2026-10-26T05:15:16Z → 2026-11-02T05:15:16Z; cycle 120 s; default profile: entrySpreadBps 60, minNetEdgeBps 15, tradeSizeUsd $25, fee 30 bps, CEX half-spread 11.45 bps (median top of book at run time), minEntryIntervalSec 0, daily turnover share $100, maxPositionUsd $150.

| Metric | Value |
|---|---|
| Pool swaps / volume | 309 / $5,225.06 |
| Unique swap senders (top sender share) | 4 (`0x56d15c…` 91%) |
| Cycles evaluated (with pool + CEX data) | 5040 (5040) |
| CEX 1 m klines with no trade (close carried forward) | 61% |
| Candidates fired — spread-revert buy / sell | 867 / 180 |
| Rejected on net edge (gap ≥ 60 but net < 15) | 0 |
| Below entry spread (gap < 60 bps) | 3993 |
| edgeBps − costBps: p10 / p50 / p90 / max | -35.97 / -2.89 / 32.49 / 739.73 |
| Counterfactual net edge per fired candidate | 37.41 bps = $0.09 at $25 (Σ over all fired: $97.91) |
| Taken under rule 3/7 + position caps (buys) | 10 (Σ net edge at entry $2.36) |
| Close leg: lots closed / realised (exit-executable) | 4 / $0.16 |
| Open lots at window end: exit-executable / CEX-marked | 6 lots: $-3.07 / $-3.04 |
| Signed gap (pool − CEX) bps: min / p10 / p50 / p90 / max | -782.3 / -70.6 / -32.73 / 32.96 / 202.36 |
| Share of cycles with |gap| > cost | 47.0% |
| Episodes |gap| > cost (closed / still open) | 374 (374 / 0) |
| Median time for a gap > cost to fall below cost | 4 min |
| Longest episode | 6.7 h |
| **Verdict** | **transient (median time-to-close 4 min; longest 6.7 h)** |

### Top-decile gaps (HSK, one row per hour) — default-profile decision

| Time (UTC) | Gap bps | Cost bps | Net bps | Decision |
|---|---|---|---|---|
| 2026-10-28T03:38:00Z | -782.3 | 42.57 | 739.73 | spread-revert buy (net 739.73 ≥ 15) |
| 2026-11-01T11:42:00Z | -309.76 | 42.02 | 267.74 | spread-revert buy (net 267.74 ≥ 15) |
| 2026-10-27T13:40:00Z | -206.54 | 42.57 | 163.97 | spread-revert buy (net 163.97 ≥ 15) |
| 2026-10-26T05:22:00Z | 202.36 | 42.57 | 159.79 | spread-revert sell (net 159.79 ≥ 15) |
| 2026-10-29T03:16:00Z | 195.35 | 42.57 | 152.78 | spread-revert sell (net 152.78 ≥ 15) |
| 2026-10-29T21:04:00Z | 164.45 | 42.58 | 121.87 | spread-revert sell (net 121.87 ≥ 15) |
| 2026-10-28T06:10:00Z | -159.62 | 42.57 | 117.05 | spread-revert buy (net 117.05 ≥ 15) |
| 2026-10-30T02:02:00Z | 147.33 | 42.58 | 104.75 | spread-revert sell (net 104.75 ≥ 15) |
| 2026-10-30T03:00:00Z | 147.33 | 42.58 | 104.75 | spread-revert sell (net 104.75 ≥ 15) |
| 2026-11-01T10:58:00Z | -146.24 | 42.02 | 104.22 | spread-revert buy (net 104.22 ≥ 15) |

## BTC — `hsk-dex:WBTC/USDT:3000`

Window 2026-10-26T05:15:16Z → 2026-11-02T05:15:16Z; cycle 120 s; default profile: entrySpreadBps 60, minNetEdgeBps 15, tradeSizeUsd $25, fee 30 bps, CEX half-spread 0.01 bps (median top of book at run time), minEntryIntervalSec 1800, daily turnover share $100, maxPositionUsd $150.

| Metric | Value |
|---|---|
| Pool swaps / volume | 36 / $1,492.13 |
| Unique swap senders (top sender share) | 3 (`0x2c16f7…` 64%) |
| Cycles evaluated (with pool + CEX data) | 5040 (5040) |
| CEX 1 m klines with no trade (close carried forward) | 59% |
| Candidates fired — spread-revert buy / sell | 1499 / 1715 |
| Rejected on net edge (gap ≥ 60 but net < 15) | 0 |
| Below entry spread (gap < 60 bps) | 1826 |
| edgeBps − costBps: p10 / p50 / p90 / max | -19.76 / 44.36 / 106.15 / 232.12 |
| Counterfactual net edge per fired candidate | 76.22 bps = $0.19 at $25 (Σ over all fired: $612.46) |
| Taken under rule 3/7 + position caps (buys) | 6 (Σ net edge at entry $0.60) |
| Close leg: lots closed / realised (exit-executable) | 0 / $0.00 |
| Open lots at window end: exit-executable / CEX-marked | 6 lots: $-7.08 / $-5.04 |
| Signed gap (pool − CEX) bps: min / p10 / p50 / p90 / max | -185.51 / -123.25 / 4.27 / 129.22 / 267.01 |
| Share of cycles with |gap| > cost | 79.0% |
| Episodes |gap| > cost (closed / still open) | 71 (70 / 1) |
| Median time for a gap > cost to fall below cost | 8 min |
| Longest episode | 2.0 d |
| **Verdict** | **persistent (> 1 day; longest episode 2.0 d)** |

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
