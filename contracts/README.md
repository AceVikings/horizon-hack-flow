# ATE contracts — `PolicyVault`

Foundry project for SPEC v0.8.0 §4. Solidity 0.8.24, OpenZeppelin v5.1.0, `forge-std`.

```
src/PolicyVault.sol            the vault (one per market; immutable pair/oracle/pool/router/factory)
src/PolicyVaultTypes.sol       Limits, SwapParams, reason codes, IPolicyVault (events + custom errors)
src/interfaces/IExternal.sol   AggregatorV3, V3 pool/factory subset, SwapRouter02 (7-field, no deadline)
src/libraries/TickMath.sol     getSqrtPriceAtTick, vendored from Uniswap v4-core (MIT)
src/oracles/SupraAggregatorAdapter.sol  AggregatorV3 view over a Supra S-Value pair (the vault's oracle on 177)
script/DeployConfig.sol        chain-177 addresses (§0.2) + §19 step 3 default limits
script/Deploy.s.sol            deploys Vault-HSK and Vault-BTC, setLimits, setAgent, setGuardian
test/PolicyVault.t.sol         reason codes 1–15 × both directions × both shapes, parity, exit path, rounding
test/SupraAdapter.t.sol        adapter scaling (18/8/6 dp), ms->s, unpopulated pair -> ORACLE_INVALID, vault on adapter
test/Admin.t.sol               I5 owner-only matrix, two-step ownership, pause roles, bounds, constructor checks, TickMath
test/invariant/                I1–I7, I9–I13 handler fuzzing (6 actors), both shapes
test/fork/ForkSmoke.t.sol      real factory/pools/SwapRouter02/Supra/APRO on a fork of 177 (opt-in)
ABI-NOTES.md                   ABI vs packages/core/src/abi/policyVault.ts; oracle source (Supra adapter, APRO access)
```

## Build and test

```sh
cd contracts
forge build
forge test                        # unit + invariant (runs=64, depth=32); fork test is skipped
forge test --mt invariant -vv     # invariants only
FOUNDRY_PROFILE=demoday forge test --mt invariant   # runs=500, depth=100
forge test --mt test_gas_execute -vv                # gas per execute on mocks
```

Every unit and invariant suite runs twice: once for the 18-dp priceToken shape (`*_WHSK18`) and once for the
8-dp shape (`*_WBTC8`).

## Fork smoke (pre-deploy, §18.2)

The test is opt-in because the public RPC rate-limits. Run it on a pinned block so the RPC cache in
`~/.foundry/cache/rpc/177/<block>` is reused:

```sh
FORK_SMOKE=true FOUNDRY_COMPUTE_UNITS_PER_SECOND=60 \
  forge test --match-path test/fork/ForkSmoke.t.sol -vv -j 1
# env: HSK_RPC (default https://mainnet.hsk.xyz), FORK_BLOCK (default 29623000; 0 = latest)
```

The test functions:

- `test_fork_supra_vault{Hsk,Btc}` (the production path). Each vault runs on a `SupraAggregatorAdapter`
  (HSK pair 517, BTC pair 0), with no APRO access granted. The test:
  1. Runs the constructor asserts against the real contracts.
  2. Calls `observe([300,0])`.
  3. Funds the vault with `deal()`.
  4. Checks a $5,000 buy (`TRADE_CAP`).
  5. Executes a $5 buy, comparing it with QuoterV2.
  6. Executes a $5 sell.
  7. Executes a forced-deviation exit sell (7b), with Supra mocked 3 % above the pool.
  8. Pauses the vault.
- `test_fork_apro_vault{Hsk,Btc}` runs the same flow on APRO. It shows `check()` returning 6 before `addAccess`.
- `test_fork_supra_pullRefresh` submits a real DORA proof through the permissionless `verifyOracleProof`. It is
  opt-in:

```sh
P=$(curl -s -X POST https://rpc-mainnet-dora-2.supra.com/get_proof -H 'Content-Type: application/json' \
      -d '{"pair_indexes":[0,517],"chain_type":"evm"}' | python3 -c 'import json,sys;print("0x"+json.load(sys.stdin)["proof_bytes"])')
FORK_SMOKE=true SUPRA_PROOF_HEX=$P SUPRA_PROOF_NOW=$(date +%s) \
  forge test --match-path test/fork/ForkSmoke.t.sol --mt pullRefresh -vv
```

If `FORK_SMOKE` is unset or the RPC is unreachable, the test is skipped.

To dry-run the deploy script against a fork (no broadcast):

```sh
AGENT=0x… GUARDIAN=0x… forge script script/Deploy.s.sol:Deploy \
  --fork-url https://mainnet.hsk.xyz --fork-block-number 29623000 --compute-units-per-second 60
```

## Deploy (mainnet 177, §19 steps 1, 3, 4)

For each market the script deploys a `SupraAggregatorAdapter`, then the vault with `oracle = adapter`. Set
`ORACLE_SOURCE=apro` to use the APRO feed directly, but only if APRO has allow-listed the vault address.

Run this from the owner's second device, signing with a Ledger or an encrypted keystore. Never use
`--private-key`.

```sh
AGENT=<agent EOA> GUARDIAN=<guardian EOA> \
forge script script/Deploy.s.sol:Deploy --rpc-url hsk --ledger --sender <owner> --broadcast
# or: --account owner --sender <owner>
# MARKETS=hsk|btc|both (default both). Limit overrides: MAX_TRADE_USD, MAX_EPOCH_USD, MAX_EXPOSURE_USD
# (8-dp USD; e.g. MAX_EXPOSURE_USD=6000000000 for the $60 smaller-seed fallback), EPOCH_DURATION,
# MAX_SLIPPAGE_BPS, MAX_ORACLE_DEVIATION_BPS, MAX_EXIT_DISCOUNT_BPS, MAX_ORACLE_AGE, COOLDOWN.
```

Default limits: `maxTradeUsd = 100e8`, `maxEpochUsd = 250e8`, `maxExposureUsd = 150e8`, `epochDuration = 86400`,
slippage 250 bps, deviation 250 bps, exit discount 500 bps, `maxOracleAge = 90000` s, `cooldown = 60` s.
The script prints each vault address and its ABI-encoded constructor args. Record both in
`deployments/177.json`.

No allow-listing is needed. If a Supra pair gets stale, the daemon refreshes it with a pull proof (ABI-NOTES.md,
"Daemon refresh path").

## Testnet (133)

`script/DeployTestnet.s.sol` deploys the full stack on HashKey Chain testnet. It creates test tokens (`src/testnet/TestToken.sol`) and HSKSwap pools, then deploys the adapters, vaults, seeds and the EAS schema, and writes `deployments/133.json`. For the addresses, the token `faucet()`, and how to run the daemon and trader on 133, see [docs/TESTNET.md](../docs/TESTNET.md).

## Verify on Blockscout

Verify each adapter (`src/oracles/SupraAggregatorAdapter.sol:SupraAggregatorAdapter`, using the adapter
constructor-args the script prints) and each vault separately. The immutables differ, so Blockscout may label the second one a "similar match".

```sh
forge verify-contract <vault> src/PolicyVault.sol:PolicyVault \
  --chain-id 177 --verifier blockscout --verifier-url https://hsk.blockscout.com/api/ \
  --compiler-version 0.8.24 --num-of-optimizations 200 --evm-version cancun \
  --constructor-args <hex printed by Deploy.s.sol>
# or rebuild the args:
#   cast abi-encode "c(address,address,address,address,address,address)" \
#     <USDT> <WHSK|WBTC> <adapter> <SwapRouter02> <pool> <factory>
```

`foundry.toml` has `[etherscan] hsk` without `chain = 177`; with that key, forge fails with
"Chain 177 not supported".
