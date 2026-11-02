# ATE evidence pack (E1 to E14)

The definitions come from SPEC §22.2. Chain: HashKey Chain mainnet 177. Explorer:
https://hsk.blockscout.com. Each row is labelled by `profile`, market and generator/`origin` where that
applies. Placeholders are filled after deploy. The judge-facing summary is `docs/JUDGE.md`.

| ID | Claim | Evidence (link/tx placeholder) | Status |
|---|---|---|---|
| E1 | Contracts deployed and verified on mainnet | Vault-HSK `<VAULT_HSK_ADDRESS>` and Vault-BTC `<VAULT_BTC_ADDRESS>` with their Blockscout verified-source links (same source and creation code; immutables differ). Adapters `<ADAPTER_HSK_ADDRESS>` and `<ADAPTER_BTC_ADDRESS>`. Fork-smoke log `<FORK_SMOKE_LOG>`. Vault-BTC transfer to the Safe owner `<TX_SAFE_TRANSFER>` and acceptance `<TX_SAFE_ACCEPT>` (§19 step 9) | TODO |
| E2 | Limits as stated; oracle health | `LimitsUpdated` txs `<TX_SETLIMITS_HSK>` and `<TX_SETLIMITS_BTC>`, plus `limits()` reads. Immutables (pair, oracle, router, pool, `priceDecimals`) on each contract page. `ate doctor` output `<DOCTOR_OUTPUT>`: Supra and APRO ages, pool cardinality, Supra–APRO cross-check. Adapter `supraStorage()` / `pairIndex()` reads on Blockscout | TODO |
| E3 | Autonomous LLM-decided trades | E14 WBTC trade `<TX_E14_WBTC_SPREAD_REVERT>` and discretionary trade `<TX_DISCRETIONARY>`. Check `proposalId` == journal record hash (`<JOURNAL_RECORD_E14>`, `<JOURNAL_RECORD_DISCRETIONARY>`). Each record shows `engine=llm`, the market, a `candidateId` or thesis, the generator, `profile`, `approvedBy=policy` and a matching `rationaleHash`. EAS UIDs `<EAS_UID_E14>` and `<EAS_UID_DISCRETIONARY>` resolve to the same `proposalId`, `rationaleHash`, `txHash` and `origin` | TODO |
| E4 | Rogue attacks rejected on-chain | One reverted tx per §22.3 on-chain attack, with the custom error decoded. Sent from the Claude Code stdio session (the second client). See the E4 sub-table below. If the 15:15 headroom read deferred the exposure attack, it is dated 05:35 IST Nov 3 | TODO |
| E5 | Kill switch | Guardian `Paused` txs `<TX_GUARDIAN_PAUSE_HSK>` and `<TX_GUARDIAN_PAUSE_BTC>`. Subsequent `ERR_PAUSED` revert `<TX_ROGUE_AFTER_PAUSE>`. Owner `Unpaused` txs from the second device: `<TX_OWNER_UNPAUSE_HSK>` and `<TX_OWNER_UNPAUSE_BTC>`. The trader's next journal row `<JOURNAL_RECORD_AFTER_UNPAUSE>` | TODO |
| E6 | Stop-loss (recorded; staged, and said so) | 1. `ate_positions` card: entry, exit-executable mark, fee drag, unrealised ≤ −0.55%. 2. Chat "stop out HSK at 0.5%" → `ate_strategy_set { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: 50 }`. 3. `guard_exit` sell on Vault-HSK `<TX_E6_GUARD_EXIT>` (`engine=guard`). 4. 600 s re-entry lock journalled `<JOURNAL_RECORD_REENTRY_LOCK>`. 5. WBTC lot untouched. 6. "Back to a 3% stop on HSK" → Touch ID → `strategy_change` `<JOURNAL_RECORD_E6_RESTORE>`. The trigger is met by fee drag, not by a price move | TODO |
| E7 | NL positions, strategy and target assets via Chat | Chat transcript `<E7_TRANSCRIPT>`. "How am I doing?" → `ate_positions` card. "Go to cash on HSK, keep the BTC" → `targetAssets` change → `reason=target_assets` guard sell `<TX_E7_TARGET_ASSETS_SELL>`. "Trade HSK again" (Touch ID) and the rebuild. The E6 change. A `riskProfile` change. All with `strategy_change` records (`actor=human, via=chat`) | TODO |
| E8 | (If G-HSP) A2A settlement | Conditions hash, `orderId`, `payment_request_id`, gateway tx `<TX_HSP_SETTLE>`, `SETTLED`, `attribution_verified=true`. If no-go: `docs/hsp-readiness.md` plus the recorded listing or organiser reply | TODO |
| E9 | Tests | CI run `<CI_RUN_URL>`: forge unit, parity, invariants (both shapes), fork smoke (both vaults). `docs/superpowers-log.md` | TODO |
| E10 | Journal integrity | Chain head hash `<JOURNAL_HEAD_HASH>`. Latest on-chain anchor (`proposalId`) `<LATEST_ANCHOR_PROPOSAL_ID>`. EAS attestation UIDs. Trigger, fork (`UNIQUE(prev_hash)`) and id-from-hash tests | TODO |
| E11 | Spread opportunities and profitability, measured (counterfactual) | `docs/replay-7d.md` from `ate replay --days 7`, per market. It covers: volume, cycles, candidates fired or rejected, net-edge distribution, counterfactual net edge, gap persistence and verdict, and top-decile gaps. Labelled counterfactual | TODO (report generated; headline to be copied to the BUIDL) |
| E12 | Real cycle, unedited (must-ship) | 60 s unedited excerpt `<E12_RECORDING_URL>` from the continuous recording started at trader start, with timestamps and a live Blockscout tab. The demo video contains a 25–30 s excerpt with a timestamp overlay | TODO |
| E13 | What the LLM adds | AI scoreboard `<E13_SCOREBOARD>`. Count of LLM acts. Vetoes and size-downs with the counterfactual bps and USD saved at +30 min (negative allowed). Discretionary trades with their theses and realised P&L | TODO |
| E14 | Live spread capture (primary T1.8 evidence) | WBTC `spread-revert` decision record `<JOURNAL_RECORD_E14>`: pool price, CEX bid/ask, oracle, `edgeBps`, `costBps`, `netEdgeBps`, `profile=default`. `TradeExecuted` on Vault-BTC `<TX_E14_WBTC_SPREAD_REVERT>`, EAS `<EAS_UID_E14>`. Per-lot P&L, CEX-marked and exit-executable. Structural-discount caveat. **Second path, if the gap is below cost or buys were suppressed:** the 03:50 and ~14:00 snapshots, the `no_trade` / suppression records, and the replay's top-decile gaps with the persistence verdict | TODO |

