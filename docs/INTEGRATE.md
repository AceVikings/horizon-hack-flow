# Integrating PolicyVault with your own pool and agent

This guide covers reusing ATE's `PolicyVault` and `SupraAggregatorAdapter` to put your own agent behind an
on-chain bound, on a different HSKSwap pool. All of it is Apache-2.0 and unaudited (see `SECURITY.md`).
The two v0.1 market configurations (WHSK/USDT and WBTC/USDT, see `contracts/script/DeployConfig.sol`) are the worked examples. Status: they are not yet deployed on mainnet (chain 177); a testnet (chain 133) deployment is in progress and the mainnet deployment follows.

## 1. Does your pool qualify?

The vault supports exactly one market shape in v0.1, and the constructor reads and asserts it. A wrong
shape reverts `ConstructorCheck(which)`, except a zero address, which reverts `ZeroAddress()`.

| Requirement | Code |
|---|---|
| No constructor argument is `address(0)` | `ZeroAddress()` |
| `factory.getPool(quoteToken, priceToken, pool.fee()) == pool` | 1 |
| `pool.factory() == factory` | 2 |
| `pool.token0() == priceToken` and `pool.token1() == quoteToken`. The price token must sort below the stable | 3 |
| `priceToken.decimals()` is 8 or 18 | 4 |
| `quoteToken.decimals() == 6` (a USD stable, valued at $1) | 5 |
| `router.factory() == factory` | 6 |
| `router.positionManager()` static-call succeeds (SwapRouter02 only: the 7-field `exactInputSingle`, no deadline; the vault enforces `deadline` itself) | 7 |
| `oracle.decimals() == 8` (an AggregatorV3-shaped USD feed for the price token) | 8 |

Other orientations, other decimals and other venues are v1.0.

The oracle must also be readable by a contract. APRO feeds on 177 are not readable by contracts: they
return "No access" to any reader except an EOA (see `contracts/ABI-NOTES.md`). Use a
`SupraAggregatorAdapter` over the token's Supra pair instead. The adapter:

- is stateless, ownerless and has `decimals() == 8`;
- rounds down;
- caps `updatedAt` at `block.timestamp`;
- returns zeros for an unpopulated pair, which the vault rejects as `ERR_ORACLE_INVALID`.

Supra pairs used in v0.1: BTC/USD = 0 and HSK/USD = 517. Before deploying, check that your pair is
populated on 177 by calling `getSvalue(pair)` on the storage contract `0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57`.

The deviation guard needs a pool TWAP: `observe([300, 0])` must succeed, so make sure
`observationCardinality` is 64 or more.

Constructor signatures:

```solidity
SupraAggregatorAdapter(address supraStorage, uint256 pairIndex, string description)
PolicyVault(address quoteToken, address priceToken, address oracle, address router, address pool, address factory)
```

## 2. Deploy

`contracts/script/Deploy.s.sol` deploys the market entries defined in `contracts/script/DeployConfig.sol`.
For each market it does these steps in order:

1. Deploys the adapter, `new SupraAggregatorAdapter(SUPRA_STORAGE, m.supraPair, m.supraDescription)`.
2. Deploys the vault, `new PolicyVault(m.quoteToken, m.priceToken, adapter, m.router, m.pool, m.factory)`.
3. Calls `setLimits`.
4. Calls `setAgent` if `AGENT` is set.
5. Calls `setGuardian` if `GUARDIAN` is set.

The broadcaster becomes `owner`. The script prints the vault address, the adapter address and both sets
of ABI-encoded constructor args, which you need for verification.

v0.1 limitation: `MARKETS` accepts only `hsk`, `btc` or `both`. Those are the two entries in
`DeployConfig.sol`. To deploy another pool, add a `DeployConfig.Market` for it and a matching branch in
`Deploy.run()`.

These are the `DeployConfig.Market` fields:

| Field | Value for your pool |
|---|---|
| `name` | Market id, for example `hsk-dex:FOO/USDT:3000` (for logs) |
| `quoteToken` | The 6-dp USD stable (`token1`), for example USDT `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` |
| `priceToken` | The 8- or 18-dp token (`token0`) |
| `oracle` | An APRO-style AggregatorV3 feed, used as the vault oracle only with `ORACLE_SOURCE=apro` and only if the feed allow-lists the vault. With the default Supra source this field is ignored |
| `router` | `DeployConfig.SWAP_ROUTER02` (`0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3`) |
| `pool` | Your HSKSwap V3 pool |
| `factory` | `DeployConfig.FACTORY` (`0x972cA9D1662F5e029cD18327D29026532E84c742`) |
| `supraPair` | Your token's Supra pair index |
| `supraDescription` | For example `"FOO/USD (Supra pair N)"` |

