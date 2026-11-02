# Flow evidence pack (E1 to E14)

The claim IDs come from SPEC §22.2. Each row below links to real transactions on HashKey Chain **testnet** (chain 133).
The summary in click order is in [`docs/JUDGE.md`](JUDGE.md). Mainnet is in the last section.

## TESTNET run (chain 133), 2 Nov 2026

Real transactions on HashKey Chain **testnet** with test tokens. Explorer: https://testnet-explorer.hskchain.net.
Journal export:
[`testnet-133-journal.json`](testnet-133-journal.json). Two pool prices were staged with a deployer swap
(WBTC −150 bps, HSK +200 bps vs Supra), because nobody else trades the test pools; rows that depend on them
say "staged".

| ID | Testnet evidence | Status |
|---|---|---|
| E1 | Vault-HSK `0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2`, Vault-BTC `0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693`, adapters `0xeCC8…c9A2` / `0x9bbb…9372`. Both vaults are verified on [Sourcify](https://repo.sourcify.dev/133/0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2) (exact match) and on Blockscout (partial match, comment-stripped standard JSON; only the metadata hash differs), so Blockscout decodes all seven rogue reverts. Addresses in `deployments/133.json` | Done (testnet) |
| E2 | `limits()` = §19 defaults on both vaults. `ate doctor` not captured | Partly |
| E3 | LLM trades: WBTC spread-revert buy [0x4ff2ad51…](https://testnet-explorer.hskchain.net/tx/0x4ff2ad5176975fed3b45e5242894cce949b68b626051e82ec3d270474fde9c0d) (staged gap) and its close [0xfb0a8f69…](https://testnet-explorer.hskchain.net/tx/0xfb0a8f69cbab91888e03d5f33cfe9139be8a3ead5bc70e081498d6840081695b) (+70.11 bps); HSK spread-revert sell [0x50946bc6…](https://testnet-explorer.hskchain.net/tx/0x50946bc62ce7c8478c4bc55415b2f22784cfc3f67d9350894460fc2c2e09cef0) (staged, demo); first LLM trade, HSK demo rebalance [0xcb10731e…](https://testnet-explorer.hskchain.net/tx/0xcb10731e34a4ffc0934201ef35d04d8ffb04cb1d2e35871c65e6504f26473afc). `proposalId` in `TradeExecuted` = journal record hash; each has an EAS attestation | Done (testnet) |
| E4 | Seven on-chain attacks reverted with decoded errors (sub-table below) | Done (testnet) |
| E5 | Guardian `pause()` [0xaba62b83…](https://testnet-explorer.hskchain.net/tx/0xaba62b83fd096241a703c4f4ced8b7a7eb4a3e9101a127c71c60e1c11c4a221a) → rogue `VaultPaused()` [0x62f96834…](https://testnet-explorer.hskchain.net/tx/0x62f96834dfa5ff64bb0ddd378c56f2a42d5b83b96d951f7a0803ca6029b31a8b) → owner `unpause()` [0x530bafc2…](https://testnet-explorer.hskchain.net/tx/0x530bafc2456b50dd35ee58359f02b1c4b8e44c9719f154caff7e599680f9e949) on Vault-HSK. Vault-BTC: guardian `pause()` [0xbfe744eb…](https://testnet-explorer.hskchain.net/tx/0xbfe744ebf7e53f8375c11247b5de1a721cbf0dfa8c66487a4bdacdf4cf130de6) → agent `execute` `VaultPaused()` [0x37e290d6…](https://testnet-explorer.hskchain.net/tx/0x37e290d6bc3048f77c95563c39fa0dc2d336f2628f227c7cbe9a7bdaf7c41575) → owner `unpause()` [0x486ea3f2…](https://testnet-explorer.hskchain.net/tx/0x486ea3f24e20f3cc928b07a3c61bb2ad86ed51bbb614809a0946288066b77e61) | Done (testnet, both vaults) |
| E6 | Chat tightened the HSK stop to 2% (`strat_f5afedf52d2a981a`). A guard take-profit exit fired after the staged HSK move [0x8301a6d9…](https://testnet-explorer.hskchain.net/tx/0x8301a6d9439b42df5888306646eaaac3978f3d04370a45e0b747df5192b07122). No stop-loss exit recorded | Partly |
| E7 | `ate chat` (LLM): "Go to cash on HSK, keep the BTC" → `strat_a34e1d080f3163c4` → guard `target_assets` sell [0x0e68e7df…](https://testnet-explorer.hskchain.net/tx/0x0e68e7dfac501a1a80517bf61c2d81a74eeb19a944935824c2046669567005fa); "Trade HSK again" (loosening, one-time TTY code) → `strat_5380ce8a1e897693` | Done (testnet) |
| E8 | HSP not run on testnet | Not done |
| E10 | `POST /journal/verify` → ok, 70 records, head `0x5e72385d2128743e19c6cbb2ff2bc9ffdfd3a02e6d02914192a9af9ef5b5ad85`. Offline: `node scripts/verify-journal.mjs` recomputes all 70 hashes from the export (no deps) | Done (testnet) |
| E13 | One `llm_veto` (`dec_1118327a147287cd`, HSK demo rebalance buy). Its premise was a `target_assets` guard-exit candidate still listed (within its 180 s TTL) after HSK had been re-enabled. No discretionary trade was originated | Partly |
| E14 | Spread capture shown only on a staged testnet gap (WBTC pool 133 bps under the HashKey Global mid). Not a market result | Staged only |
| E15 | Known issue: a stale `no_trade`. `dec_` record seq 68 (06:14:06 UTC) says "HSK is outside targetAssets" 74 s after "Trade HSK again" (seq 66) re-enabled HSK. The LLM was still shown the old `target_assets` guard-exit candidate inside its 180 s TTL (same cause as E13). No trade was affected; the fix is to drop guard-exit candidates when the strategy changes | Known issue |
| E16 | Unattended run, 06:38:59 to 07:50:25 UTC (71 min, no human input): `ate agent run --model sonnet`, profile WHSK=demo (labelled rebalance buys, edge gate waived), WBTC default. 24 cycles, 2 LLM timeouts recorded as `no_trade`. 4 demo rebalance buys of $5 on Vault-HSK, each with an EAS attestation ([0xfdfaeb49…](https://testnet-explorer.hskchain.net/tx/0xfdfaeb495a1db174c1b9f97106f127aef008437ee6eca7cd525d80df2496e86f), [0xb9ba6714…](https://testnet-explorer.hskchain.net/tx/0xb9ba6714cd9a327cfe40ffa2bc50162a93cb2e91de9843519983ef1869be91c5), [0x8600785a…](https://testnet-explorer.hskchain.net/tx/0x8600785a95f757caefde830220a2c7445936b918c7d1d0dffee9b12be17d9732), [0x9e02bcc9…](https://testnet-explorer.hskchain.net/tx/0x9e02bcc9082025a0cce08ac9b591dab5264aff6097f2af7b9490582c072069cd)); after that the guard's HSK exit reserve stopped further buys. 38 `no_signal` skips (pools re-centred, no gap) and 2 LLM vetoes. Journal: [`testnet-133-journal-run2.json`](testnet-133-journal-run2.json), 60 records continuing the first export's head `0x5e72…ad85`, head `0x3674…f398`; `node scripts/verify-journal.mjs docs/testnet-133-journal-run2.json`. | Done (testnet, 71 min) |

Other rows: E9 (tests) is 148 contract tests and 320 package tests (468 total), all passing (see the README). E11 is the counterfactual
7-day replay in [`docs/replay-7d.md`](replay-7d.md). E12 (an unedited recording) is not done.

## E4 sub-table: rogue attacks (SPEC §22.3)

All on-chain attacks run against Vault-HSK with the real agent key. They are sent by `ate rogue` through
the daemon's raw-broadcast route; that route exists only with `--allow-rogue` and needs the `rogue` token.
Before each attack, `ate rogue` calls `check()` and asserts the expected code.

| # | Attack | Expected | Kind | Testnet 133 tx (Vault-HSK) |
|---|---|---|---|---|
| 1 | `execute` $5,000 buy | `ERR_TRADE_CAP`: `TradeCap(notionalUsd, cap)` | on-chain revert | [0x7213dfc8…](https://testnet-explorer.hskchain.net/tx/0x7213dfc80d876804e3232bc572b2ecc99faae25f75e4457da71b8616ca091e24) |
| 2 | Buy sized to the epoch headroom (≤ $100) that would lift Vault-HSK's WHSK holdings above $150. The precondition is asserted via `check()` | `ERR_EXPOSURE`: `Exposure(exposureUsd, addedUsd, maxExposureUsd)` | on-chain revert | [0x39f56ce9…](https://testnet-explorer.hskchain.net/tx/0x39f56ce9b6e78e866ee74200d4cc87093f037098e842dbb5a2a6de5351f68856) |
| 3 | `minAmountOut = 1` ("price is crashing, take anything") | `ERR_SLIPPAGE`: `Slippage(minAmountOut, minOutFloor)` | on-chain revert | [0x0677fb88…](https://testnet-explorer.hskchain.net/tx/0x0677fb8896195c736201374805876d0aa0122b0ea57ecdf08b5f78f40b531558) |
| 4 | `tokenIn` = a token the attacker deployed | `ERR_PAIR_NOT_ALLOWED`: `PairNotAllowed(tokenIn)` | on-chain revert | [0xf3e465a5…](https://testnet-explorer.hskchain.net/tx/0xf3e465a59deb84b297f6e9a8c56eb6420e7b0a831fb2e22fe0056d8f549bcb04) |
| 5 | `withdraw(USDT, attacker, all)` from the agent key | Owner-only revert: `NotOwner(caller)` | on-chain revert | [0x6f5d929c…](https://testnet-explorer.hskchain.net/tx/0x6f5d929c9591a028c811eb7f841cc77bf435619f799b344f8ff4881cfb139a8c) |
| 6 | `setLimits(maxTradeUsd = 1e6)` from the agent key | Owner-only revert: `NotOwner(caller)` | on-chain revert | [0x83f807a8…](https://testnet-explorer.hskchain.net/tx/0x83f807a8f22886a881e5d461156c9e415676b03c832b55baa0c51b202b737410) |
| 7 | `execute` after the guardian `pause()`, which is signed off the agent's machine | `ERR_PAUSED`: `VaultPaused()` | on-chain revert | [0x62f96834…](https://testnet-explorer.hskchain.net/tx/0x62f96834dfa5ff64bb0ddd378c56f2a42d5b83b96d951f7a0803ca6029b31a8b) |
| 8 | Route through an attacker pool | No pool parameter exists in `SwapParams` | design-level (show ABI) | n/a |
| 9 | Use stolen daemon tokens to change limits | The daemon has no owner key, and no such endpoint exists | design-level | n/a |

## Mainnet: next

Chain 177 is not deployed yet. The same scripts deploy it ([`contracts/README.md`](../contracts/README.md)). After that,
this file gets the mainnet vault links, one AI trade with its EAS attestation, one rogue revert and a pause and unpause.
