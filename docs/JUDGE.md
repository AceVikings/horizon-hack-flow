# ATE: verification links, in click order

## TESTNET run (HashKey Chain testnet, chain ID 133), 2 Nov 2026

Everything in this section is on **testnet** with test tokens (tUSDT, tWHSK, tWBTC). Explorer:
https://testnet-explorer.hskchain.net. Addresses: [`deployments/133.json`](../deployments/133.json). Journal export (70 full records, including
the hashed `context`): [`docs/testnet-133-journal.json`](testnet-133-journal.json). Recompute every record hash, id,
`rationaleHash` and the chain head offline, with no install: `node scripts/verify-journal.mjs` (prints
`ok: 70 records … head 0x5e72…ad85`; edit any field and it names the record that no longer hashes). Mainnet (chain 177) is next; its
placeholders are further down.

The testnet pools have no other traders. Two price conditions in this run were staged with a deployer swap
([`RecenterTestnetPool.s.sol`](../contracts/script/RecenterTestnetPool.s.sol) with `OFFSET_BPS`), and both
pools were put back to the Supra price afterwards:

| Staged condition | Swap | Undone by |
|---|---|---|
| tWBTC/tUSDT pool 150 bps below Supra (about 133 bps below the HashKey Global mid) | [0x1b57bfbb…](https://testnet-explorer.hskchain.net/tx/0x1b57bfbbb3fc185da9676d126aaefa6b3377541e822e4d954424748cb0c676f7) | [0x4130903b…](https://testnet-explorer.hskchain.net/tx/0x4130903bf64348ade2886f636fa23d4da13538e4274c15a92a4f2fa63f2b5154) |
| tWHSK/tUSDT pool 200 bps above Supra | [0xafe25624…](https://testnet-explorer.hskchain.net/tx/0xafe25624e1fc2f3e3b74856c8fe5ebb308f606080a574a9dadf2df44cf09ea70) | [0x0b405242…](https://testnet-explorer.hskchain.net/tx/0x0b40524218c3684fef221430da99ef3360df593571078c7bc8765eda391e72b5) |

### 1. Both vaults

- Vault-HSK (tWHSK/tUSDT): https://testnet-explorer.hskchain.net/address/0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2?tab=contract
- Vault-BTC (tWBTC/tUSDT): https://testnet-explorer.hskchain.net/address/0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693?tab=contract
- Supra adapters: https://testnet-explorer.hskchain.net/address/0xeCC8Fe21c7C0D39988856b6B67860bAe55A8c9A2?tab=contract (pair 517) and
  https://testnet-explorer.hskchain.net/address/0x9bbb840B9e1086177507D958E40668f3cEF99372?tab=contract (pair 0)

Same `PolicyVault` source as mainnet (Sourcify exact match; Blockscout verified, partial match). `limits()` on the Read tab: $100 per trade,
$250 per epoch, $150 exposure, 250 bps slippage and deviation, 60 s cooldown. `agent()` is
`0xC11C…4f8a`, `guardian()` is `0x8aAc…db66B`, `owner()` is the deployer `0xFF7D…569e`.

### 2. LLM-decided trades (Claude Sonnet via `ate agent run`), with EAS attestation

| Trade | `TradeExecuted` tx | EAS attestation tx (UID) | Journal |
|---|---|---|---|
| WBTC `spread-revert` buy, $25, pool 132.94 bps under the CEX mid, net edge 68.94 bps (staged gap, `profile=default`) | [0x4ff2ad51…](https://testnet-explorer.hskchain.net/tx/0x4ff2ad5176975fed3b45e5242894cce949b68b626051e82ec3d270474fde9c0d) | [0x1f042937…](https://testnet-explorer.hskchain.net/tx/0x1f042937320537b9e3b749d327eb2648613aeb1c6319a476f48341bba0a798f8) (`0x19717178…65f9`) | `prop_9003b7300ff281d2` |
| WBTC `spread-revert` close of that lot, +70.11 bps net (after the pool was put back) | [0xfb0a8f69…](https://testnet-explorer.hskchain.net/tx/0xfb0a8f69cbab91888e03d5f33cfe9139be8a3ead5bc70e081498d6840081695b) | [0x60021411…](https://testnet-explorer.hskchain.net/tx/0x60021411d2be15f55672cc454b222ee6172383679c8da3c12c783d40fca2adfd) (`0xebbd1e49…90fe`) | `prop_659d9e01ded2ce11` |
| HSK `spread-revert` sell, pool 219 bps over the CEX mid, net 148 bps (staged gap, `profile=demo`) | [0x50946bc6…](https://testnet-explorer.hskchain.net/tx/0x50946bc62ce7c8478c4bc55415b2f22784cfc3f67d9350894460fc2c2e09cef0) | [0x6ae259d9…](https://testnet-explorer.hskchain.net/tx/0x6ae259d94056d9857539c16a31c99b21ca2ef8b525ee08ce044d98d7bd9820d3) (`0x556a6c77…2e5c`) | `prop_369f0d42d9031e02` |
| First LLM trade: HSK `rebalance` buy, $5, `profile=demo` (edge gate waived, not arbitrage) | [0xcb10731e…](https://testnet-explorer.hskchain.net/tx/0xcb10731e34a4ffc0934201ef35d04d8ffb04cb1d2e35871c65e6504f26473afc) | [0x709d2696…](https://testnet-explorer.hskchain.net/tx/0x709d2696a927c5bcdaff15e68c798a25bd559476b78b00d188639a3ffaf9eb0b) (`0x7b766861…1cce6`) | `prop_9d63f77f3d7e4e79` |

What you should see:

- The `TradeExecuted` log carries `proposalId` = the journal record hash. For the WBTC buy that is
  `0x9003b730…41087`, the `hash` of `prop_9003b7300ff281d2` in the journal export.
- The EAS attestation (schema `0x1c0c01e3…a04f`) has the vault as recipient, the agent as attester, and its
  data starts with the same `proposalId`.
- Decisions without a trade are journalled too. `no_trade` (`no_signal`) on WBTC: `dec_d43ba09ed5979683`.
  LLM veto of the HSK demo rebalance buy: `dec_1118327a147287cd` (`reason=llm_veto`).

### 3. Rogue agent: every on-chain attack reverts

`ate rogue` sent each attack with the real agent key to Vault-HSK. Each tx is a failed `execute`,
`withdraw` or `setLimits` from the agent:

| Attack | Decoded error | Tx |
|---|---|---|
| $5,000 buy | `TradeCap(500000000000, 10000000000)` | [0x7213dfc8…](https://testnet-explorer.hskchain.net/tx/0x7213dfc80d876804e3232bc572b2ecc99faae25f75e4457da71b8616ca091e24) |
| $99 buy over the $150 exposure cap | `Exposure(10056381199, 10153846154, 15000000000)` | [0x39f56ce9…](https://testnet-explorer.hskchain.net/tx/0x39f56ce9b6e78e866ee74200d4cc87093f037098e842dbb5a2a6de5351f68856) |
| $5 buy with `minAmountOut = 1` | `Slippage(1, 55601155408110736145)` | [0x0677fb88…](https://testnet-explorer.hskchain.net/tx/0x0677fb8896195c736201374805876d0aa0122b0ea57ecdf08b5f78f40b531558) |
| Attacker token as `tokenIn` | `PairNotAllowed(0x7E5F…5Bdf)` | [0xf3e465a5…](https://testnet-explorer.hskchain.net/tx/0xf3e465a59deb84b297f6e9a8c56eb6420e7b0a831fb2e22fe0056d8f549bcb04) |
| `withdraw` all tUSDT to the attacker | `NotOwner(0xC11C…4f8a)` | [0x6f5d929c…](https://testnet-explorer.hskchain.net/tx/0x6f5d929c9591a028c811eb7f841cc77bf435619f799b344f8ff4881cfb139a8c) |
| `setLimits(maxTradeUsd = 1e6)` | `NotOwner(0xC11C…4f8a)` | [0x83f807a8…](https://testnet-explorer.hskchain.net/tx/0x83f807a8f22886a881e5d461156c9e415676b03c832b55baa0c51b202b737410) |

For the exposure attack the owner first minted ~$100 of tWHSK into Vault-HSK
([0x0fa09b5b…](https://testnet-explorer.hskchain.net/tx/0x0fa09b5b00a9743a84e6f82c3626c59301e6c560a39b3275f1ecdf6f6be2c555)), because the trader had sold its tWHSK.

### 4. Guardian pause and owner unpause (both vaults)

| Step | Tx |
|---|---|
| Guardian `pause()` (from `0x8aAc…db66B`) | [0xaba62b83…](https://testnet-explorer.hskchain.net/tx/0xaba62b83fd096241a703c4f4ced8b7a7eb4a3e9101a127c71c60e1c11c4a221a) |
| Rogue `execute` after the pause → `VaultPaused()` (`ERR_PAUSED`) | [0x62f96834…](https://testnet-explorer.hskchain.net/tx/0x62f96834dfa5ff64bb0ddd378c56f2a42d5b83b96d951f7a0803ca6029b31a8b) |
| Owner `unpause()` (from `0xFF7D…569e`) | [0x530bafc2…](https://testnet-explorer.hskchain.net/tx/0x530bafc2456b50dd35ee58359f02b1c4b8e44c9719f154caff7e599680f9e949) |

The next trader cycle after the unpause closed the WBTC lot (section 2, row 2).

Vault-BTC, same sequence (after the trader run, 06:36 to 06:37 UTC):

| Step | Tx |
|---|---|
| Guardian `pause()` (from `0x8aAc…db66B`) | [0xbfe744eb…](https://testnet-explorer.hskchain.net/tx/0xbfe744ebf7e53f8375c11247b5de1a721cbf0dfa8c66487a4bdacdf4cf130de6) |
| Agent `execute` of a $5 tUSDT buy while paused → `VaultPaused()` (`ERR_PAUSED`; `check()` returned reason 1 first) | [0x37e290d6…](https://testnet-explorer.hskchain.net/tx/0x37e290d6bc3048f77c95563c39fa0dc2d336f2628f227c7cbe9a7bdaf7c41575) |
| Owner `unpause()` (from `0xFF7D…569e`) | [0x486ea3f2…](https://testnet-explorer.hskchain.net/tx/0x486ea3f24e20f3cc928b07a3c61bb2ad86ed51bbb614809a0946288066b77e61) |

### 5. Chat and the guard

| Event | Record / tx |
|---|---|
| Chat: "Tighten the HSK stop-loss to 2%." (tightening, applied at once) | `strat_f5afedf52d2a981a` (`actor=human, via=chat`) |
| Chat: "Go to cash on HSK, keep the BTC." → guard `target_assets` sell | `strat_a34e1d080f3163c4`, sell [0x0e68e7df…](https://testnet-explorer.hskchain.net/tx/0x0e68e7dfac501a1a80517bf61c2d81a74eeb19a944935824c2046669567005fa) |
| Chat: "Trade HSK again." (loosening, approved with the daemon's one-time TTY code) | `strat_5380ce8a1e897693` |
| Guard take-profit on HSK (+159 bps, after the staged HSK move) | [0x8301a6d9…](https://testnet-explorer.hskchain.net/tx/0x8301a6d9439b42df5888306646eaaac3978f3d04370a45e0b747df5192b07122) |

---

## Mainnet (chain 177): next

Chain: HashKey Chain mainnet, chain ID 177. Explorer: https://hsk.blockscout.com. Not deployed yet.

Fill in the placeholders after deploy, from `deployments/177.json` and `docs/evidence.md`. The full
evidence pack is in `docs/evidence.md`.

### 1. Both vaults on Blockscout (verified source and immutables)

- Vault-HSK (WHSK/USDT): https://hsk.blockscout.com/address/<VAULT_HSK_ADDRESS>?tab=contract
- Vault-BTC (WBTC/USDT): https://hsk.blockscout.com/address/<VAULT_BTC_ADDRESS>?tab=contract
- Supra adapters: https://hsk.blockscout.com/address/<ADAPTER_HSK_ADDRESS>?tab=contract and
  https://hsk.blockscout.com/address/<ADAPTER_BTC_ADDRESS>?tab=contract

What you should see:

- Both vaults show verified `PolicyVault` source, compiled from the same source and creation code.
- Each vault's immutables (`quoteToken`, `priceToken`, `oracle`, `router`, `pool`, `factory`,
  `priceDecimals`) are fixed at deploy, and only those immutables differ between the two vaults.
- `oracle` is the market's `SupraAggregatorAdapter`: pair 517 for HSK, pair 0 for BTC.

### 2. `limits()` reads

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

### 3. LLM-decided trades, with EAS attestation and journal record

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

### 4. One decoded rogue revert (the `ERR_SLIPPAGE` buy)

- https://hsk.blockscout.com/tx/<TX_ROGUE_SLIPPAGE>

What you should see:

- A reverted `execute` on Vault-HSK, sent from the agent key by `ate rogue`. The rogue client is a
  separate Claude Code session over stdio.
- The trade is a $5 buy, well under every cap, with `minAmountOut = 1`.
- It reverts with the decoded custom error `Slippage(minAmountOut, minOutFloor)`: the vault's
  oracle-anchored floor refused it.
- The other attacks are in `docs/evidence.md`, row E4.

### 5. Guardian pause and owner unpause

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
