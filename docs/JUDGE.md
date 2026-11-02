# ATE: judge verification (five links, in click order)

Chain: HashKey Chain mainnet, chain ID 177. Explorer: https://hsk.blockscout.com

Fill in the placeholders after deploy, from `deployments/177.json` and `docs/evidence.md`. The full
evidence pack is in `docs/evidence.md`.

## 1. Both vaults on Blockscout (verified source and immutables)

- Vault-HSK (WHSK/USDT): https://hsk.blockscout.com/address/<VAULT_HSK_ADDRESS>?tab=contract
- Vault-BTC (WBTC/USDT): https://hsk.blockscout.com/address/<VAULT_BTC_ADDRESS>?tab=contract
- Supra adapters: https://hsk.blockscout.com/address/<ADAPTER_HSK_ADDRESS>?tab=contract and
  https://hsk.blockscout.com/address/<ADAPTER_BTC_ADDRESS>?tab=contract

What you should see:

- Both vaults show verified `PolicyVault` source, compiled from the same source and creation code.
- Each vault's immutables (`quoteToken`, `priceToken`, `oracle`, `router`, `pool`, `factory`,
  `priceDecimals`) are fixed at deploy, and only those immutables differ between the two vaults.
- `oracle` is the market's `SupraAggregatorAdapter`: pair 517 for HSK, pair 0 for BTC.

## 2. `limits()` reads

- https://hsk.blockscout.com/address/<VAULT_HSK_ADDRESS>?tab=read_contract
- https://hsk.blockscout.com/address/<VAULT_BTC_ADDRESS>?tab=read_contract
- `LimitsUpdated` txs: https://hsk.blockscout.com/tx/<TX_SETLIMITS_HSK> and
  https://hsk.blockscout.com/tx/<TX_SETLIMITS_BTC>

What you should see from `limits()`:

| Field | Expected value | Meaning |
|---|---|---|
| `maxTradeUsd` | 100e8 | $100 per trade |
| `maxEpochUsd` | 250e8 | $250 per epoch |
| `maxExposureUsd` | 150e8 | $150 exposure cap |
| `epochDuration` | 86400 | |
| `maxSlippageBps` | 250 | |
| `maxOracleDeviationBps` | 250 | |
| `maxExitDiscountBps` | 500 | |
| `maxOracleAge` | 90000 | |
| `cooldown` | 60 | |

Also check:

- `agent()` and `guardian()`: the same agent on both vaults.
- `owner()`: never the agent.
- `paused()`: false.

## 3. LLM-decided trades, with EAS attestation and journal record

| Trade | `TradeExecuted` tx | EAS attestation |
|---|---|---|
| WBTC spread-revert (E14) | https://hsk.blockscout.com/tx/<TX_E14_WBTC_SPREAD_REVERT> | https://hsk.easscan.org/attestation/view/<EAS_UID_E14> (or the EAS contract `0x4200…0021` read for `<EAS_UID_E14>`) |
| Discretionary | https://hsk.blockscout.com/tx/<TX_DISCRETIONARY> | <EAS_UID_DISCRETIONARY> |

Journal records: <JOURNAL_RECORD_E14>, <JOURNAL_RECORD_DISCRETIONARY>.

On-stage veto or size-down record, with its +30 min outcome: <JOURNAL_RECORD_VETO>.

What you should see:

- `TradeExecuted` carries a `proposalId` equal to the journal record hash, and a `rationaleHash`.
- The EAS attestation resolves to the same `proposalId`, `rationaleHash` and `txHash`.
- The journal record shows `engine=llm`, the market, the generator or `origin=discretionary` with its
  thesis, and `approvedBy=policy`.

Earlier labelled entries:

- Smoke trade: <TX_SMOKE> / <EAS_UID_SMOKE>, labelled `smoke`, `engine=rules`. It is not Track 1 evidence.
- First LLM trade: <TX_FIRST_LLM>.

## 4. One decoded rogue revert (the `ERR_SLIPPAGE` buy)

- https://hsk.blockscout.com/tx/<TX_ROGUE_SLIPPAGE>

What you should see:

- A reverted `execute` on Vault-HSK, sent from the agent key by `ate rogue`. The rogue client is a
  separate Claude Code session over stdio.
- The trade is a $5 buy, well under every cap, with `minAmountOut = 1`.
- It reverts with the decoded custom error `Slippage(minAmountOut, minOutFloor)`: the vault's
  oracle-anchored floor refused it.
- The other attacks are in `docs/evidence.md`, row E4.

## 5. Guardian pause and owner unpause

| Event | Vault-HSK | Vault-BTC |
|---|---|---|
| Guardian `Paused` | https://hsk.blockscout.com/tx/<TX_GUARDIAN_PAUSE_HSK> | https://hsk.blockscout.com/tx/<TX_GUARDIAN_PAUSE_BTC> |
| Rogue `execute` after the pause | https://hsk.blockscout.com/tx/<TX_ROGUE_AFTER_PAUSE> | |
| Owner `Unpaused` | https://hsk.blockscout.com/tx/<TX_OWNER_UNPAUSE_HSK> | https://hsk.blockscout.com/tx/<TX_OWNER_UNPAUSE_BTC> |

The trader's next journal row after the unpause: <JOURNAL_RECORD_AFTER_UNPAUSE>.

What you should see:

- The pause is signed by the guardian, from off the agent's machine.
- The rogue `execute` sent after it reverts `VaultPaused()` (`ERR_PAUSED`).
- Only the owner, from the second device, can unpause.

## Also linked

| Item | Link |
|---|---|
| Full 60 s unedited cycle recording (E12) | <E12_RECORDING_URL> |
| WBTC snapshots: 03:50 IST Nov 2 and trader start (~14:00) | <SNAPSHOT_0350_URL>, <SNAPSHOT_TRADER_START_URL> |
| HSK-Superpowers `agent-policy-vault` skill PR | <SKILL_PR_URL> |
| Ecosystem directory listing request | <DIRECTORY_REQUEST_URL> |
| Counterfactual 7-day replay (E11) | `docs/replay-7d.md` |

## Appendix: positioning searches

These are the searches behind the claim "no oracle-checked agent policy contract found on HashKey Chain as
of Nov 2":

- Blockscout verified-contract search: <BLOCKSCOUT_SEARCH_URL>
- HashKey ecosystem directory search: <DIRECTORY_SEARCH_URL>
