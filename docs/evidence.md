# ATE evidence pack (E1 to E14)

The definitions come from SPEC §22.2. Main table: HashKey Chain mainnet 177 (next, placeholders). The TESTNET (133) run is filled in below.
Mainnet explorer: https://hsk.blockscout.com. Each row is labelled by `profile`, market and generator/`origin` where that
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

## TESTNET run (chain 133), 2 Nov 2026

Real transactions on HashKey Chain **testnet** with test tokens. Explorer: https://testnet-explorer.hskchain.net.
Click order and context: [`docs/JUDGE.md`](JUDGE.md) (testnet section). Journal export:
[`testnet-133-journal.json`](testnet-133-journal.json). Two pool prices were staged with a deployer swap
(WBTC −150 bps, HSK +200 bps vs Supra), because nobody else trades the test pools; rows that depend on them
say "staged".

| ID | Testnet evidence | Status |
|---|---|---|
| E1 | Vault-HSK `0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2`, Vault-BTC `0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693`, adapters `0xeCC8…c9A2` / `0x9bbb…9372` (Sourcify exact match). Addresses in `deployments/133.json` | Done (testnet) |
| E2 | `limits()` = §19 defaults on both vaults. `ate doctor` not captured | Partly |
| E3 | LLM trades: WBTC spread-revert buy [0x4ff2ad51…](https://testnet-explorer.hskchain.net/tx/0x4ff2ad5176975fed3b45e5242894cce949b68b626051e82ec3d270474fde9c0d) (staged gap) and its close [0xfb0a8f69…](https://testnet-explorer.hskchain.net/tx/0xfb0a8f69cbab91888e03d5f33cfe9139be8a3ead5bc70e081498d6840081695b) (+70.11 bps); HSK spread-revert sell [0x50946bc6…](https://testnet-explorer.hskchain.net/tx/0x50946bc62ce7c8478c4bc55415b2f22784cfc3f67d9350894460fc2c2e09cef0) (staged, demo); first LLM trade, HSK demo rebalance [0xcb10731e…](https://testnet-explorer.hskchain.net/tx/0xcb10731e34a4ffc0934201ef35d04d8ffb04cb1d2e35871c65e6504f26473afc). `proposalId` in `TradeExecuted` = journal record hash; each has an EAS attestation | Done (testnet) |
| E4 | Six on-chain attacks reverted with decoded errors (sub-table below) | Done (testnet) |
| E5 | Guardian `pause()` [0xaba62b83…](https://testnet-explorer.hskchain.net/tx/0xaba62b83fd096241a703c4f4ced8b7a7eb4a3e9101a127c71c60e1c11c4a221a) → rogue `VaultPaused()` [0x62f96834…](https://testnet-explorer.hskchain.net/tx/0x62f96834dfa5ff64bb0ddd378c56f2a42d5b83b96d951f7a0803ca6029b31a8b) → owner `unpause()` [0x530bafc2…](https://testnet-explorer.hskchain.net/tx/0x530bafc2456b50dd35ee58359f02b1c4b8e44c9719f154caff7e599680f9e949). Vault-HSK only | Done (testnet, one vault) |
| E6 | Chat tightened the HSK stop to 2% (`strat_f5afedf52d2a981a`). A guard take-profit exit fired after the staged HSK move [0x8301a6d9…](https://testnet-explorer.hskchain.net/tx/0x8301a6d9439b42df5888306646eaaac3978f3d04370a45e0b747df5192b07122). No stop-loss exit recorded | Partly |
| E7 | `ate chat` (LLM): "Go to cash on HSK, keep the BTC" → `strat_a34e1d080f3163c4` → guard `target_assets` sell [0x0e68e7df…](https://testnet-explorer.hskchain.net/tx/0x0e68e7dfac501a1a80517bf61c2d81a74eeb19a944935824c2046669567005fa); "Trade HSK again" (loosening, one-time TTY code) → `strat_5380ce8a1e897693` | Done (testnet) |
| E8 | HSP not run on testnet | Not done |
| E10 | `POST /journal/verify` → ok, 70 records, head `0x5e72385d2128743e19c6cbb2ff2bc9ffdfd3a02e6d02914192a9af9ef5b5ad85` | Done (testnet) |
| E13 | One `llm_veto` (`dec_1118327a147287cd`, HSK demo rebalance buy). Its premise was a `target_assets` guard-exit candidate still listed (within its 180 s TTL) after HSK had been re-enabled. No discretionary trade was originated | Partly |
| E14 | Spread capture shown only on a staged testnet gap (WBTC pool 133 bps under the HashKey Global mid). Not a market result | Staged only |

E9, E11 and E12 do not depend on the network and are tracked in the main table.

## E4 sub-table: rogue attacks (SPEC §22.3)

All on-chain attacks run against Vault-HSK with the real agent key. They are sent by `ate rogue` through
the daemon's raw-broadcast route; that route exists only with `--allow-rogue` and needs the `rogue` token.
Before each attack, `ate rogue` calls `check()` and asserts the expected code.

| # | Attack | Expected | Kind | Tx (mainnet) | TESTNET 133 tx (Vault-HSK) |
|---|---|---|---|---|---|
| 1 | `execute` $5,000 buy | `ERR_TRADE_CAP`: `TradeCap(notionalUsd, cap)` | on-chain revert | `<TX_ROGUE_TRADE_CAP>` | [0x7213dfc8…](https://testnet-explorer.hskchain.net/tx/0x7213dfc80d876804e3232bc572b2ecc99faae25f75e4457da71b8616ca091e24) |
| 2 | Buy sized to the epoch headroom (≤ $100) that would lift Vault-HSK's WHSK holdings above $150. The precondition is asserted via `check()` | `ERR_EXPOSURE`: `Exposure(exposureUsd, addedUsd, maxExposureUsd)` | on-chain revert | `<TX_ROGUE_EXPOSURE>` | [0x39f56ce9…](https://testnet-explorer.hskchain.net/tx/0x39f56ce9b6e78e866ee74200d4cc87093f037098e842dbb5a2a6de5351f68856) |
| 3 | `minAmountOut = 1` ("price is crashing, take anything") | `ERR_SLIPPAGE`: `Slippage(minAmountOut, minOutFloor)` | on-chain revert | `<TX_ROGUE_SLIPPAGE>` | [0x0677fb88…](https://testnet-explorer.hskchain.net/tx/0x0677fb8896195c736201374805876d0aa0122b0ea57ecdf08b5f78f40b531558) |
| 4 | `tokenIn` = a token the attacker deployed | `ERR_PAIR_NOT_ALLOWED`: `PairNotAllowed(tokenIn)` | on-chain revert | `<TX_ROGUE_PAIR>` | [0xf3e465a5…](https://testnet-explorer.hskchain.net/tx/0xf3e465a59deb84b297f6e9a8c56eb6420e7b0a831fb2e22fe0056d8f549bcb04) |
| 5 | `withdraw(USDT, attacker, all)` from the agent key | Owner-only revert: `NotOwner(caller)` | on-chain revert | `<TX_ROGUE_WITHDRAW>` | [0x6f5d929c…](https://testnet-explorer.hskchain.net/tx/0x6f5d929c9591a028c811eb7f841cc77bf435619f799b344f8ff4881cfb139a8c) |
| 6 | `setLimits(maxTradeUsd = 1e6)` from the agent key | Owner-only revert: `NotOwner(caller)` | on-chain revert | `<TX_ROGUE_SETLIMITS>` | [0x83f807a8…](https://testnet-explorer.hskchain.net/tx/0x83f807a8f22886a881e5d461156c9e415676b03c832b55baa0c51b202b737410) |
| 7 | `execute` after the guardian `pause()`, which is signed off the agent's machine | `ERR_PAUSED`: `VaultPaused()` | on-chain revert | `<TX_ROGUE_AFTER_PAUSE>` | [0x62f96834…](https://testnet-explorer.hskchain.net/tx/0x62f96834dfa5ff64bb0ddd378c56f2a42d5b83b96d951f7a0803ca6029b31a8b) |
| 8 | Route through an attacker pool | No pool parameter exists in `SwapParams` | design-level (show ABI) | n/a | n/a |
| 9 | Use stolen daemon tokens to change limits | The daemon has no owner key, and no such endpoint exists | design-level | n/a | n/a |
