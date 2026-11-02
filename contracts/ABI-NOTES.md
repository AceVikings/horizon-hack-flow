# PolicyVault ABI notes (Lane A)

Reference: `packages/core/src/abi/policyVault.ts` (frozen 04:30 IST) vs `forge inspect PolicyVault abi`.
Every function, event and error matches by name, argument order, types and parameter names, with these notes:

1. **Extra error `InvalidTick(int24)`** appears in the Solidity ABI. It comes from the vendored v4-core
   `TickMath.getSqrtPriceAtTick` and cannot be reached: the vault bounds the mean tick to
   `[MIN_TICK, MAX_TICK]` before calling it and treats an out-of-range tick as `observe()` failure. TS can
   ignore it.
2. **Constructor**: 6 args `(quoteToken, priceToken, oracle, router, pool, factory)` per SPEC §4.1/§19 step 1;
   the deployer is `owner`. There is **no** constructor `limits_`, so `CONSTRUCTOR_CHECK.INITIAL_LIMITS = 9`
   is never emitted. Limits are set by `setLimits` right after deploy (`script/Deploy.s.sol` does both).
   Constructor check codes 1–8 match `CONSTRUCTOR_CHECK`. Zero addresses revert `ZeroAddress()`.
3. **`InvalidLimits(field)`** uses the 1-based `LIMITS_FIELD` codes. Only 4–8 can fire (epochDuration > 0;
   slippage ≤ 1000; deviation ≤ 1000; deviation ≤ exitDiscount ≤ 2000; 300 ≤ maxOracleAge ≤ 172800).
   Fields 1–3 and 9 have no bound (`maxTradeUsd = 0` disallows trading).
4. **`PostCondition(which)`**: 1 = tokenIn decreased by more than `amountIn` **or increased**, 2 = tokenOut
   rose by less than `minAmountOut`, 3 = router allowance ≠ 0. A post-swap exposure breach reverts
   `Exposure(post, 0, maxExposureUsd)` (not `PostCondition`), as the TS comment says.
5. **Error context values**: `NotAgent(caller)` is the `check()` caller / `msg.sender`; `OracleDeviation.spot`
   is 0 if `slot0` cannot be read, `twap` is 0 if `observe()` reverted; `EpochCap.spentUsd` is the spent
   amount of the *current* index (0 after a rollover); `Cooldown(lastTradeAt, cooldown)`.
6. **Step 6 `answeredInRound < roundId` clause is INCLUDED.** Mainnet read on 2026-11-02 (block ~29.62M):
   both APRO HSK/USD and BTC/USD return `answeredInRound == roundId` (SPEC Q7). Record this in
   `deployments/177.json` (not Lane A's path).
7. **`check()` on a non-trade size**: `amountIn > 2^128 - 1` saturates `notionalUsd` to `type(uint256).max`
   (→ `ERR_TRADE_CAP`) rather than overflowing, so `check()` never reverts for a policy reason.
8. **Before `setLimits`** all limits are 0: every trade is rejected and `epoch()` returns zeros.

## BLOCKER: APRO read access on chain 177

Both APRO proxies are `EACAggregatorProxy` with a `SimpleReadAccessController` and `checkEnabled = true`:

| feed | proxy | accessController | controller owner |
|---|---|---|---|
| HSK/USD | `0x86CE…224b` | `0xb22daaaaDa8a6d55B150874a1E730161cB9846BC` | `0x9876742000De2561586A59F33Cd2a4155AbAc7A7` |
| BTC/USD | `0x204E…360F` | `0xB0120807783212CC7D6c4b32a2A27FeF2A19B143` | same |

`hasAccess(user) = accessList[user] || !checkEnabled || user == tx.origin`. EOAs (and `cast call`/`eth_call`
from an EOA) can read, but **a contract cannot**: when the vault calls `latestRoundData()`, `msg.sender` is the
vault and `tx.origin` is the agent, so the proxy reverts `"No access"`. Step 6 catches that, so every
`check()`/`execute()` returns `ERR_ORACLE_INVALID`, and `exposureUsd()` reverts `OracleInvalid(0, 0)`. Neither
controller has ever emitted `AddedAccess`. `decimals()` has no access check, so the constructor passes.

The fork smoke shows both sides: before access, `check()` returns 6. After `addAccess(vault)` (pranked as the
controller owner), the $5 buy, $5 sell and 7b exit sell all execute on both vaults.

**To trade on mainnet, APRO (controller owner `0x9876…c7A7`) must call `addAccess(<vault>)` on both
controllers.** Vault addresses can be computed before deploy from the owner's address and nonce
(`cast compute-address <owner> --nonce N`), so the request can go out first. The fallback (Supra or another
on-chain source) changes the spec and the bytecode. This is a lead decision.