## E4 sub-table: rogue attacks (SPEC §22.3)

All on-chain attacks run against Vault-HSK with the real agent key. They are sent by `ate rogue` through
the daemon's raw-broadcast route; that route exists only with `--allow-rogue` and needs the `rogue` token.
Before each attack, `ate rogue` calls `check()` and asserts the expected code.

| # | Attack | Expected | Kind | Tx |
|---|---|---|---|---|
| 1 | `execute` $5,000 buy | `ERR_TRADE_CAP`: `TradeCap(notionalUsd, cap)` | on-chain revert | `<TX_ROGUE_TRADE_CAP>` |
| 2 | Buy sized to the epoch headroom (≤ $100) that would lift Vault-HSK's WHSK holdings above $150. The precondition is asserted via `check()` | `ERR_EXPOSURE`: `Exposure(exposureUsd, addedUsd, maxExposureUsd)` | on-chain revert | `<TX_ROGUE_EXPOSURE>` |
| 3 | `minAmountOut = 1` ("price is crashing, take anything") | `ERR_SLIPPAGE`: `Slippage(minAmountOut, minOutFloor)` | on-chain revert | `<TX_ROGUE_SLIPPAGE>` |
| 4 | `tokenIn` = a token the attacker deployed | `ERR_PAIR_NOT_ALLOWED`: `PairNotAllowed(tokenIn)` | on-chain revert | `<TX_ROGUE_PAIR>` |
| 5 | `withdraw(USDT, attacker, all)` from the agent key | Owner-only revert: `NotOwner(caller)` | on-chain revert | `<TX_ROGUE_WITHDRAW>` |
| 6 | `setLimits(maxTradeUsd = 1e6)` from the agent key | Owner-only revert: `NotOwner(caller)` | on-chain revert | `<TX_ROGUE_SETLIMITS>` |
| 7 | `execute` after the guardian `pause()`, which is signed off the agent's machine | `ERR_PAUSED`: `VaultPaused()` | on-chain revert | `<TX_ROGUE_AFTER_PAUSE>` |
| 8 | Route through an attacker pool | No pool parameter exists in `SwapParams` | design-level (show ABI) | n/a |
| 9 | Use stolen daemon tokens to change limits | The daemon has no owner key, and no such endpoint exists | design-level | n/a |