For example, with a `foo()` entry added the same way as `hsk()` and `btc()`, the deploy is one command.
Sign with a Ledger or an encrypted keystore, never `--private-key`:

```sh
cd contracts
forge test                                   # all green first
AGENT=<agent EOA> GUARDIAN=<guardian EOA> MARKETS=foo \
  forge script script/Deploy.s.sol:Deploy --rpc-url hsk --ledger --sender <owner> --broadcast
# or --account owner --sender <owner>
```

Dry-run it on an Anvil fork first. Omit `--broadcast` and use a fork URL. The public RPC rate-limits, so
`https://177.rpc.thirdweb.com` is a good fork source:

```sh
AGENT=0x… GUARDIAN=0x… MARKETS=foo forge script script/Deploy.s.sol:Deploy \
  --fork-url https://177.rpc.thirdweb.com --compute-units-per-second 60
```

Verify the adapter and the vault separately on Blockscout. The commands are in `contracts/README.md`,
section "Verify on Blockscout".

## 3. Set limits

`setLimits` is owner-only. The script sets the defaults below; override any of them with the env var shown.
USD values are 8-dp integers.

| Field | Default | Env override | Bound enforced by `setLimits` (`InvalidLimits(field)`) |
|---|---|---|---|
| `maxTradeUsd` | `100e8` | `MAX_TRADE_USD` | 0 means disallow |
| `maxEpochUsd` | `250e8` | `MAX_EPOCH_USD` | |
| `maxExposureUsd` | `150e8` | `MAX_EXPOSURE_USD` | checked before and after every buy |
| `epochDuration` | `86400` | `EPOCH_DURATION` | > 0 |
| `maxSlippageBps` | `250` | `MAX_SLIPPAGE_BPS` | ≤ 1000 |
| `maxOracleDeviationBps` | `250` | `MAX_ORACLE_DEVIATION_BPS` | ≤ 1000 |
| `maxExitDiscountBps` | `500` | `MAX_EXIT_DISCOUNT_BPS` | `maxOracleDeviationBps` ≤ x ≤ 2000 |
| `maxOracleAge` | `90000` | `MAX_ORACLE_AGE` | 300 ≤ x ≤ 172800 |
| `cooldown` | `60` | `COOLDOWN` | |

To change limits later, use `cast send` from the owner's device (not the agent's machine):

```sh
cast send <vault> "setLimits((uint128,uint128,uint128,uint32,uint16,uint16,uint16,uint32,uint32))" \
  "(10000000000,25000000000,15000000000,86400,250,250,500,90000,60)" --rpc-url hsk --ledger
```

To fund the vault, transfer the quote token and/or the price token to the vault address. Only the owner
can `withdraw`.

Set `maxOracleAge` above your Supra pair's push interval. About 6 h on 177 is typical, or 0.5 % on a move.
If you cannot do that, refresh on demand: anyone can submit a DORA proof to `verifyOracleProof` on
`0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD` (see `contracts/ABI-NOTES.md`, "Daemon refresh path").

## 4. Call `check()` before `execute()`

`check(caller, p)` is a view that evaluates the same rules, in the same order, as `execute(p, rationaleHash)`.
It returns the same first failing reason, the same `minOutFloor` and the same `exitPath`.

The recommended agent loop:

1. Build `SwapParams { tokenIn, amountIn, minAmountOut, deadline, proposalId }`. `tokenIn` must be the
   quote or price token; the other one is `tokenOut`. There is no pool or router parameter.
2. Call `check(agent, p)`. It returns `(reason, notionalUsd, oraclePrice, minOutFloor, exitPath)`. Proceed
   only on `reason == 0`.
3. Set `minAmountOut >= minOutFloor`. ATE's daemon uses `max(minOutFloor, quote × 0.995)`, re-quoted at
   execute time.
4. Send `execute(p, rationaleHash)` from the agent key. Proceeds stay in the vault.

```sh
cast call <vault> "check(address,(address,uint256,uint256,uint256,bytes32))(uint8,uint256,uint256,uint256,bool)" \
  <agent> "(<tokenIn>,<amountIn>,<minAmountOut>,<deadline>,<proposalId>)" --rpc-url hsk
```

Reason codes and the custom errors `execute()` reverts with are defined in
`contracts/src/PolicyVaultTypes.sol`. The TS mirror is `packages/core/src/abi/policyVault.ts`.

| Code | `check()` reason | `execute()` custom error |
|---|---|---|
| 0 | `OK` | n/a |
| 1 | `ERR_PAUSED` | `VaultPaused()` |
| 2 | `ERR_NOT_AGENT` | `NotAgent(address caller)` |
| 3 | `ERR_ZERO_AMOUNT` | `ZeroAmount()` |
| 4 | `ERR_DEADLINE` | `DeadlineExpired(uint256 deadline, uint256 timestamp)` |
| 5 | `ERR_PAIR_NOT_ALLOWED` | `PairNotAllowed(address tokenIn)` |
| 6 | `ERR_ORACLE_INVALID` | `OracleInvalid(int256 answer, uint256 updatedAt)` |
| 7 | `ERR_ORACLE_STALE` | `OracleStale(uint256 updatedAt, uint32 maxOracleAge)` |
| 8 | `ERR_ORACLE_DEVIATION` | `OracleDeviation(uint256 spot, uint256 twap, uint256 oracle, uint16 maxOracleDeviationBps)` |
| 9 | `ERR_TRADE_CAP` | `TradeCap(uint256 notionalUsd, uint256 cap)` |
| 10 | `ERR_EPOCH_CAP` | `EpochCap(uint256 spentUsd, uint256 notionalUsd, uint256 cap)` |
| 11 | `ERR_COOLDOWN` | `Cooldown(uint256 lastTradeAt, uint32 cooldown)` |
| 12 | `ERR_SLIPPAGE` | `Slippage(uint256 minAmountOut, uint256 minOutFloor)` |
| 13 | `ERR_BALANCE` | `InsufficientBalance(address token, uint256 balance, uint256 amountIn)` |
| 14 | `ERR_EXPOSURE` | `Exposure(uint256 exposureUsd, uint256 addedUsd, uint256 maxExposureUsd)` |
| 15 | `ERR_EXIT_PRICE` | `ExitPrice(uint256 twap, uint256 oracle, uint16 maxExitDiscountBps)` |

Errors that do not come from `check()`:

- `NotOwner(address)`, `NotPendingOwner(address)` and `NotPauser(address)`: role checks.
- `InvalidLimits(uint8 field)`: a 1-based index into `Limits`.
- `ZeroAddress()`.
- `ConstructorCheck(uint8)`: the codes in section 1.
- `PostCondition(uint8)`: 1 = `tokenIn` overspent, 2 = `tokenOut` below the minimum, 3 = allowance not zero.

Exit path: when the pool deviates from the oracle by more than `maxOracleDeviationBps`, buys are refused
(`ERR_ORACLE_DEVIATION`). Sells can still go through the exit path, floored at `min(oracle, TWAP)`. That
works only while the TWAP sits no more than `maxExitDiscountBps` below the oracle; otherwise the vault
returns `ERR_EXIT_PRICE`.

## 5. Point an MCP agent at it

ATE's daemon exposes the vault through MCP. The tools are `ate_market_get`, `ate_candidates_get`,
`ate_quote`, `ate_propose`, `ate_decide`, `ate_execute`, `ate_positions`, `ate_strategy_get` /
`ate_strategy_set`, `ate_journal_read` and `ate_pause`.

Any MCP client connects over stdio through `ate mcp serve`. That is a thin proxy to the running daemon,
using the `agent`-scope token from `~/.ate/runtime.json`. It never loads a key. For example, in Claude
Code:

```sh
claude mcp add ate -- node /path/to/ate/apps/cli/dist/bin.js mcp serve
```

The agent sees tools only. Every signature goes through the daemon's single `TxQueue`. `ate_propose` runs
`check()` and the strategy guard first. `ate_execute` re-checks, re-quotes and signs. Every decision needs
a `rationale`, and its `keccak256` lands on-chain as `rationaleHash`.

v0.1 limitation: the daemon and the MCP schemas recognise only the two v0.1 market ids,
`hsk-dex:WHSK/USDT:3000` and `hsk-dex:WBTC/USDT:3000`. Any other market id returns `ATE_MARKET_UNKNOWN`
(`packages/core/src/markets.ts`). For your own pool you have two options:

- Drive the vault directly with your own signer and the `check()` → `execute()` loop in section 4. The
  on-chain bound is the same; you lose ATE's off-chain guard, journal and attestations.
- Extend `MARKET_IDS`, `TOKENS` and the config's `venues.hskdex.markets` and `vaults` for your pool. This
  is a code change, planned as configuration in v1.0.

Either way, the daemon or your signer should hold only the agent key. Keep the owner key on a separate
device, and the guardian key on a separate device or wallet.

## 6. What the bound does and does not cover

See `SECURITY.md`. In short, a stolen agent key can trade only inside the limits, pause the vault and burn
gas. It cannot withdraw, change limits, unpause, or route to another pool, oracle or router. Price risk on
the exposure you allow is not bounded by the contract.
