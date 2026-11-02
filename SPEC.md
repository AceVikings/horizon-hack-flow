# ATE — Agentic Trading Environment · *bounded autonomy for AI traders*

**Status:** Draft for implementation · **Version:** 0.9.1 (spec; oracle source moved from APRO to a Supra adapter, vault ABI/semantics/reason codes unchanged; re-timed to the 09:50 IST implementation start — frozen interfaces unchanged, additions marked *additive*) · ships as **v0.1** (submission) → **v1.0** (GA)
**Owner:** ATE maintainers · **License:** Apache-2.0
**Team:** Vikings · **Contact:** akash.jsmith@gmail.com
**Event:** HSK Chain Horizon Hackathon · India (Mumbai Edition) · DoraHacks `hskchainindia`
**Track:** **Track 1 — AI Agent Trading** (verified against the official brief in §0.3). HSP is an
optional feature alongside the trading loop (outside the trade path, §9.5), not a Track 2 entry.
**Target chain:** HashKey Chain mainnet, chain ID `177`. HSP QA network is discovered from live `get_chain_config`.

---

## 0. Summary

> **A seatbelt for AI traders: the agent trades HSKSwap on its own; the contract caps what it can lose.**

**Who it is for.** HashKey agent teams — Maneki-style per-agent fleets and MCP trading bots — that want
to give an agent funds without trusting the agent.

**Problem.** HashKey's AI-agent push needs a way to let agents hold funds without trusting them: one bad
prompt or one stolen key can drain an agent's wallet. ATE is that layer — reusable by any agent team, and
routed through HSKSwap, Supra's DORA oracle (APRO read as a cross-check) and EAS.

ATE gives an AI agent **bounded autonomy** on HashKey Chain: the agent watches two HSKSwap markets
(WHSK/USDT and WBTC/USDT), decides and trades on its own with no per-trade human approval — the footer
shows measured uptime, cycles and trades rather than a claim — and the user steers it in plain language
from a Chat view, including which assets it holds. It is safe to leave running because the loss from a
bad or stolen-key trade is capped on-chain by one immutable `PolicyVault` per market; market moves on the
capped exposure are managed by the stop-loss (§4.6). **Dated snapshot, 03:50 IST Nov 2** (re-read at
trader start, ~14:00, and shown in `docs/JUDGE.md`; it may have closed since): the WBTC pool sat 112.6 bps
below HashKey Global's BTCUSDT mid against ~35 bps of entry cost — an entry the *default* profile takes.
Realised-first: a fresh lot is ≈ −0.6% if sold at once (exit fee included); it is ≈ +0.8% on paper,
marked at the CEX, and becomes real only if the pool reverts — the market may keep this discount (a
persistent bridged-WBTC discount, which `ate replay` measures, §11.3) — while the WHSK
pool sat 30 bps below against ~36 bps — a trade it correctly skips (§0.2). It ships as one loop with four
parts:

1. **An autonomous trader** — a reference AI agent (`ate-trader`) that monitors the HSKSwap WHSK/USDT and
   WBTC/USDT pools, the Supra HSK/USD and BTC/USD pairs (APRO feeds as a cross-check) and the HashKey Global HSKUSDT and BTCUSDT books
   (via HashKey's official `hashkey-public-market` skill). The daemon computes bound candidate trades per
   market (spread-revert open/close, rebalance and a standing `discretionary_exit`, guard-sized; §11.3);
   the LLM fetches them with `ate_candidates_get` and decides — act, skip, size down, exit early, or buy a
   premium signal. It may also **originate** up to 3 discretionary trades a day of ≤ $10 each with a
   written thesis (`origin=discretionary`, §11.1) and tune size/threshold/frequency within ±50% of the
   user's settings (journalled `actor=agent`). It must justify every decision; its rationale hash lands
   on-chain and in a per-trade EAS attestation. Stop-loss, take-profit and a portfolio daily-loss breaker
   are built in, with a contract-enforced exit path when the oracle lags (§4.2 step 7b); exits still wait
   on a drop faster than the 300 s TWAP (up to ~5 min) and in the other stated cases (T1.11). Entries
   are suppressed while Supra and APRO disagree by > 250 bps or the vault's `check()` would refuse them
   (§11.3).
2. **A natural-language and tool surface** — a Chat view in the desktop app and `ate chat` in the
   terminal, backed by the same MCP server any MCP-capable agent (Claude Code, Codex, opencode, …) can
   use: market, candidates, quote, propose, decide (no-trade), execute, positions/P&L, strategy, journal,
   kill switch and (if G-HSP) signal purchase. **Three actors, separated authority:** the *trader agent*
   (`agent` MCP scope: candidates, propose, execute), the *chat agent* (`chat` scope, minted per session:
   server-enforced allowlist, no `ate_execute`, no shell) and the *guard* (deterministic, in-daemon: the
   only actor that exits without asking an LLM). Only the daemon's single `TxQueue` signs on-chain, with an
   agent key that can only `execute`/`pause` on the vaults (it also submits permissionless Supra refreshes, §5.2); the guardian and owner keys never touch the agent's machine
   (§8.1).
3. **An enforcement layer** — two `PolicyVault`s on HashKey Chain mainnet (same verified source and creation
   code, one per market; runtime bytecode differs only in the constructor immutables): per-trade and per-epoch USD caps, an exposure cap checked before and after every buy, an
   oracle-anchored slippage floor, a pool-vs-oracle deviation guard (spot and TWAP), a pool/oracle/router
   fixed at deployment, cooldown, pause. Proceeds never leave the vault. Neither the agent nor a fully
   compromised daemon can raise its own limits. An off-chain portfolio guard allocates turnover and
   exposure across the two vaults (§11.4).
4. **An agent-to-agent payment leg (built in full; live use optional, gated by G-HSP, §21.4; outside the
   trade path)** — the
   trader buys premium signals from a separate signal agent. The signal agent creates the HSP order and
   transmits signed payment conditions; the trader verifies them, constructs the Payment Mandate, signs
   via OKX Agentic Wallet, and settles through the HSP Gateway with Vikings team attribution (§9). Trades
   never wait on a payment. Both agents are ours and the HSP network is QA; we say so.

**Thesis — bounded autonomy.** Leave the agent running unattended: it monitors, decides, trades, cuts
losses and journals every choice without you. You can do that because the contract, not the agent's good
behaviour, sets the worst case of a bad trade. **The pitch card has three items:** the stolen key can
never withdraw (I3); execution loss across both vaults is **≤ $51.50 per UTC day (~18% of the demo
wallet), on every path, while the Supra feed is live**; exposure ≤ $150 per vault at every buy. Footnote: price
risk on held exposure is managed by the stop-loss, not the contract. These hold whatever the agent is
told or believes, and with its key stolen. Every other bound (rolling 24 h, normal path, oracle-lag
exits, the oracle-wrong ceiling) is on the Q&A *numbers* card (§4.6, §22.1), not in the pitch. The demo proves the bound by attacking a vault
live with the agent's own key (§22). Contract-enforced and fuzz-tested, not formally proven. The WHSK
pool trades ~$513/day (Nov 2), so ATE sells safe unattended operation first and claims returns only where
measured: WBTC spread trades run the default profile with no waivers and are the T1.8 evidence (E14);
WHSK demo-profile trades are labelled `profile=demo`.

**Positioning.** Prior HashKey hackathon agent projects bound *how much* an agent may spend — Maneki AI
gave each agent a wallet and an on-chain budget; Helm was a trading terminal with a risk copilot. ATE
adds *at what price*, enforced even against the process that holds the agent's key, and shows the attack
failing on-chain. **Why not a Safe module or an ERC-4337 session key?** Those bound *who may call what*
and *how much may move*; out of the box they do not know what a fair price is. A Safe with a Zodiac
Roles-style module could be extended with a custom oracle check; ATE is that check, packaged agent-first:
an oracle-anchored minimum output the agent cannot widen, a pinned venue and pool, a USD exposure cap
valued at the oracle, the agent's rationale hash on-chain per trade, and an MCP-native tool surface. As
of Nov 2 we found no oracle-checked agent policy contract on HashKey Chain in Blockscout's verified
contracts or the HashKey ecosystem directory (the searches are linked in `docs/JUDGE.md`); to our
knowledge this is the first there. Reuse is shown, not only claimed: on stage the rogue attacker is a
second, unrelated MCP client (a Claude Code session over stdio) pointed at the same vault (§22.3) — "any
agent, any framework, same bound". `PolicyVault`, the HSKSwap adapter and the MCP server are standalone
Apache-2.0 packages; v0.1 supports any pool whose `token0` is an 8- or 18-dp `priceToken` against a 6-dp
USD-stable `token1` `quoteToken`, priced by an 8-dp AggregatorV3 feed — the constructor reads and asserts
all of it, and both v0.1 markets are instances (§4.1, §24). Other orientations/decimals are v1.0. The
`VenueAdapter` interface (§6.1) reserves the second venue slot for the **Kredo** prediction market
(`kredo.fun`, linked from the HSK Chain portal) in v1.0.

**Incubation plan.** *Target adopters:* the Maneki AI and Helm teams, and the HSP agent builders at this
event — each gets `docs/INTEGRATE.md` and a one-command deploy (`forge script script/Deploy.s.sol:Deploy`, which deploys the Supra adapter first, §19, §24). *30 days:* external audit of `PolicyVault` plus a public bug bounty;
Safe-by-default owner. *60 days:* Kredo `VenueAdapter`; ERC-8004 agent identity on `AgentRegistry`.
*90 days:* other token orientations/decimals, on-chain portfolio limits, two design partners live on
mainnet. **Ask of HashKey:** audit credits or a grant, HSP QA allowlist access, and adoption of the
`agent-policy-vault` skill into the official HSK-Superpowers set. `@ate/venues` and `@ate/mcp` are
published to npm by 17:30 Nov 2 (§24).

### 0.1 What ATE is not

- Not a model. ATE core ships no LLM; the reference trader and the Chat view run on whichever MCP agent
  CLI the user already has. Provider credentials and wallet sessions stay outside the renderer and source tree.
- Not a profit promise. The strategy is real and measured; the safety bound is the product.
- Not a key custodian. The agent key stays in the OS keychain; the guardian and owner keys live off the
  agent's machine and are never loaded by the daemon (§8.1); the OKX payment signer stays in OKX's TEE. ATE
  never receives an OKX private key.
- Not a venue. It routes to HSKSwap; it does not provide liquidity.

### 0.2 Verified chain facts this spec depends on

All values read from mainnet; treat as configuration, not constants. Read 2026-11-02 IST — core reads
00:10–00:25 IST (18:40–18:55 UTC Nov 1), HSKSwap app config ~01:55 IST, WBTC market ~03:30–03:50 IST —
see `.context/review/onchain-verification.md`. Market snapshots drift; they are re-read at trader start
(~14:00 IST) and the re-read is what `docs/JUDGE.md` shows next to them.

| Item | Value |
|---|---|
| Chain ID / RPC | `177` / `https://mainnet.hsk.xyz` (public; rate-limits with HTTP 429 and Cloudflare 1015 bans — configure a fallback, §16, §18.1) |
| Gas token | HSK (18 dec) |
| Explorer | `https://hsk.blockscout.com` |
| WHSK | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` (18) |
| USDT | `0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029` (6) |
| WETH | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` (18) — excluded: the HSKSwap WETH/USDT pool `0xb92b79ed6b370D5cFee2E14B1D0983C258304C16` exists, but APRO has no ETH/USD feed; Supra lists ETH/USD (pair 1, 2,304.19) but no ETH market was adapter-deployed, fork-smoked or risk-bounded, so it stays out of v0.1 (v1.0 candidate) |
| WBTC | `0x6119ca49a79f5825c8b345f8d7ac36b272565b14` (8) — **second v0.1 market** |
| USDC.e | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` (6, ~$1.8k supply — do not rely on) |
| APRO HSK/USD | `0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b` (8 dec, push/threshold feed) — **readable only by EOAs or allow-listed contracts (next rows); display / `doctor` cross-check, not the vault's oracle** |
| APRO BTC/USD | `0x204ED500ab56A2E19B051561258E3A45c850360F` (8 dec, push/threshold; 77,925.02, age 12.2 h at the 03:50 IST Nov 2 read) |
| APRO USDT/USD | `0x823d7f90f7A3498DB6595886b6B5dC95E6B0B7f3` |
| **APRO read access (verified on chain 177 and on a mainnet fork, Nov 2; `contracts/ABI-NOTES.md`)** | Both feeds are `EACAggregatorProxy`s with a `SimpleReadAccessController` (`checkEnabled = true`; controllers owned by `0x9876742000De2561586A59F33Cd2a4155AbAc7A7`; no `AddedAccess` ever emitted). `hasAccess(user) = accessList[user] \|\| !checkEnabled \|\| user == tx.origin`: an EOA (or `eth_call` from one) reads, a **contract cannot** (inside the vault `msg.sender` is the vault, `tx.origin` the agent → `"No access"`). A vault reading APRO gets `ERR_ORACLE_INVALID` (fork: `check()` returns 6) until APRO calls `addAccess(vault)`. `decimals()` is ungated, so a constructor would still pass. Consequence: the daemon reads APRO by direct `eth_call` from its EOA, never inside Multicall3 |
| **Supra storage / pull (the vault's price source)** | Storage proxy `0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57`, `getSvalue(uint256)` — **no access control**. Pull contract `0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD`, `verifyOracleProof(bytes)` — permissionless, idempotent (writes only newer rounds; rejects rounds > 3 s in the future) |
| Supra pairs (Nov 2 reads) | **HSK/USD = 517** (0.087405, age 4.4 h at read); **BTC/USD = 0** (78,481.975, age 3.5 h); ETH/USD = 1 (2,304.19; not used in v0.1). Supra time is in ms; price decimals 18 on 177 |
| `SupraAggregatorAdapter` (`contracts/src/oracles/`) | Stateless, ownerless, AggregatorV3-shaped view over one pair: `decimals() = 8`; price rescaled to 8 dp **rounding down**; `updatedAt = startedAt = time/1000`, **capped at `block.timestamp`**; `roundId = answeredInRound` (so the step-6 `answeredInRound` clause never fires on it); an unpopulated pair or a price that rounds to 0 returns zeros → `ERR_ORACLE_INVALID`. One adapter per market (HSK pair 517, BTC pair 0); each vault's immutable `oracle` is its adapter (addresses in `deployments/177.json`) |
| Supra cadence (HashKey Chain) | Pushes every ~**6 h** or on a **0.5 %** move; anyone can refresh on demand with a proof from `POST https://rpc-mainnet-dora-2.supra.com/get_proof` `{"pair_indexes":[0,517],"chain_type":"evm"}` → `verifyOracleProof` (~330k gas for both pairs ≈ 0.17 HSK at 500 gwei, fork-measured); the daemon does this through `TxQueue` (journal kind `oracle_refresh`, §5.2) |
| Fork smoke, Supra-backed vaults (block 29,623,000, **no APRO access granted**; `contracts/README.md`) | Both vaults pass buy, sell and the 7b exit path; each buy's output equals QuoterV2; gas ~168k per buy, ~120k per sell. The APRO-backed variant (`ORACLE_SOURCE=apro`) returns `check()` = 6 until `addAccess(vault)` |
| Supra pull / storage | `0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD` / `0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57` |
| V3 factory (HSKSwap) | `0x972cA9D1662F5e029cD18327D29026532E84c742` |
| WHSK/USDT pool (fee 3000) | `0x4ff515761864e7838b0adb8b5b2b8b7a068905dc` — token0 WHSK (18), token1 USDT (6); observation cardinality 240 |
| WBTC/USDT pool (fee 3000) | `0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A` — same factory; token0 WBTC (8), token1 USDT (6); observation cardinality **240** (`observationCardinality`/`Next` = 240/240, read 2026-11-02 ~03:40 IST) |
| WHSK pool depth (Nov 2) | 4,987,140.77 WHSK / 436,795.75 USDT ≈ $874k (was ≈ $442k on Oct 24) |
| WBTC pool depth (Nov 2, 03:50 IST) | 0.6566 WBTC / 50,645 USDT ≈ $101k |
| Observed spot volume | WHSK pool ~$513 / 31 swaps in 24h (Nov 2); ~$183 on Oct 24. WBTC pool: not yet measured (`ate replay` reports it, E11) |
| WHSK pool vs APRO (Nov 2; cross-check reading) | pool mid $0.087588 vs APRO $0.087721 → pool 15 bps below |
| APRO cadence (HSK/USD, BTC/USD; cross-check only) | ~2% deviation trigger (observed 200–205 bps) + ~24h heartbeat (observed gaps 86,406–86,430 s; USDT/USD up to 86,490 s); see §5.2 |
| SwapRouter02 (verified) | `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3` — 7-field `exactInputSingle`, **no `deadline`** |
| SwapRouter v1 (verified) | `0x56d15cF00b5D853D6eE4CbB1463E6DAD2899fBf5` — 8-field struct with `deadline`; same factory |
| QuoterV2 (same factory) | `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |
| HSKSwap app config (mainnet; verified ~01:55 IST Nov 2, `onchain-verification.md` § HSKSwap app config) | `app.hskswap.com` bundle (`assets/shared-B-bsW-m1.js`, `[HashKey]` entries) lists factory `0x972c…c742`, SwapRouter02 `0x2c16…D8F3`, QuoterV2 `0x603f…bFDD` — confirms these are HSKSwap's contracts |
| HashKey Global HSKUSDT, BTCUSDT (public, no key) | `/quote/v1/ticker/24hr` (incl. bid/ask), `/quote/v1/ticker/bookTicker`, `/quote/v1/depth`, `/quote/v1/trades`, `/quote/v1/kline` on `api-glb.hashkey.com` — the endpoint map of HashKey's official `hashkey-public-market` skill (`hashkey-skills`, site `glb`, read-only) |
| WHSK live snapshot (Nov 2, 02:00 IST; unchanged at 03:50) | CEX bid/ask 0.0878/0.0879 (mid 0.08785, half-spread ~5.7 bps, ~$115–165 at top of book); pool 0.087588 (**29.8 ≈ 30 bps below CEX mid**, 15 bps below APRO); APRO age 3.9 h. Cost of a one-legged trade ~36 bps → **no trade**. Single planning number for the WHSK gap |
| WBTC live snapshot (Nov 2, 03:50 IST) | Pool $77,144.61; HashKey Global BTCUSDT bid/ask 78,023.38/78,023.49 (half-spread < 0.01 bps) → **pool 112.6 bps below CEX mid**, 100 bps below APRO (77,925.02). Cost at $25: 30 bps fee + ~5 bps impact (full-range estimate from depth: execution ≈ size ÷ USDT reserve; QuoterV2 confirms at the 13:00 dry-run) ≈ **35 bps → net ≈ 78 bps: a live `spread-revert` buy under the default profile**. Each $25 buy moves the pool ~10 bps toward the CEX. Single planning number for the WBTC gap. **Caveat:** the pool holds ~94% of WBTC supply (0.6566 of 0.6997) and its token is a bridged OptimismMintableERC20, so the discount may be a persistent bridge/liquidity discount rather than a transient gap; it already uses 100 of the 250 bps deviation budget. `ate replay` reports its persistence and time-to-close (E11, §11.3) |
| EAS / SchemaRegistry | `0x4200000000000000000000000000000000000021` / `0x4200000000000000000000000000000000000020` |
| ERC-4337 EntryPoint v0.6 / v0.7 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` / `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |

**Implication for quoting** (QuoterV2, Nov 2): 500 USDT → 5,684.95 WHSK costs 41.5 bps including the
0.30% fee and moves the price 22.8 bps; 5,000 USDT → 56,272.12 WHSK costs 144.6 bps and moves the price
229.6 bps. Execution cost and price move are different numbers; the UI shows both from simulation;
local math appears only as a labelled in-flight `estimate` (§6.3), never for `minAmountOut`. On the WHSK
pool impact is small at v0.1 caps (≤ ~2 bps at the $100 trade cap, ~0.1 bps at the $5 demo size). The
WBTC pool is ~9× thinner: ~1 bps at $5, ~5 bps at $25, ~20 bps at $100 (estimates; QuoterV2 is the
source of truth), so the depth-aware `impactBps ≤ edgeBps/3` sizing term (§11.3) can bind there near the
trade cap.

### 0.3 Track 1 verification — AI Agent Trading

**Submission track: Track 1 — AI Agent Trading.** No Track 2 entry. HSP is used only as an optional
feature alongside the trading loop (outside the trade path, §9.5), because officially recommended products
earn extra points.

Official brief (DoraHacks `hskchainindia/detail`, verified 2026-11-02), broken into checkable elements:

> Building an AI-agent-based automated trading system on decentralized exchanges (DEX:
> app.hskswap.com). Powered by an AI agent as its core engine, the system autonomously completes the full
> closed-loop workflow of market monitoring, on-chain data analysis, trading signal identification, and
> order execution. Without any manual intervention, it can capture trading opportunities such as
> arbitrage and price spreads in real time, and achieve sustained profitability under a strict
> risk-control and stop-loss framework. Meanwhile, the system is equipped with a natural language
> interaction interface, allowing users to view positions and P&L in real time and adjust trading
> strategies (such as position sizing, frequency, risk appetite, target assets, etc.) through
> conversation. This enables AI-driven automated trading and users' subjective decision-making to work
> in synergy, balancing trading efficiency with human controllability.

| # | Brief element | Status | Where | Judge-visible evidence |
|---|---|---|---|---|
| T1.1 | Trades on a DEX — HSKSwap (app.hskswap.com) | **Met, verified** | §0.2, §6.2 | HSKSwap's own app config for HashKey mainnet (bundle read ~01:55 IST Nov 2, recorded in `onchain-verification.md`) lists factory `0x972c…c742`, SwapRouter02 `0x2c16…D8F3` and QuoterV2 `0x603f…bFDD` — the exact contracts the vault is bound to; the router and quoter are also verified on-chain to report that factory |
| T1.2 | AI agent as the core engine | **Met** | §11.1, §7.4 | Every cycle the LLM pulls bound candidates for both markets (`ate_candidates_get`) plus CEX depth/trades from the `hashkey-public-market` skill, and decides act / skip / size down / exit early (standing `discretionary_exit`); it **originates** bounded discretionary trades (≤ 3/day, ≤ $10, required thesis, `origin=discretionary`) and tunes strategy within ±50% of the user's settings (`actor=agent`). The prompt makes it evaluate the discretionary lane and every candidate for veto/size-down each cycle and record why not (§11.1). Journal `engine=llm` with `candidateId` or `origin=discretionary` on every decision; DoD requires ≥ 1 candidate-bound trade, ≥ 1 discretionary trade and ≥ 1 veto/size-down; the **AI scoreboard** tile reports acts / vetoes (bps saved, E13) / discretionary trades (§15.1); EAS attestation per executed trade carries the rationale hash (E3) |
| T1.3 | Market monitoring | **Met** | §5, §11.2 | Both pools, both Supra pairs (plus the APRO cross-check) and both HashKey Global books in every cycle's record |
| T1.4 | On-chain data analysis | **Met** | §6.2, §11.2 | Pool `slot0`, TWAP, active liquidity, QuoterV2 impact, swap flow, Supra round per record |
| T1.5 | Trading signal identification | **Met** | §11.3 | `signal` block per decision, including `no_trade` decisions (`ate_decide`) |
| T1.6 | Order execution | **Met** | §4.2, §6.2 | `TradeExecuted` txs on Blockscout via each vault → HSKSwap |
| T1.7 | Without any manual intervention | **Met** | §7.3 `autonomous`, §9.5 | `approvedBy=policy` on executed trades; trader runs ≥ 1 h unattended (G6) and the footer counts measured uptime, cycles and trades. In `autonomous` mode **no step on the trade path is human-gated**. Human-gated steps exist only beside it: the optional HSP payment (two approvals, per the HSP guide), loosening strategy changes (Touch ID, §11.5) and trades in the opt-in `confirm` mode; no autonomous trade, exit or stop-loss ever waits on any of them (§9.5, §11.5) |
| T1.8 | Capture arbitrage / price spreads in real time | **Met — one-legged spread capture, stated** | §11.3, §0.2 | `spread-revert` buys the pool toward the CEX price when the gap beats fee + impact + CEX half-spread, and its close leg sells those lots once the exit-executable mark beats their entry by ≥ `minNetEdgeBps`. **Snapshot 03:50 IST: WBTC pool 112.6 bps below CEX mid vs ~35 bps entry cost → a default-profile buy; realised-first, a fresh lot is ≈ −0.6% if sold now and ≈ +0.8% on paper at the CEX mark if the pool reverts, and the market may keep the discount; E14 is the primary evidence** (decision record with gap/cost/net edge, `TradeExecuted`, EAS UID). **Pre-registered second path:** if the trader-start re-read (~14:00) shows the WBTC gap below cost, E14's evidence is the replay's top-decile historical gaps, each with the default-profile decision and counterfactual net edge (E11), plus the live `no_trade`/suppression records — stated as such. Same cycle, WHSK: 30 bps vs ~36 bps → correctly `no_trade`. One-legged (no CEX execution): spread capture, not two-leg arbitrage. LLM cycle 120 s by default (`cycleSeconds`, minimum 30 s) on ~2 s blocks; the daemon re-scans candidates every `scanSeconds` (20 s, *additive*) and a newly opened entry candidate triggers an out-of-schedule LLM cycle (§11.1); candidates valid `candidateTtlSec` = max(120 s, 2 × p95 LLM latency) (§11.1). `ate replay --days 7` (E11, both markets) counts every opportunity taken or rejected over the last week and measures whether gaps persist or close (time-to-close, transient/persistent verdict) |
| T1.9 | Sustained profitability | **Partial — stated honestly** | §11.3, §4.6 | Default profile (the WBTC market): every candidate entry clears net edge after costs (spread ≥ `minNetEdgeBps`, rebalance ≥ 0, both vs CEX mid); go-to-cash and guard/discretionary exits are exempt (they reduce risk); discretionary entries are judged by their thesis and reported separately; WHSK demo-profile trades waive the edge gate and are labelled `profile=demo`. Realised and CEX-marked P&L since the trader's start (~14:00) incl. fee drag, per market, is stated in the README, including no-trade cycles; WBTC lots are realised only when the pool reverts (the close leg pays the exit fee), and the README states next to the CEX-marked number that the WBTC discount may be structural (§11.3). E11 (in the BUIDL from its first edit): 7-day replay from pool `Swap` logs and HashKey Global klines — candidates fired, rejected on net edge, and counterfactual net edge in bps after fee + impact + half-spread, labelled counterfactual. One day and ~$100 of WBTC turnover cannot prove *sustained* profitability; the pitch leads with bounded autonomy |
| T1.10 | Strict risk control | **Met — contract-enforced** | §4, §4.6 | Verified `PolicyVault`s: trade/epoch/exposure caps, oracle floor, deviation guard, pause; portfolio guard across both; rogue-agent reverts (E4) |
| T1.11 | Stop-loss framework | **Met — contract-backed exit path, stated limits** | §4.2 step 7b, §11.4 | Stop-loss / take-profit per market and a portfolio daily-loss breaker in the guard with defined position, entry and mark (§11.4); when the oracle lags, exits use the vault's exit path floored at `min(P, 300 s TWAP)` (`P` = the Supra-backed oracle price). Stated limits: exits also wait while spot is more than slippage + fee below that floor price — a drop faster than the 300 s TWAP, up to ~5 min — and while the mark disagrees with the TWAP by more than `maxOracleDeviationBps` (anti-manipulation); and if the TWAP is more than `maxExitDiscountBps` (5%) below the oracle price, the oracle is stale (> `maxOracleAge`) or invalid (step 6 precedes 7), the epoch budget is spent (the exit-reserve rule, §11.4 rule 3, keeps a full exit inside the epoch unless price rose since the last entry or the off-chain guard was bypassed), or the vault is paused (a pause freezes the remaining exposure; §11.4). Recorded stop-out whose card shows entry, exit-executable mark (fees included) and threshold (E6) |
| T1.12 | NL interface: positions and P&L in real time | **Met** | §7.2 `ate_positions`, §11.5, §15.1 Chat | In-app Chat view (and `ate chat`): "How am I doing?" → `ate_positions` tool card with live balances, fills and P&L per vault and for the portfolio, shown live in the demo (E7) |
| T1.13 | NL strategy adjustment: sizing, frequency, risk appetite | **Met** | §7.2 `ate_strategy_set`, §11.5 | Chat transcript → `strategy_change` journal records (`actor=human, via=chat`, derived from the `chat` token scope, never from the route) with rationale, clamped to on-chain limits; tightening applies at once, loosening (direction table, §11.5) needs a Touch ID `ate-approve` signature over the before/after diff; risk appetite in one phrase — "Be more aggressive / conservative" → `riskProfile` preset (*additive*, §11.5); every human change triggers an immediate out-of-schedule cycle (E6, E7) |
| T1.14 | NL strategy adjustment: target assets | **Met** | §7.4 `targetAssets`, §11.4, §11.5 | Conversation selects between **WHSK, WBTC and cash**: "Only trade BTC" / "Go to cash on HSK, keep the BTC" → `ate_strategy_set { targetAssets: ["WBTC"] }` (de-selected markets sell down at once as guard exits, §11.4 rule 9; turnover re-allocated); "Go to cash" → `targetAssets: []`; "Target 20% HSK" → per-market allocation. Shown live in the demo with a real sell (E7). WETH is out of v0.1 scope (§0.2) |
| T1.15 | Human controllability in synergy with automation | **Met** | §4.5, §7.3, §11.5 | Kill switch (both vaults) from chat and from the guardian's device off the agent's machine; owner-only limit changes; optional `confirm` mode; reuse by a second, unrelated MCP client (Claude Code over stdio) shown on stage (§22.3) |

**Gates:** HSK Chain mainnet contract deployed and verified (§19, E1) — must ship; built on HSK Chain;
original work in the window (commit history); in-person demo in Mumbai preferred.

**Officially recommended products — in the shipping path (claimed):**

| Product | Meaningful use | Evidence |
|---|---|---|
| HSKSwap | Each vault bound immutably to its factory, SwapRouter02 and pool (WHSK/USDT, WBTC/USDT); QuoterV2 for every quote; pool TWAP for deviation and exit floor; HSKSwap tx count and routed USD in the evidence footer, the close and `docs/INTEGRATE.md` (§15.1) | E1, E3, E14 |
| Supra DORA oracle (storage `0x58e1…3d57` via one `SupraAggregatorAdapter` per vault; pull `0x16f7…C3dD` for on-demand refresh) | HSK/USD (pair 517) and BTC/USD (pair 0) **enforced in-contract**: slippage floor, staleness, deviation guard; the daemon refreshes pairs with signed pulls (`oracle_refresh`, §5.2) | E2, E4 |
| EAS (predeploy `0x4200…0021`) | Schema registered at deploy; one attestation per executed trade (`proposalId`, `rationaleHash`, `txHash`, `notionalUsd`, `exitPath`, `engine`, `origin`); UID in the journal | E3, E10 |
| Blockscout | Verified source of both vaults, decoded custom-error reverts, all evidence links | E1–E6, E14 |
| `hashkey-skills` → `hashkey-public-market` | Official HashKey skill for HashKey Global market data (site `glb`, read-only): the daemon's CEX reader implements its endpoint map and runtime rules for HSKUSDT and BTCUSDT; the trader agent loads the skill to read depth/trades/klines (the Chat agent gets the same data through `ate_market_get`, §11.5); `ate replay` uses its klines | §5.1, E11 |
| APRO (HSK/USD `0x86CE…224b`, BTC/USD `0x204E…360F`) | **Off-chain cross-check, not in the enforcement path** (the feeds refuse contract callers, §0.2): the daemon reads them by direct `eth_call`; it emits no entry candidates for a market while Supra and APRO disagree by > 250 bps (`oracle_disagree`; exits unaffected); `ate doctor` and a UI badge show the gap (bps, ages, per market); never read by the vault (§5.1). Optional: if APRO allow-lists a vault, `ORACLE_SOURCE=apro` deploys an APRO-backed vault (§25 Q13) | E2 (doctor output), suppression records |
| HSK-Superpowers | Used for the Foundry workflow: test → Anvil fork smoke → 177 deploy → Blockscout verify (§3.3); every skill invocation and its output is logged in `docs/superpowers-log.md`; we contribute back an `agent-policy-vault` skill PR to `HashKeyChain/HSK-Superpowers` (draft by 17:30, §24) | E9, PR link |

**Conditional (not claimed until evidenced):** HSP + OKX Agentic Wallet (G-HSP, §9, E8) — whatever
G-HSP decides, `docs/hsp-readiness.md` and the recorded tool listing or organiser reply are committed by
12:00 IST (§21.4); APRO-backed vaults (only if APRO allow-lists a vault, §25 Q13); Safe — Vault-BTC's ownership moves to a Safe on 177
after E5/E6 are recorded (~17:00, §19 step 9), claimed only once that transfer tx exists (Safe owner by
default is v1.0).

---

## 1. Goals and non-goals

### 1.1 Goals

| ID | Goal | Measure |
|---|---|---|
| G1 | Any MCP agent can trade in under 5 minutes once a vault exists | Time from `ate mcp serve` → first executed trade (vault deploy + funding ≤ 15 min, measured separately) |
| G2 | A compromised agent or daemon cannot exceed policy | Zero invariant violations under adversarial fuzzing; rogue-agent script fully rejected on-chain |
| G3 | Every decision is reconstructable | 100% of trades, no-trade decisions and payments have rationale, inputs and tx/payment reference |
| G4 | Keys stay within their signer boundary | Owner key never in daemon; OKX keys stay in its TEE; no key material in renderer, source or logs |
| G5 | Works on a thin-liquidity chain | Impact simulated before every trade; sizes self-limit to depth (binds near the trade cap on the ~$101k WBTC pool, above ~$1k/trade on the WHSK pool) |
| G6 | Runs unattended | Trader completes ≥ 1 h of autonomous cycles with no human input |
| G7 | Users steer the agent in plain language | Chat view / `ate chat` answers P&L and changes strategy through MCP tools; every change journalled |
| G8 | (Conditional on G-HSP) A2A payments settle with team attribution | HSP `payment-finalized`, tx reference and `attribution_verified=true` for Vikings |

### 1.2 Non-goals (v1.0)

Multi-user/cloud sync (the optional payment worker, §3.4, is the only cloud component), mobile, fiat on-ramp, tax
reporting, cross-chain bridging UI, agent marketplace, social/copy trading, CEX order execution.

---

## 2. Personas and stories

**P1 — Quant-curious builder.** Runs Claude Code daily. *Story:* "I set a $250/day policy per vault, type
'trade the HSK and BTC spreads, small size' into the Chat view (or tell my own MCP agent), and go to sleep. In the morning
I ask 'how did it go?' and the journal shows every trade and every skipped signal, with reasons."

**P2 — Risk-conscious operator.** Fears a runaway loop. *Story:* "When the agent proposes $5k, the
pre-flight against the vault rejects it and I see the contract's reason; if it bypasses ATE and sends the
transaction anyway, the vault reverts it on-chain. If it loses 3% on a position it exits; if the day goes
badly it flattens and pauses itself."

**P3 — Auditor/judge.** *Story:* "I click a decision, see the oracle snapshot, pool state, signal, policy
inputs, and the on-chain tx — including the reverted ones."

**P4 — Adversary.** A prompt-injected or malicious agent with shell access on the same machine. *Story
(must fail):* "I try to trade $5,000, go all-in on WHSK, lie about the price, trade a token I control,
withdraw, raise my own caps, and trade after the kill switch." Every attempt fails (§22.3).

---

## 3. Architecture

### 3.1 Process model

```
 Desktop (user's Mac)                                       AWS worker (ap-south-1, private subnet)
┌───────────────────────────────────────────┐              ┌────────────────────────────────────┐
│ Renderer (React 19 + Vite) — sandboxed    │              │ ate-pay (Node 22) — payment agent  │
│  Chat · Trade · Positions · Agents · Dec. │              │  HSP MCP client · OKX signer       │
└───────────▲───────────────────────────────┘              │  mandate builder · state machine   │
            │ typed IPC via preload                         │ ate-signal — receiving agent       │
┌───────────┴───────────────────────────────┐              │  offers · HSP orders · redemption  │
│ Electron main — spawns or attaches to the │              └──────────────▲──────────┬──────────┘
│ daemon; invokes `ate-approve` (Secure     │                             │          │ egress via NAT
│ Enclave / Touch ID)                       │                             │          │
└───────────▲───────────────────────────────┘          SSM port-forward   │          ▼ 13.205.56.13
            │ loopback HTTP; ui token via spawn pipe     + worker token    │   HSP QA MCP
            │ or POST /ui/attach (§10.1)                                   │
┌───────────┴───────────────────────────────┐                             │   (mcp-qa.hashkeymerchant.com)
│ ate-daemon (Node 22)                      │─────────────────────────────┘
│  agent signer · venue · oracle · cands    │◄── MCP (stdio / Streamable HTTP) ── ate-trader, chat
│  portfolio + strategy guard · mcp ·       │                                     agent (any MCP agent)
│  journal (single writer) · chat           │
└───────────▲───────────────────────────────┘
            │ JSON-RPC (viem, Multicall3, ≥ 2 RPCs)
     HashKey Chain 177 · PolicyVault ×2 (WHSK/USDT, WBTC/USDT) · HSKSwap pools · Supra adapters (HSK/USD, BTC/USD) · EAS

 Second device (never the agent's machine): `ate-owner` — owner signer (Ledger, or cast-wallet encrypted
 keystore fallback) and, by default, the guardian key (`ate-owner pause --guardian --all`); the guardian
 moves to a third device when one is available (§4.1).
```

**Why a separate daemon process:** the renderer can be compromised by malicious content or a
supply-chain issue; the daemon must not depend on it. It also enables headless operation
(`ate daemon start --headless`, `ate mcp serve`).

**Why the vault, not the daemon, is the security boundary:** the agent typically runs as the same OS
user with a shell, so it can read anything the daemon can. ATE therefore assumes the daemon's agent key
*can* be stolen, and makes that harmless: it can only call `execute` (bounded by on-chain policy) and
`pause`. The owner key, which can change limits or withdraw, and the guardian key, an independent pause
path, are never loaded by the daemon (§8.1). One agent key serves both vaults; a stolen key is bounded by
the sum of the two vaults' limits (§4.6).

### 3.2 Trust boundaries

| Boundary | Trusted | Untrusted |
|---|---|---|
| Renderer ↔ main | nothing | renderer |
| Main ↔ daemon | loopback + bearer token (scoped) | anything on the network |
| Daemon ↔ chain | chain (by consensus) | RPC responses (verify, don't trust) |
| Daemon ↔ agent | tool calls only | agent intent, rationale text, strategy requests |
| Chat view ↔ chat agent | `ui` token via main; per-session `chat` token whose allowlist the MCP server enforces (§10.1, §11.5) | user and model text (never executed; only allowlisted tool calls act) |
| Daemon ↔ worker | SSM tunnel + bearer token + digest-bound approvals | network path |
| Trader ↔ signal agent | signed payment conditions | signal content (data, never instructions) |
| Daemon ↔ KB (v1.0) | local files | ingested content (prompt-injection carrier) |

### 3.3 Package layout

```
ate/
├─ apps/
│  ├─ desktop/          electron-vite shell; main + preload + renderer
│  ├─ daemon/           long-running process; signer adapters & chain connection; `src/approval/`
│  │                    (`/ui/attach`, `/chat/session`, `/strategy/approve`, TTY fallback) is Lane E's
│  ├─ worker/           ate-pay (HSP payments) + ate-signal (receiving agent), runs on AWS
│  ├─ cli/              `ate` command. `src/commands/index.ts` (frozen at 10:30) loads
│  │                    `src/commands/<lane>/*.ts` by directory; each lane owns only its directory:
│  │                    `c/` init, daemon, mcp, agent, chat, journal, replay, ui · `b/` doctor, unlock, smoke ·
│  │                    `a/` rogue (thin entry into agents/rogue)
│  ├─ approve/          `ate-approve` (Swift: CryptoKit Secure Enclave + LocalAuthentication); installed
│  │                    root-owned to /usr/local/libexec/ate/ (§10.1)
│  └─ owner-cli/        `ate-owner`: typed owner operations + guardian pause; Ledger or cast-wallet
│                       keystore signing; runs on the second device only
├─ packages/
│  ├─ core/             domain types, invariants, policy math (mirrors PolicyVault), strategy-seam
│  │                    interfaces `src/strategy.ts` (frozen 10:30, §21.4) + Lane B pass-through stub
│  ├─ wallet/           keystore, agent signer
│  ├─ payments/         HSP client, mandate builder, approval state machine, settlement journal
│  ├─ chain/            viem clients, contract bindings, tx builder
│  ├─ venues/           VenueAdapter interface + hsk-dex adapter
│  ├─ oracle/           Supra reader + pull refresher, APRO cross-check reader, pool reader, HashKey Global reader (`hashkey-public-market`), health
│  ├─ strategy/         signal engine, sizing, stop-loss, circuit breaker
│  ├─ mcp/              tool schemas + server
│  ├─ journal/          append-only decision log, migrations (001 frozen at 10:30, §21.4); EAS
│                       attester in `src/attest/` (Lane E's)
│  └─ ui/               shared components + design tokens
├─ agents/
│  ├─ trader/           reference trader prompt + loop runner (`ate agent run`)
│  ├─ chat/             Chat-view / `ate chat` prompt; tool allowlist (§11.5)
│  └─ rogue/            adversarial script for the demo and CI (Lane A owns it and the `ate rogue` entry)
├─ contracts/           Foundry: PolicyVault, tests, deploy scripts
└─ docs/
```

Package manager: **pnpm workspaces**. Build: **tsup** (libs), **vite** (apps). Test: **vitest**,
**forge**, **playwright**. **Decision:** Lane A runs contract work through HashKey's **HSK-Superpowers**
plugin for the Foundry test → Anvil-fork smoke → 177 deploy → Blockscout verify workflow, and logs every
skill invocation with its command output to `docs/superpowers-log.md` (linked from E9). HashKey's official **`hashkey-skills`** pack (`hashkey-public-market` only; no
account, trading or wallet skill is installed, no API key exists) is vendored at a pinned commit under
`agents/skills/` for the trader and Chat agents.

### 3.4 AWS payment worker and stable egress

The Vikings AWS account hosts a small Linux EC2 worker in a private subnet. A public NAT gateway in a
separate public subnet owns Elastic IP `13.205.56.13`. There are no inbound ports; administration uses
SSM Session Manager with an instance role limited to SSM, IMDSv2, and encrypted EBS. Operations detail:
an ops runbook and templates kept outside the repository (IaC is never committed).

- **All HSP calls originate on the worker** (`ate-pay`). The desktop never calls HSP directly; its egress
  IP is not allowlisted.
- The desktop daemon reaches `ate-pay` only through an SSM port-forward to `127.0.0.1:<port>` on both
  ends. `ate-pay` requires its own bearer token (rotated per start, fetched by the daemon over SSM at
  session start and held only in memory) on every request; a forwarded port is reachable by any local
  Mac process, so the token is mandatory. Payment approvals additionally carry the Secure Enclave
  signature from §10.1.
- **Operator credentials are a payment-path key.** Whoever holds the `vikings` AWS profile has root on the
  worker via SSM, and with it the OKX session and fallback payer key. The daemon fetches the worker token
  over SSM with that profile, so **while an operator AWS session is live on the agent's Mac, a same-user
  compromise of that Mac can spend the payer float without Touch ID** (residual risk, accepted for v0.1;
  v1.0 runs the tunnel under a separate macOS user that hands the daemon only the worker token). Bounds:
  MFA-gated 1 h sessions, SSM session logging, and a payer balance that never exceeds the $1.00 daily
  payment cap (§9.5). PolicyVault funds are unaffected: no vault key lives on the worker.
- Network and worker stacks are separate: replace the worker without touching NAT or EIP. NAT, public
  IPv4 and disk charges continue when compute stops (~$45/month network floor).
- Single-AZ hackathon setup; no automatic cross-AZ failover.

---

## 4. Smart contracts

### 4.1 `PolicyVault.sol`

One vault per market per agent, all from the same verified source and creation code (runtime bytecode differs only in immutables); v0.1 deploys two —
**Vault-HSK** (WHSK/USDT) and **Vault-BTC** (WBTC/USDT). **What a vault trades, how it is priced and where
it swaps are fixed in the constructor and can never change**; only numeric limits are mutable. A new
pair, oracle or router means a new vault. This removes the most dangerous owner action — repointing the
vault at an attacker's pool, oracle or router through a disguised "raise the cap" approval. Each vault
has its own limits (defaults in §19 step 3, identical for both); the portfolio guard (§11.4) allocates
turnover and exposure across them off-chain, and §4.6 states the bound per vault and for the portfolio.

| Role | Can call | Held by |
|---|---|---|
| `owner` | `setLimits`, `setAgent`, `setGuardian`, `pause`, `unpause`, `withdraw`, `transferOwnership` (the pending owner calls `acceptOwnership`) | Ledger on the **second device**; fallback a `cast wallet` encrypted keystore created and used only there (§19); Safe at v1.0. Never the daemon. |
| `agent` | `execute`, `pause` | Daemon (OS keychain) — also signs the daemon's kill switch and breaker pause |
| `guardian` | `pause` | A third device (ops' phone wallet calling `pause()` on Blockscout's write tab) when available; otherwise a separate `cast wallet` keystore on the second device (`ate-owner pause --guardian --all`). Either way it is independent of the daemon; on the second device it is not independent of that laptop (stated) |

Pausing is fail-safe, so anyone holding a low-privilege key may pause; only the owner may unpause.

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IAggregatorV3 {   // latestRoundData is called inside try/catch (§4.2 step 6)
    function latestRoundData() external view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

// Fixed at deployment (constructor), exposed as immutables. Same source and creation code, two instances:
//                Vault-HSK                          Vault-BTC
//   quoteToken  USDT 0xF1B5…9029 (6 dp)            USDT 0xF1B5…9029 (6 dp)
//   priceToken  WHSK 0xB210…1Cf1 (18 dp)           WBTC 0x6119…5b14 (8 dp)
//   oracle      SupraAggregatorAdapter, pair 517    SupraAggregatorAdapter, pair 0
//               (HSK/USD; over Supra storage 0x58e1…3d57; addresses in deployments/177.json; AggregatorV3, 8 dp)
//   pool        WHSK/USDT 3000 0x4ff5…05dc          WBTC/USDT 3000 0xd9EA…449A
//   router      SwapRouter02 0x2c16…D8F3 (7-field exactInputSingle, no deadline) — both
//   factory     HSKSwap V3 0x972c…c742 — both; fee read once from pool.fee()
// Derived immutables: priceDecimals = IERC20Metadata(priceToken).decimals();
//   SCALE = 10^(priceDecimals + 2)   (1e20 for WHSK, 1e10 for WBTC; §4.2 Units and math)
// Constructor asserts (revert ConstructorCheck(uint8 which) on failure; all verified for BOTH pools by
// the Anvil-fork smoke before the mainnet deploy, §21.4):
//   factory.getPool(quoteToken, priceToken, fee) == pool; pool.factory() == factory
//   pool.token0() == priceToken && pool.token1() == quoteToken      (orientation the math assumes;
//                                       holds for both pools: 0xB210… and 0x6119… sort below 0xF1B5…)
//   priceDecimals ∈ {8, 18} && IERC20Metadata(quoteToken).decimals() == 6
//   router.factory() == factory; static call to router.positionManager() succeeds (SwapRouter02-only, §6.2)
//   oracle.decimals() == 8 (P is used as read, no rescaling or rounding; the adapter's decimals() is constant 8)
// v0.1 supports exactly this shape (8- or 18-dp token0 priced in a 6-dp USD-stable token1, 8-dp
// AggregatorV3 feed); other orientations/decimals are v1.0 (§24).

struct Limits {
    uint128 maxTradeUsd;           // 8 dp; 0 = disallow
    uint128 maxEpochUsd;           // 8 dp
    uint128 maxExposureUsd;        // 8 dp; cap on this vault's priceToken holdings valued at oracle, enforced at every buy
    uint32  epochDuration;         // seconds, > 0
    uint16  maxSlippageBps;        // vs oracle-derived expected output, ≤ 1000
    uint16  maxOracleDeviationBps; // |pool − oracle| bound for spot AND 5-min TWAP, ≤ 1000
    uint16  maxExitDiscountBps;    // exit path only (§4.2 step 7b): TWAP may sit at most this far below
                                   // the oracle; maxOracleDeviationBps ≤ x ≤ 2000
    uint32  maxOracleAge;          // seconds, 300 ≤ x ≤ 172800
    uint32  cooldown;              // seconds between executions
}

struct SwapParams {
    address tokenIn;       // must be quoteToken or priceToken
    uint256 amountIn;      // tokenIn smallest units
    uint256 minAmountOut;  // tokenOut smallest units
    uint256 deadline;      // enforced by the vault (SwapRouter02 has no deadline field)
    bytes32 proposalId;    // = hash of the proposal's journal record (§13); anchors the journal on-chain
}

// Reason codes returned by check(); mirrored 1:1 by custom errors on execute().
uint8 constant OK                     = 0;
uint8 constant ERR_PAUSED             = 1;
uint8 constant ERR_NOT_AGENT          = 2;
uint8 constant ERR_ZERO_AMOUNT        = 3;
uint8 constant ERR_DEADLINE           = 4;
uint8 constant ERR_PAIR_NOT_ALLOWED   = 5;
uint8 constant ERR_ORACLE_INVALID     = 6;
uint8 constant ERR_ORACLE_STALE       = 7;
uint8 constant ERR_ORACLE_DEVIATION   = 8;
uint8 constant ERR_TRADE_CAP          = 9;
uint8 constant ERR_EPOCH_CAP          = 10;
uint8 constant ERR_COOLDOWN           = 11;
uint8 constant ERR_SLIPPAGE           = 12;
uint8 constant ERR_BALANCE            = 13;
uint8 constant ERR_EXPOSURE           = 14;
uint8 constant ERR_EXIT_PRICE         = 15;  // deviation failed and the exit path (step 7b) is not available

interface IPolicyVault {
    // ---- owner ----
    function setAgent(address agent) external;
    function setGuardian(address guardian) external;
    function setLimits(Limits calldata l) external;    // reverts on out-of-bounds values
    function unpause() external;
    function withdraw(address token, address to, uint256 amount) external;
    function transferOwnership(address next) external; // two-step
    function acceptOwnership() external;

    // ---- agent / guardian ----
    function pause() external;                         // owner, agent or guardian
    function execute(SwapParams calldata p, bytes32 rationaleHash) external returns (uint256 amountOut);

    // ---- views ----
    function check(address caller, SwapParams calldata p)
        external view returns (uint8 reason, uint256 notionalUsd, uint256 oraclePrice, uint256 minOutFloor,
                               bool exitPath);
    function epoch() external view returns (uint256 index, uint256 start, uint256 spentUsd, uint256 capUsd);
    function limits() external view returns (Limits memory);
    function exposureUsd() external view returns (uint256);   // 8 dp; formula and revert rules in §4.2 Units
    function agent() external view returns (address);
    function guardian() external view returns (address);
    function owner() external view returns (address);
    function paused() external view returns (bool);
    function quoteToken() external view returns (address);
    function priceToken() external view returns (address);
    function priceDecimals() external view returns (uint8);
    function oracle() external view returns (address);
    function router() external view returns (address);
    function pool() external view returns (address);
    function factory() external view returns (address);
}
```

### 4.2 Execution rules (normative)

`execute` is `nonReentrant` and evaluates checks in this fixed order so `check()` and `execute()` return
the same first failing reason, the same `minOutFloor` and the same `exitPath` flag:

1. `paused` → `ERR_PAUSED`
2. `msg.sender != agent` → `ERR_NOT_AGENT`
3. `amountIn == 0` → `ERR_ZERO_AMOUNT`
4. `block.timestamp > deadline` → `ERR_DEADLINE`
5. `tokenIn ∉ {quoteToken, priceToken}` → `ERR_PAIR_NOT_ALLOWED`; `tokenOut` is the other one
6. Oracle read via `try oracle.latestRoundData()`; a revert → `ERR_ORACLE_INVALID`. `answer <= 0`,
   `updatedAt == 0` or `updatedAt > block.timestamp` → `ERR_ORACLE_INVALID`; `block.timestamp − updatedAt >
   maxOracleAge` → `ERR_ORACLE_STALE`. The `answeredInRound < roundId` clause is included (the Nov 2 mainnet
   read showed both APRO feeds return `answeredInRound == roundId`, Q7); on the Supra adapter it never
   fires (`answeredInRound = roundId`). `oracle` is a `SupraAggregatorAdapter` (§5.1): an unpopulated pair
   returns zeros (`answer <= 0`, `updatedAt == 0`) → `ERR_ORACLE_INVALID`; its `updatedAt` is capped at
   `block.timestamp`, so a proof up to 3 s ahead never trips the `updatedAt > block.timestamp` check. `P` = `answer` (8 dp; the constructor asserts `oracle.decimals() == 8`).
7. **Deviation.** Spot `S` from `slot0`; TWAP `T` from `try pool.observe([300, 0])`: mean tick
   `t̄ = (tickCumulative[1] − tickCumulative[0]) / 300`, rounded toward −∞ (subtract 1 when the
   difference is negative and not divisible), `sqrtP = TickMath.getSqrtPriceAtTick(t̄)` (Uniswap v4-core
   `TickMath`, Solidity 0.8; the v3 name `getSqrtRatioAtTick` does not exist there), then the spot
   formula below. `devBps(X) = mulDivUp(|X − P|, 10^4, P)`.
   - **7a — normal path:** `observe()` succeeded and `devBps(S) ≤ maxOracleDeviationBps` and
     `devBps(T) ≤ maxOracleDeviationBps` → continue with price basis `Pfloor = Pcap = P`, `exitPath = false`.
   - Otherwise, if `tokenIn == quoteToken` (a buy) or `observe()` reverted → `ERR_ORACLE_DEVIATION`.
   - **7b — exit path** (sells of `priceToken` only; a sell can only reduce exposure): allowed iff
     `T ≥ mulDivUp(P, 10^4 − maxExitDiscountBps, 10^4)`; else → `ERR_EXIT_PRICE`. On the exit path
     `exitPath = true`, `Pfloor = min(P, T)` (the floor follows whichever of oracle and 300 s TWAP is lower,
     so a TWAP lagging *above* spot in a fast drop does not set an unmeetable floor) and `Pcap = max(P, T)`
     (notional counts the higher value against the caps). Because `T ≥ P·(1 − maxExitDiscountBps)`,
     `min(P, T) ≥ P·(1 − maxExitDiscountBps)` and the §4.6 bound is unchanged. Every other step still
     applies: trade cap, epoch cap, cooldown, slippage floor and balance. The guarantee is the
     `maxExitDiscountBps` bound, not arbitrage cost: on a pool with ~31 swaps/day, holding the TWAP down for
     300 s costs an attacker little more than round-trip fees (~$70 to push the ~$874k WHSK pool 5%, less
     on the ~$101k WBTC pool), and it gains at most the §4.6 exit term ($7.50 extra per vault per episode
     at defaults; exit-path notional still counts against the epoch cap).
8. `notionalUsd` (at `Pcap`) `> maxTradeUsd` → `ERR_TRADE_CAP`
9. Epoch rollover (below); `spentUsd + notionalUsd > maxEpochUsd` → `ERR_EPOCH_CAP`
10. `lastTradeAt != 0 && block.timestamp < lastTradeAt + cooldown` → `ERR_COOLDOWN`
11. `minAmountOut < minOutFloor` (at `Pfloor`) → `ERR_SLIPPAGE`
12. `balanceOf(this, tokenIn) < amountIn` → `ERR_BALANCE`
13. Buys only (always 7a): `exposureUsd() + mulDivUp(notionalUsd, 10^4, 10^4 − maxOracleDeviationBps)` >
    `maxExposureUsd` → `ERR_EXPOSURE`. The second term upper-bounds the oracle value of the output when
    the pool behaves (7a keeps spot within the deviation of `P`; fee and impact only reduce output). It is
    a pre-check so `check()` can report it; step 16 enforces I12 regardless of pool behaviour. Sells are
    never blocked by exposure.
14. **Effects before interaction:** `spentUsd += notionalUsd`, `lastTradeAt = block.timestamp`
15. `forceApprove(router, amountIn)` → SwapRouter02 `exactInputSingle` on the fixed pool's fee tier with
    **`recipient = address(this)`** → `forceApprove(router, 0)`
16. Post-conditions: `tokenIn` balance decreased by **at most** `amountIn` (SwapRouter02 can pay its
    `WETH9` — WHSK — from its own native balance; irrelevant for WBTC); `tokenOut` balance increased by `≥ minAmountOut`; router allowance is 0;
    **buys: `exposureUsd()` recomputed from post-swap balances at `P` ≤ `maxExposureUsd`, else revert
    `Exposure(...)`** (so I12 holds by construction even against a misbehaving pool or router).
    Accounting uses the pre-swap `notionalUsd` (an upper bound, step 14); the event reports the measured
    deltas. Any failure reverts the whole call.
17. Emit `TradeExecuted` (with `exitPath`).

There is no `transferFrom` from any third party and no path that sends tokens anywhere except back to
the vault, other than owner `withdraw`.

**Units and math.** `P`, `S`, `T` are USD per whole `priceToken` in 8 dp; USDT has 6 dp; `priceToken` has
`d = priceDecimals` (18 for WHSK, 8 for WBTC; read and asserted in the constructor); `SCALE = 10^(d+2)`
converts between a `d`-dp token amount, an 8-dp USD price and a 6-dp USDT amount (`10^d / 10^6 × 10^8`).
Pool fee `f` in hundredths of a bip (`3000` = 0.30%). All products use
OpenZeppelin `Math.mulDiv` (512-bit intermediate). Rounding always favours the vault: notional rounds
**up** (counts more against caps), `expectedOut` and `minOutFloor` round **up** (demand more output),
deviation rounds **up**; `P` is the 8-dp answer as read (no rescaling, constructor-asserted).

| Quantity | Buy (USDT → priceToken) | Sell (priceToken → USDT) |
|---|---|---|
| `notionalUsd` (8 dp) | `amountIn × 10^2` | `mulDivUp(amountIn, Pcap, 10^d)` |
| `expectedOut` | `mulDivUp(amountIn, SCALE, Pfloor)` | `mulDivUp(amountIn, Pfloor, SCALE)` |
| `minOutFloor` | `mulDivUp(expectedOut, (1e6 − f) × (1e4 − maxSlippageBps), 1e10)` | same |
| Pool price `S` or `T` (8 dp) | `mulDiv(mulDiv(sqrtPriceX96, sqrtPriceX96, 2^96), SCALE, 2^96)` with token0 = priceToken, token1 = USDT (= sqrtP² · 10^(d−6) · 10^8 / 2^192) | — |
| Deviation (bps) | `mulDivUp(absDiff(X, P), 10^4, P)` for `X ∈ {S, T}` | same |

Worked check (both instances, values from §0.2): WHSK `d = 18`, `SCALE = 1e20` — identical to v0.6's
constants. WBTC `d = 8`, `SCALE = 1e10`: a $25 buy (`amountIn = 25e6`) at `P = 7,792,502,000,000`
(77,925.02) expects `mulDivUp(25e6, 1e10, P) = 32,083` sats-units (0.00032083 WBTC); selling that back
at the same `P` gives notional `mulDivUp(32,083, P, 1e8) ≈ 25.0e8`. Pool price: `sqrtP²/2^192 ≈ 771.4461`
raw USDT units per raw WBTC unit, × `SCALE` = `7,714,461,000,000` (77,144.61). The Foundry suite and
the TS mirror run every formula for both `d` values (§18.2).

**Exposure.** `exposureUsd() = mulDivUp(IERC20(priceToken).balanceOf(this), P, 10^d)` (8 dp, rounds up),
with `P` read and validated exactly as in step 6; the view reverts `OracleInvalid` / `OracleStale` under
the step-6 conditions (never returns a value from a bad round). Steps 13 and 16 compute the same formula
with the `P` already read in step 6 of that call, so pre-check, post-check and view agree. Unit-tested for
both shapes (§18.2).

The TypeScript mirror in `packages/core` implements the same formulas with `bigint` and the same rounding;
the Demo Day parity suite compares them (§18.2).

USDT is valued at $1.00 (peg assumption, documented; APRO USDT/USD is read by direct `eth_call` for display and a `doctor`
warning above 50 bps depeg). WBTC is valued at Supra BTC/USD (bridge-peg assumption, documented; `doctor`
warns when the WBTC pool sits > 250 bps from both the oracle and the CEX mid, i.e. the pool, not the oracle,
disagrees with BTC).

**Honest-path `minAmountOut`.** The daemon never submits the floor. At `ate_execute` time (not propose
time) it re-runs QuoterV2, `check()` **and the strategy guard (§11.4 rules 2–9, §7.4)**, and submits `max(minOutFloor, quoterOut × (1 − 50 bps))` with
`deadline = now + 60 s`; if the fresh quote is > 50 bps worse than the quote at propose it rejects with
`ATE_SLIPPAGE` instead. It records both values. The floor is the backstop against a lying agent; the
quote-based value protects honest trades from back-running.

**Slippage baseline.** The floor comes from the oracle (or, on the exit path, the pool's own 300 s TWAP),
never from a passed-in quote, so an agent cannot widen its own tolerance by lying about the market.
Because the oracle may lag (§5.2), step 7 bounds how far the pool may sit from it. When the pool drifts
beyond the bound, **buys** are blocked with `ERR_ORACLE_DEVIATION` until the oracle's next update (a Supra push on a 0.5% move or the 6 h heartbeat, or the daemon's
on-demand pull refresh, §5.2); **sells** remain possible through the exit path, so stop-loss and flatten are not trapped by
a lagging oracle (they still wait in the cases listed in §11.4 *Oracle lag*). Both are surfaced explicitly, never silently.

**Epochs.** Fixed, aligned windows: `index = floor(t / epochDuration)`, `start = index × epochDuration`.
A tumbling window allows up to `2 × maxEpochUsd` inside any rolling 24 h; this is accepted and included in
§4.6. `setLimits` does not reset `spentUsd` for the current index; changing `epochDuration` changes the
index, which resets `spentUsd` — an owner-intended effect, documented and emitted in `LimitsUpdated`.

**No agent-chosen pool or fee tier.** `SwapParams` has no pool or fee field. The agent cannot route into an
attacker-seeded pool, and the owner cannot be tricked into doing so either, because the pool is immutable.

**Gas float.** The agent EOA (one key, `agent` on both vaults) holds **25 HSK** (~$2.20; a vault
`execute` plus its EAS `attest` costs ~0.2 HSK at ~500 gwei, so ~125 trade+attest pairs, above both
markets' combined daily volume); the guardian holds 2 HSK (two `pause` txs per pause-all). `ate doctor`, the Agents view and `/events` (`gas.low`) alarm below 2 HSK; below 1 HSK the daemon
stops attesting (an `attestation` record marked deferred, back-filled after top-up) so the remaining gas goes to
trades, exits and pause. A compromised daemon can burn the agent's float (including on junk EAS
attestations); it is outside the vault and outside §4.6.

### 4.3 Events

```solidity
event TradeExecuted(
    address indexed agent,
    address indexed tokenIn,
    address indexed tokenOut,
    uint256 amountIn,
    uint256 amountOut,
    uint256 notionalUsd,
    uint256 oraclePrice,
    bytes32 proposalId,
    bytes32 rationaleHash,
    bool    exitPath
);
event LimitsUpdated(address indexed owner, bytes32 limitsHash, uint256 epochIndex, uint256 spentUsd);
event AgentUpdated(address indexed previousAgent, address indexed newAgent);
event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
event Paused(address indexed by);
event Unpaused(address indexed by);
event Withdrawn(address indexed token, address indexed to, uint256 amount);
event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

Custom errors carry the reason code and context (e.g. `TradeCap(uint256 notionalUsd, uint256 cap)`,
`ExitPrice(uint256 twap, uint256 oracle, uint16 maxExitDiscountBps)`) so Blockscout decodes reverted
transactions for judges. The error set and the `IPolicyVault` ABI are frozen at 10:30 IST (§21.4) and
exported as JSON for the daemon and the TS mirror.

### 4.4 Invariants (must hold under fuzzing)

| ID | Invariant |
|---|---|
| I1 | `execute` never makes `spentUsd > maxEpochUsd` within an epoch index |
| I2 | `execute` from any address other than `agent` reverts |
| I3 | Vault token balances decrease only via `execute` (by ≤ `amountIn` of `tokenIn`) or owner `withdraw` |
| I4 | Every successful `execute` increases the vault's `tokenOut` balance by `≥ minAmountOut ≥ minOutFloor` |
| I5 | `withdraw`, `setLimits`, `setAgent`, `setGuardian`, `unpause`, `transferOwnership` succeed only for `owner`; `acceptOwnership` only for the pending owner |
| I6 | `paused == true` ⇒ `execute` reverts |
| I7 | `execute` never emits `TradeExecuted` with `notionalUsd > maxTradeUsd` |
| I8 | Oracle invalid/stale ⇒ `execute` reverts; pool spot or TWAP beyond `maxOracleDeviationBps` ⇒ `execute` reverts unless it is an exit-path sell (I13) |
| I9 | Router allowance is 0 after every call |
| I10 | `check(agent, p)` returns `OK` and sufficient pool liquidity ⇒ `execute(p)` does not revert for a policy reason, and both report the same `minOutFloor` and `exitPath` |
| I11 | Normal-path per-trade execution loss measured at the oracle price ≤ `notionalUsd × (maxSlippageBps + feeBps) / 10000` (+1 unit rounding) |
| I12 | After any successful buy, priceToken holdings valued at oracle ≤ `maxExposureUsd` (enforced post-swap, step 16) |
| I13 | `exitPath == true` ⇒ `tokenIn == priceToken`, TWAP ≥ `P × (1 − maxExitDiscountBps / 10^4)`, priceToken holdings do not increase, and `tokenOut` increases by ≥ `minAmountOut` ≥ floor at `min(P, TWAP)` |

Submission gate (local mocks for pool, router, factory and aggregator, Foundry `[invariant] runs = 64,
depth = 32` (~2k calls), 6 handler actors: agent, guardian, owner, hostile EOA, pool manipulator, oracle
mover), **run for both priceToken shapes (18-dp and 8-dp mocks)**: unit tests for every reason code 1–15,
`check()`/`execute()` parity, fuzzed invariants I1–I4, I6, I8, I9, I11–I13, and the remaining three by
named tests — **I5** (each owner function called from agent, guardian and a hostile EOA reverts;
`acceptOwnership` only from the pending owner), **I7** (asserted by the fuzz handler on every
`TradeExecuted`, plus the `ERR_TRADE_CAP` unit test), **I10** (the parity suite: every reason code, and an
`OK` `check()` followed by a successful `execute()` with equal `minOutFloor`/`exitPath`) — an `exposureUsd()`
unit test (formula, rounding, oracle-revert), an exit-path test where `T > P`
(floor at `P`) and one where `T < P` (floor at `T`) — **plus an Anvil-fork smoke of both vaults against
the real HSKSwap factory, both pools, SwapRouter02 and both Supra adapters before the mainnet deploy**
(constructor asserts, `check()`, a $5 buy and sell per vault, a forced deviation that exercises 7b;
§21.4). Demo Day gate: all invariants at `runs = 500, depth = 100`, 8 actors, both shapes, plus the fork
suite.

### 4.5 Upgrade and admin policy

Non-upgradeable: an upgrade proxy is an owner-key risk that would undermine G4. Pair, oracle, router and
pool are immutable; migration is `withdraw` → new vault. Ownership transfer is two-step.

**Owner operations never happen on the agent's machine.** The owner uses `ate-owner`, a separate CLI run
on a different machine (or a Safe), which takes **typed arguments** (`ate-owner set-limits
--vault btc --max-epoch-usd 400 …`), reads current state from its own pinned RPC list, prints a full before/after
diff, and signs with a Ledger (`--ledger`, tested on 177 at 10:30 IST) or, if Ledger signing on 177 fails,
a `cast wallet` encrypted keystore created and used only on that second device (`--account owner`). The
daemon may *suggest* a change in plain words ("user asked to raise the daily cap to $800"); it never
produces calldata for the owner to sign. The Safe is deployed on 177 but its hosted UI is not; Safe
transactions use `safe-core-sdk` or the self-hosted interface. v0.1 uses the Ledger (or keystore) owner;
v1.0 defaults to a 2-of-3 Safe.

### 4.6 Worst-case bounds (the numbers in the pitch)

Value cannot leave a vault except through owner `withdraw` (I3). An agent — or anyone holding its key,
which is `agent` on both vaults — can cause two kinds of loss. Every bound below is **per vault**; the
**portfolio** bound is the sum over the two vaults, because each vault enforces its own limits
independently and the off-chain portfolio guard (§11.4) can only tighten them.

**1. Execution loss** (buying above or selling below fair value). Two terms: oracle vs fair value, and
execution vs oracle. Execution vs oracle is ≤ slippage + fee on the normal path (I11). Oracle vs fair is
the **oracle assumption**: the Supra pairs push every ~6 h or on a 0.5% (50 bps) move and anyone can
pull-refresh on demand (§5.2), so we assume the Supra price is within 250 bps of fair. The 250 bps term
covers the 0.5% push threshold with 200 bps of margin for push latency, committee/exchange-source
differences and gaps between pushes; the numeric bound is unchanged from v0.9.0 (it was sized for APRO's
~2% threshold). The oracle-vs-fair term is therefore `A = max(maxOracleDeviationBps, 250)` — never below
the oracle assumption, even if the owner tightens the deviation bound. (The pool is *not* assumed to be
fair; under manipulation it is not — the bound rests on the oracle, i.e. on Supra.)

```
A                    = max(maxOracleDeviationBps, 250)
normalLossPerEpoch   = maxEpochUsd × (A + maxSlippageBps + feeBps) / 10000          (per vault)
normalLossRolling24h = 2 × normalLossPerEpoch      (one epoch boundary inside the window)
```

Defaults (§19 step 3, both vaults): `maxEpochUsd = $250`, deviation 250 bps (so `A = 250`), slippage
250 bps, fee 30 bps → **$13.25 per vault per UTC day (epoch = UTC day), $26.50 for the portfolio; $53
for the portfolio over any rolling 24 h; 5.3% of capped turnover**, on the normal path.

**Exit-path term (step 7b).** Exit sells are floored at `min(P, T)`, which may sit up to
`maxExitDiscountBps` (default **500**) below the oracle price `P`. The oracle-vs-fair term still applies on this path,
so the worst-case loss of an exit sell versus fair value is `A + maxExitDiscountBps + maxSlippageBps +
feeBps` = 1030 bps, and the **extra versus the normal path is exactly `maxExitDiscountBps`**:

```
extraPerEpisode   = exitNotional × maxExitDiscountBps / 10000          (exitNotional ≤ position, per vault)
maxLossPerEpoch   = maxEpochUsd × (A + maxExitDiscountBps + maxSlippageBps + feeBps) / 10000   (per vault)
maxLossRolling24h = 2 × maxLossPerEpoch
```

At defaults: **≤ $150 × 500 bps = $7.50 extra per vault per deviation episode** (a position at the $150
cap), and across all paths together **≤ $250 × 1030 bps = $25.75 per vault per UTC day — $51.50 for the
portfolio, $103 over any rolling 24 h** — a ceiling that holds whatever mix of normal and exit trades
fills the epochs. Only sells take this path, a sell only reduces exposure, and exit notional shares the
same `maxEpochUsd` budget. The extra loss materialises only if the TWAP is held below fair value for
300 s; when the oracle is simply lagging a real drop, the exit is the loss-*reducing* trade.

**Honest-path MEV.** On the honest path the daemon submits `minAmountOut = max(floor, quote × 0.995)`
(§4.2), so a sandwich or back-run of an honest trade costs at most ~50 bps plus the fee, not the 530 bps
rogue bound; $5–$100 clips are also too small to pay a sandwich's own fees on either pool.

**2. Market exposure.** A vault holding its priceToken moves with it. I12 caps each vault's holdings at
`maxExposureUsd` (default **$150 per vault**, so ≤ $300 on-chain for the portfolio; the portfolio guard
holds the off-chain total to `portfolio.maxExposureUsd`, default $200, §11.4) **at every buy** (pre-check
and post-swap check); price appreciation or an owner deposit can lift holdings above it between buys,
and sells are never blocked. The off-chain stop-loss (§11.4) manages price risk within that cap. Market
loss on the held exposure is bounded by the stop-loss, not by the contract — and not at all while the
vault is paused (§11.4).

**Assumptions — the bound does not hold if they fail:**
- The Supra feed is live and within 250 bps of fair value (HSK/USD pair 517 for Vault-HSK, BTC/USD pair 0
  for Vault-BTC; pushes every ~6 h or on a 0.5% move, plus on-demand pull refresh, §5.2). If the oracle
  reports a wrong but fresh price, execution loss per vault per UTC day is bounded by **≤ $250 of USDT
  plus the fair value of its priceToken holdings**, never more than the vault: within one epoch buys at a
  wrong-high oracle can spend up to the oracle-valued notional cap (`maxEpochUsd`) of USDT, and sells at a
  wrong-low oracle (pool held near it) can count holdings at the wrong `P`; both can happen if the oracle swings.
  Portfolio: ≤ $500 of USDT plus both vaults' priceToken holdings, never above the two vaults.
- USDT holds its peg; WBTC holds its BTC peg.
- Agent/guardian gas floats (25 HSK ≈ $2.20 and 2 HSK) are excluded.

On the default seed (~$280 across both vaults: Vault-HSK ~$120 USDT + ~$60 WHSK, Vault-BTC ~$100 USDT;
§19 step 5), $26.50 is ~9.5% of the portfolio per day on the normal path and $51.50 ~18% in the absolute
worst case. The owner tunes this ratio with `maxEpochUsd` and the deposit size; the UI shows the bound
per vault and for the portfolio, as dollars and as a percentage, computed from live `limits()` with the
same `A = max(maxOracleDeviationBps, 250)`.

**Pitch card.** Spoken: **one number** — "the stolen key can never withdraw a cent, and the contract caps
what bad trades can cost at $51.50 a day, about 18% of this demo wallet" (both vaults, all paths, while
the Supra feed is live). **The pitch card shows three items only:** "Key can never withdraw · ≤ $51.50 per UTC day
of execution loss across both vaults, every path, while the Supra feed is live (~18%) · exposure ≤ $150 per vault",
with the footnote below. **The Q&A *numbers* card** (not the pitch) says, exactly this way: "While the Supra
feed is live: execution loss across both vaults ≤ $51.50 per UTC day on every path (≤ $103 over any rolling
24 h); ≤ $26.50 per UTC day on the normal path (≤ $53 rolling); oracle-lag exits add ≤ $7.50 per vault
per episode, inside those totals. Per vault, half of each. If the oracle is wrong: per vault ≤ $250 of USDT
plus its token holdings, never above the vault. Exposure ≤ $150 per vault at every buy; price risk on it
is managed by the stop-loss, not the contract." The card itself (not only a footnote) carries the line
**"Price risk on held exposure (≤ $150/vault): stop-loss, not contract."**

### 4.7 `AgentRegistry.sol` (v1.0 only)

Maps `agentKey → (vault, label, createdAt, revokedAt)` so the UI can enumerate agents across vaults
without scanning. Not required for v0.1: the daemon stores agent metadata locally.

---

## 5. Oracle and market data

### 5.1 Sources

| Source | Mode | Use |
|---|---|---|
| Supra HSK/USD pair 517 (Vault-HSK), Supra BTC/USD pair 0 (Vault-BTC), via each vault's `SupraAggregatorAdapter` over storage `0x58e1…3d57` | push every ~6 h or on a 0.5% move, plus daemon pull refresh; on-chain `getSvalue` (no access control), read in the per-cycle Multicall3 | **vault enforcement baseline** (the vault's immutable `oracle`), UI reference. The adapter is AggregatorV3-shaped: 8 dp, rounds down, ms→s, `updatedAt` capped at `block.timestamp`, unpopulated pair → zeros → `ERR_ORACLE_INVALID` (§0.2, §4.1) |
| Pool `slot0` / `liquidity` (both pools) | on-chain read | instantaneous price, depth, deviation check |
| Pool `observe()` 300 s TWAP (observation cardinality 240 on both pools, §0.2; `doctor` requires ≥ 64) | on-chain read | vault deviation check alongside spot and exit-path floor (§4.2 step 7); stop-loss mark cross-check (§11.4); UI line |
| HashKey Global `ticker/24hr`, `bookTicker`, `depth`, `trades`, `kline` for HSKUSDT and BTCUSDT (public, no key) via the official `hashkey-public-market` skill (site `glb`) | HTTP | reference mid, half-spread and top-of-book depth for spread signals (§11.3); depth/trades for the LLM's judgement (§11.1); klines for `ate replay` (E11). The daemon reader follows the skill's endpoint map, symbol validation and timestamped-result rules; the trader agent loads the skill itself |
| APRO HSK/USD, BTC/USD (and USDT/USD for display) | push/threshold, on-chain; **EOA / allow-listed callers only (§0.2)**, so read by direct `eth_call` from the daemon EOA, never inside Multicall3 and never by the vault | **Off-chain entry gate + cross-check (not in the enforcement path).** Per market, every cycle: if Supra and APRO disagree by > `supra.maxDisagreeBps` (250), the daemon emits **no entry candidates** for that market (spread-revert open, rebalance buys, discretionary buys refused by the guard) and journals one suppression record per episode (`no_trade`, `engine=guard`, `context.suppressed.cause = "oracle_disagree"`, both prices and ages); exits, closes, guard exits and `discretionary_exit` are unaffected. An APRO read that fails (no access, RPC) or is > `maxOracleAge` old leaves the gate inactive for that market — stated in `doctor` and the badge (Supra and the vault still bind). `ate doctor` prints Supra and APRO side by side with the gap in bps and both ages; the Trade view shows a second-oracle badge. Never read by the vault or used for sizing. If APRO later allow-lists a vault address, an APRO-backed vault can be deployed (`ORACLE_SOURCE=apro`, same bytecode; §25 Q13) |

### 5.2 Staleness and refresh policy

The vault's oracle is a Supra pair: it pushes on HashKey Chain every ~6 h or on a 0.5% move (observed ages at
read: HSK/USD 4.4 h, BTC/USD 3.5 h), so a quiet market produces rounds hours old, and anyone can refresh a
pair on demand with a signed proof. Therefore:

- `maxOracleAge` default **90000 s** (unchanged from v0.9.0; a ~6 h heartbeat makes it ample, and keeping
  the value leaves limits, tests and the §4.6 numbers untouched), configurable 300–172800 s.
- `maxOracleDeviationBps` defaults to **250** and `maxSlippageBps` to **250**. Supra's 0.5% push
  threshold sits far inside the 250 bps bound, so legitimate trades are not rejected near an update; the UI
  shows the margin to each bound. The numeric bounds are unchanged from v0.9.0 (§4.6).
- Staleness alone is not trusted: the pool-deviation check (§4.2 step 7) bounds how wrong a stale price
  can be at trade time.
- **Refresh (daemon, `oracle_refresh`).** `POST https://rpc-mainnet-dora-2.supra.com/get_proof` with
  `{"pair_indexes":[0,517],"chain_type":"evm"}` (both pairs in one proof) → `verifyOracleProof(proof_bytes)` on
  the pull contract `0x16f7…C3dD`, sent from the agent key through `TxQueue` (~330k gas for both pairs,
  ≈ 0.17 HSK; permissionless and idempotent — it writes only rounds newer than stored and rejects rounds
  > 3 s ahead). The daemon refreshes (a) before building or executing an entry when the market's Supra
  age exceeds `refreshThresholdSec` (default **1800**, per market), (b) whenever `check()` returns
  `ERR_ORACLE_STALE` on any side, including a guard exit, and (c) never on a timer alone. A refresh
  enqueued for an execute takes that execute's priority and nonce order ahead of it (§7.1); the execute
  then re-runs `check()`. Each refresh is journalled as kind `oracle_refresh` (tx hash, pairs, age before and
  after, gas). If the proof endpoint or the tx fails, the market behaves as stale (§5.3); any third party may also
  pull. The vault never depends on the daemon's refresh: it reads whatever the storage holds and applies
  `maxOracleAge`.
- The UI renders a **health badge** (`fresh` < 1 h, `aging` < `maxOracleAge`, `stale` ≥ `maxOracleAge`) plus a
  **deviation badge** (pool vs oracle, bps), and blocks execution client-side before the chain would revert.
- Every proposal records the oracle snapshot (`answer`, `updatedAt`, `roundId`) and pool snapshot.

### 5.3 Health and failover

`OracleService.getPrice(market)` returns a `PriceSnapshot` from the market's Supra pair. If the pair is
unavailable or invalid (adapter returns zeros, storage read fails) or stale beyond `maxOracleAge` and the
refresh in §5.2 fails, the daemon puts **that market** in read-only mode and refuses to build its
transactions; the other market keeps trading. **No silent fallback to DEX spot** — that would make
the enforcement baseline manipulable — and **no fallback to APRO**, which the vault cannot read. A failed
APRO cross-check read only deactivates the entry gate for that market (§5.1). If a market's HashKey Global ticker is unavailable, its `spread-revert` and `rebalance`
emit no candidates (the edge gate cannot be computed); go-to-cash sell-downs (guard, §11.4 rule 9),
stop-loss, take-profit, `discretionary_exit` and the circuit breaker keep running on the pool TWAP alone.

---

## 6. Venue adapters

### 6.1 Interface

```ts
export interface VenueAdapter {
  readonly id: string;               // "hsk-dex"
  readonly chainId: number;          // 177
  listMarkets(): Promise<Market[]>;
  getMarket(marketId: string): Promise<MarketState>;   // v1.0 second implementation: Kredo prediction market
  quote(req: QuoteRequest): Promise<Quote>;
  simulate(req: QuoteRequest): Promise<Simulation>;   // eth_call, no state change
  buildExecute(q: Quote, opts: BuildOpts): Promise<TxRequest>;  // PolicyVault.execute calldata
  parseReceipt(tx: TransactionReceipt): ParsedFill;
}
```

### 6.2 `hsk-dex` adapter

- **Market ids:** `hsk-dex:WHSK/USDT:3000` (Vault-HSK) and `hsk-dex:WBTC/USDT:3000` (Vault-BTC). These
  two strings are the only valid `market` values in v0.1; any other → `ATE_MARKET_UNKNOWN`.
- **Chain reads:** per pool `slot0()` (incl. `observationCardinality`), `liquidity()`, `fee()`, token
  `balanceOf(pool)`. Both pools' observation cardinality is 240 (read Nov 2, §0.2); `ate doctor --chain`
  re-checks ≥ 64 on both (the 300 s TWAP needs an observation ≥ 300 s old to survive our own swaps) and
  that `observe([300, 0])` succeeds. No cardinality transaction is planned.
- **Canonical quote:** QuoterV2 `0x603f…bFDD` `quoteExactInputSingle` (paired with the HSKSwap factory;
  two independent quoters returned identical results on Nov 2; quote vs fork execution is checked once in
  the pre-deploy Anvil-fork smoke and as a 1 bps suite on Demo Day, §18.2). Fallback: `eth_call` of the router **with a state override**
  granting balance and allowance — a plain `eth_call` from an EOA reverts. Local math is used only for the
  instant estimate while the call is in flight.
- **Batching:** the public RPC and Blockscout rate-limit bursts. Per-cycle reads for **both** markets
  (two pools, two Supra pairs, two vaults) go through Multicall3 (`0xcA11…CA11`) in one call; never fan
  out parallel `eth_call`s. The two APRO cross-check reads are the exception: APRO refuses contract callers, so they
  are direct `eth_call`s from the daemon EOA (two extra calls per cycle, outside the batch).
- **Pre-flight:** before broadcasting, `eth_call` `PolicyVault.execute` from the agent address at the
  latest block. This is exact and includes policy; a revert here is reported with its decoded reason and
  the tx is not sent (except in the rogue-agent demo, §22, which deliberately broadcasts with a fixed gas
  limit so rejections land on-chain).
- **Router binding:** `PolicyVault` v0.1 is compiled against the **SwapRouter02** interface: 7-field
  `ExactInputSingleParams (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum,
  sqrtPriceLimitX96)`, no `deadline` — the vault enforces `deadline` itself (§4.2 step 4). SwapRouter v1
  (`0x56d1…fBf5`, 8 fields with `deadline`) is ABI-incompatible; pointing the vault at it would make
  every swap revert. Both routers return the same `factory()`, so that check cannot tell them apart; the
  router is therefore an **immutable** constructor argument (§4.1), and the constructor additionally
  requires a successful static call to SwapRouter02-only `positionManager()`.
- **Router selection:** SwapRouter02 `0x2c16…D8F3` (verified, factory-paired). No override.

### 6.3 Quote math (display path)

Constant-product estimate, labelled `estimate` in the UI and never used for `minAmountOut`:

```
amountOut = (amountIn × (1 − fee)) × reserveOut / (reserveIn + amountIn × (1 − fee))
impactBps = (spot − effective) / spot × 10000
```

V3 v1.0: compute from `sqrtPriceX96` and active `liquidity()` within the current tick range.

---

## 7. MCP tool surface

### 7.1 Server

- Transports: **Streamable HTTP** in the daemon (single endpoint `http://127.0.0.1:<port>/mcp`), per the
  current MCP specification, and **stdio** (`ate mcp serve`), which is a thin proxy to the running
  daemon's HTTP endpoint using the `agent` token from `runtime.json`; it never loads a key or opens its own
  chain connection. Bind to loopback only; validate `Origin` and reject browser origins (DNS-rebinding
  defence); require an `agent` or `chat` bearer token (§10.1). **The tool set is decided by the token
  scope, server-side:** `chat` tokens see and may call only the §11.5 allowlist (any other tool →
  `ATE_TOOL_NOT_ALLOWED`); `agent` tokens see the full trading set. The journal `actor` is derived from
  the scope (`agent` → `agent/mcp`, `chat` → `human/chat`), never from the route or the request body.
- **Single signer (`TxQueue`).** Every agent-key transaction for both vaults — LLM executes, guard exits,
  discretionary trades, Supra `oracle_refresh` pulls, EAS attests, `pause`, and `ate rogue` broadcasts — goes through one in-daemon
  queue that owns the nonce (local counter resynced from `eth_getTransactionCount(pending)` on start and
  on any nonce error). **At most one agent-key tx is in flight** (depth-1 pipeline; ~2 s blocks make this
  cheap), so priority — `pause` > guard exits > executes > attests — applies at every nonce, not only to
  unsigned txs (an `oracle_refresh` enqueued for an execute or guard exit runs ahead of it at that priority; a stand-alone refresh ranks with attests). A tx unmined after 20 s is **replaced at the same nonce** (re-signed by the queue; the
  only re-signing path); a `pause` or guard exit that arrives while an execute or attest is pending
  **replaces it at its nonce** (the displaced execute is re-queued only if its proposal is still valid;
  the attest re-queues). **Replacement fee rule:** every replacement sets `maxFeePerGas` and
  `maxPriorityFeePerGas` each to `max(original × 1.25, current suggested)`, which clears the node's
  minimum price bump. **Race:** if the displaced tx is mined first (the replacement fails nonce-too-low or
  the original's receipt arrives), the queue journals the displaced tx's outcome and **immediately
  re-signs the pause or exit at the next nonce**, ahead of anything else queued. Otherwise the queue
  re-broadcasts the identical raw tx. No other process holds the agent key.
- Name: `ate`. Version pinned to app version.
- Mutating tools: `ate_execute`, `ate_pause`, `ate_strategy_set`, `ate_signal_buy` (registered only when
  G-HSP is go). `ate_propose` and `ate_decide` write journal records but no chain state. All others are
  read-only.
- Clients: the trader runner (§11.1, `agent` scope), the Chat view / `ate chat` agent (§11.5, `chat`
  scope, allowlist enforced by the server) and any external MCP agent (`agent` scope). All write to the
  same journal.

### 7.2 Tools (v0.1)

| Tool | Mutates | Purpose |
|---|---|---|
| `ate_market_get` | no | Per market (or both if `market` is omitted): pool price, oracle snapshot + age, CEX reference (mid, half-spread, top-of-book depth, recent trades), deviation, depth |
| `ate_candidates_get` | no | Current daemon candidates for one or both markets: `[{ candidateId: "cand_<16hex>", market, generator, leg?, side, maxAmountIn, edgeBps, costBps, netEdgeBps, reason, expiresAt }]`, each valid `candidateTtlSec` (≥ 120 s, §11.1), plus `suppressed: [{ market, side, cause: "deviation" \| "oracle_disagree", bps }]` for entries the daemon withheld (§11.3); guard exits appear with `generator: "guard_exit"`; a standing `discretionary_exit` sell (`maxAmountIn` = min(position, trade cap, epoch remaining) in token units, §11.3) is present for each market whose vault holds its priceToken; a one-shot `generator: "smoke"` buy exists only under `ate smoke` (§19 step 6) |
| `ate_quote` | no | Simulated quote + impact + `check()` verdict + `minOutFloor` + `exitPath` |
| `ate_propose` | record | Dry-run against the market's vault `check()` and the strategy + portfolio guard; in `autonomous` binds to a `candidateId`, or is `origin: "discretionary"` with a `thesis` (§11.4 rule 8); **reserves** its turnover (and discretionary count) until executed or expired; returns `proposalId` (120 s) |
| `ate_decide` | record | Record a decision not to trade (`no_trade`), with rationale and the candidate it rejects |
| `ate_execute` | **chain** | Re-run the strategy guard (§11.4 rules 2–9) at execute time, re-quote, pre-flight, sign with agent key through `TxQueue`, submit an approved proposal to its market's vault; then EAS-attest it (§13). A proposal invalidated by a guard exit or breaker (§11.4) returns `ATE_STRATEGY_BLOCKED` |
| `ate_positions` | no | Per vault and for the portfolio: balances, exposure, average-cost basis, realised, CEX-marked and exit-executable unrealised P&L, open spread-revert lots with their own realised P&L (reported alongside, never summed, §11.4), epoch budget and exit reserve, turnover left, AI scoreboard (acts / vetoes + bps saved / discretionary), uptime, cycle and HSKSwap trade counts, routed USD |
| `ate_strategy_get` / `ate_strategy_set` | **config** | Read/adjust target assets, size, frequency, risk, stop-loss, target allocation, turnover budget, re-entry cooldown — per market or portfolio-wide, clamped to on-chain limits. `chat`/`ui` scope sets the human anchors; `agent` scope may change only `entrySpreadBps`, `minNetEdgeBps`, `tradeSizeUsd`, `cycleSeconds`, each within ×0.5–×1.5 of the human anchor (journalled `actor=agent`). Human-scope **loosening** changes (direction table, §11.5) return `ATE_APPROVAL_REQUIRED` until signed with `ate-approve`; `riskProfile` (*additive*) sets risk appetite in one field; every applied human change triggers an out-of-schedule cycle |
| `ate_journal_read` | no | Recent decisions with reasons ("why did you sell at 3am?"); agent-authored text (rationale, thesis) is returned wrapped in `<untrusted_agent_text>` (§11.5) |
| `ate_signal_buy` | **payment** | Only if G-HSP: buy a premium signal from the signal agent via HSP (§9); requires two human approvals; asynchronous, never blocks a trade |
| `ate_pause` | **chain** | Kill switch — signs `pause()` on **both** vaults with the agent key (the vault lets the agent pause); no owner key involved; also locks the daemon (§8.3). The guardian's independent pause runs off the agent's machine (§4.1) |

v1.0 adds `ate_kb_search`, `ate_backtest`, `ate_watch`.

### 7.3 Proposal lifecycle and approval modes

```
proposed ──(policy OK, mode=autonomous)──► approved(by=policy) ──► executed | failed
    │      (mode=confirm) ─► awaiting_human ─► approved(by=human) ─┘
    └──► rejected(reason) | expired(120 s) | invalidated(guard exit / breaker; buys only)
```

Turnover and discretionary counts are **reserved at propose** and released on `expired`, `rejected`,
`invalidated` or `failed`, so concurrent proposals cannot jointly exceed them; `ate_execute` re-runs
rules 2–9 against the current state before signing (a buy proposed before a stop-loss cannot execute
after it).

- `autonomous` (default for the trader): a proposal that passes `check()` and the strategy guard is
  approved by policy, with no human step. This is the Track 1 "no manual intervention" mode, and it is
  safe because of §4.6.
- `confirm`: each proposal waits for approval in the UI/CLI.
- In `autonomous` mode every proposal either binds to a candidate (§11.4 rule 1: the LLM chooses among,
  and may shrink, what the daemon computed, including the standing `discretionary_exit`) or is a
  **discretionary** proposal (§11.4 rule 8: ≤ `discretionaryTradesPerDay` (3) per UTC day, ≤
  `discretionaryUsd` ($10) each, required `thesis`, `origin=discretionary`). Unbounded free-form
  proposals are accepted only in `confirm` mode.
- Payments (§9, only if G-HSP) always require two human approvals regardless of mode, per the HSP guide.
  They run in `ate-pay` outside the trade path: a proposal never waits on a payment.

### 7.4 Schemas

`amountIn` is always in the **smallest units of `tokenIn`** (USDT 6 dp when `side=buy`; the market's
priceToken when `side=sell` — WHSK 18 dp, WBTC 8 dp). Every quote/proposal response echoes `market`,
`vault`, `tokenIn`, `decimals` and a human-readable amount. `market` is one of the two v0.1 market ids
(enum below; §6.2).

```jsonc
// ate_quote
{
  "name": "ate_quote",
  "description": "Quote a swap. Returns simulated output, price impact, the vault's minimum acceptable output, and the policy verdict. Call before ate_propose. amountIn is in smallest units of tokenIn (buy: USDT 6dp; sell: WHSK 18dp or WBTC 8dp).",
  "inputSchema": {
    "type": "object",
    "required": ["market", "side", "amountIn"],
    "properties": {
      "market":   { "type": "string", "enum": ["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"] },
      "side":     { "type": "string", "enum": ["buy", "sell"] },
      "amountIn": { "type": "string", "pattern": "^[0-9]+$" }
    },
    "additionalProperties": false
  }
}
```

```jsonc
// ate_propose
{
  "name": "ate_propose",
  "description": "Validate an intended trade against on-chain policy and strategy limits without sending a transaction. Returns a proposalId valid for 120 seconds. The rationale is stored verbatim and its hash is emitted on-chain when executed.",
  "inputSchema": {
    "type": "object",
    "required": ["market", "side", "amountIn", "rationale"],
    "properties": {
      "market":    { "type": "string", "enum": ["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"] },
      "side":      { "type": "string", "enum": ["buy", "sell"] },
      "amountIn":  { "type": "string", "pattern": "^[0-9]+$" },
      "candidateId": { "type": "string", "pattern": "^cand_[0-9a-f]{16}$", "description": "Autonomous mode: the ate_candidates_get entry this proposal acts on (side must match; amountIn ≤ maxAmountIn; unexpired). Omit only with origin=discretionary" },
      "origin":    { "type": "string", "enum": ["candidate", "discretionary"], "default": "candidate" },
      "thesis":    { "type": "string", "minLength": 40, "maxLength": 1000, "description": "Required iff origin=discretionary: why this trade, what would prove it wrong, exit plan" },
      "signalId":  { "type": "string", "description": "Paid signal that informed this trade, if any (G-HSP)" },
      "rationale": { "type": "string", "minLength": 16, "maxLength": 1000 }
    },
    "additionalProperties": false
  }
}
```

```jsonc
// ate_execute
{
  "name": "ate_execute",
  "description": "Execute a previously proposed and approved trade. The proposal's rationale is the trade's rationale. Re-runs the strategy guard (rules 2-9), QuoterV2 and check(), rebuilds minAmountOut = max(floor, quote × 0.995) and deadline = now + 60 s, and rejects with ATE_SLIPPAGE if the fresh quote is > 50 bps worse than at propose, or ATE_STRATEGY_BLOCKED if the guard now refuses (e.g. a guard exit invalidated this buy). On-chain proposalId = the proposal's journal record hash.",
  "inputSchema": {
    "type": "object",
    "required": ["proposalId"],
    "properties": { "proposalId": { "type": "string", "pattern": "^prop_[0-9a-f]{16}$" } },
    "additionalProperties": false
  }
}
```

```jsonc
// ate_strategy_set
{
  "name": "ate_strategy_set",
  "description": "Adjust trading strategy. targetAssets selects which markets hold inventory (others sell down to cash; [] = all cash). Per-market fields apply to patch.market, or to every enabled market if market is omitted. Values outside on-chain policy are clamped and the response says so. Cannot change on-chain policy. Called with a chat/ui scope it sets the human anchors: tightening changes apply at once; loosening changes — anything that makes the agent larger or more active: raise stopLossBps, dailyLossLimitUsd, maxPositionUsd, maxDailyTurnoverUsd, maxPortfolioExposureUsd, tradeSizeUsd, the discretionary limits, or rebalanceTargetPct (to any value above the current one and above 0); lower entrySpreadBps, minNetEdgeBps, cycleSeconds, reentryCooldownSec or rebalanceBandPct; change takeProfitBps; enable a market or add a target asset; a riskProfile resolves to its field values and is judged field by field — return ATE_APPROVAL_REQUIRED with a rendered before/after diff and apply only after an ate-approve signature over it. A patch with any loosening field is loosening as a whole. Called with the agent scope only entrySpreadBps, minNetEdgeBps, tradeSizeUsd and cycleSeconds may change, each clamped to ×0.5–×1.5 of the human anchor, and the record is actor=agent.",
  "inputSchema": {
    "type": "object",
    "required": ["patch", "rationale"],
    "properties": {
      "patch": {
        "type": "object",
        "properties": {
          "targetAssets":      { "type": "array", "items": { "type": "string", "enum": ["WHSK", "WBTC"] }, "uniqueItems": true, "description": "Portfolio-wide, human scopes only. Selected markets are enabled and share the turnover budget; de-selected markets get rebalanceTargetPct 0 (sell down within caps). [] = go to cash" },
          "enabled":           { "type": "boolean" },
          "market":            { "type": "string", "enum": ["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"] },
          "minNetEdgeBps":     { "type": "integer", "minimum": 0, "maximum": 2000 },
          "rebalanceTargetPct":{ "type": "integer", "minimum": 0, "maximum": 100, "description": "0 = go to cash (sell down within caps)" },
          "rebalanceBandPct":  { "type": "integer", "minimum": 1, "maximum": 50 },
          "maxPositionUsd":    { "type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,2})?$" },
          "tradeSizeUsd":      { "type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,2})?$" },
          "cycleSeconds":      { "type": "integer", "minimum": 30, "maximum": 86400 },
          "entrySpreadBps":    { "type": "integer", "minimum": 10, "maximum": 2000 },
          "stopLossBps":       { "type": "integer", "minimum": 50, "maximum": 5000 },
          "takeProfitBps":     { "type": "integer", "minimum": 10, "maximum": 5000 },
          "dailyLossLimitUsd": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,2})?$" },
          "maxDailyTurnoverUsd": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,2})?$", "description": "Portfolio off-chain entry budget per UTC day, split among enabled target assets; each market's share is clamped to ≤ its vault's maxEpochUsd − maxExposureUsd; guard exits are exempt" },
          "maxPortfolioExposureUsd": { "type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,2})?$", "description": "Portfolio off-chain exposure cap; clamped to ≤ the sum of the vaults' maxExposureUsd" },
          "reentryCooldownSec":  { "type": "integer", "minimum": 0, "maximum": 86400 },
          "discretionaryTradesPerDay": { "type": "integer", "minimum": 0, "maximum": 3, "description": "Human scopes only; 0 disables the discretionary lane" },
          "discretionaryUsd":    { "type": "string", "pattern": "^[0-9]+(\\.[0-9]{1,2})?$", "description": "Human scopes only; clamped to ≤ 10" },
          "riskProfile":         { "type": "string", "enum": ["conservative", "balanced", "aggressive"], "description": "ADDITIVE (v0.9, optional). Human scopes only. Preset that expands to tradeSizeUsd, entrySpreadBps, minNetEdgeBps, stopLossBps and maxPositionUsd per §11.5; explicit fields in the same patch win; clamped to on-chain limits; loosening judged field by field" }
        },
        "additionalProperties": false
      },
      "rationale": { "type": "string", "minLength": 16, "maxLength": 1000 }
    },
    "additionalProperties": false
  }
}
```

```jsonc
// ate_candidates_get
{
  "name": "ate_candidates_get",
  "description": "List the trade candidates the daemon computed this cycle for one market or both (spread-revert open/close, rebalance, guard_exit, discretionary_exit), with edge, cost and the maximum size the strategy and portfolio guard allow. In autonomous mode every ate_propose references one of these by candidateId unless it is a bounded discretionary proposal. Candidates expire after candidateTtlSec (at least 120 seconds). Also lists entries the daemon suppressed (deviation, oracle_disagree).",
  "inputSchema": {
    "type": "object",
    "properties": { "market": { "type": "string", "enum": ["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"] } },
    "additionalProperties": false
  }
}
```

`ate_decide` takes `{ decision: "no_trade", market, candidateId?, reason: "no_signal" | "llm_veto" |
"awaiting_signal" | "guard" | "timeout", rationale }` (`timeout` is written by the runner when it kills a
run, §11.1; daemon suppression records use `guard`). `ate_pause` takes `{ rationale }`. `ate_signal_buy` takes
`{ offerId, rationale }`. The JSON Schemas for all tools are frozen at 10:30 IST in
`packages/mcp/schemas/` (§21.4).

### 7.5 Response envelope

```ts
type ToolResult<T> =
  | { ok: true;  data: T; meta: { latencyMs: number; blockNumber: string } }
  | { ok: false; error: { code: AteErrorCode; message: string; hint?: string; retryable: boolean } };
```

**Rationale is required on every tool that records a decision or initiates a mutation** (`ate_propose`,
`ate_decide`, `ate_strategy_set`, `ate_signal_buy`, `ate_pause`); `ate_execute` inherits the proposal's rationale. With an external agent ATE
sees tool calls but not reasoning, so the rationale is the only way the decision log is complete. The
daemon (not the agent) computes `rationaleHash = keccak256(utf8(NFC(rationale)))` and emits it on-chain.
This proves the logged text existed at execution time; it does not prove the text is true.

### 7.6 Error codes

| Code | Retryable | Meaning |
|---|---|---|
| `ATE_POLICY_PAUSED` | no | Vault paused |
| `ATE_POLICY_NOT_AGENT` | no | Signer is not the vault's agent |
| `ATE_POLICY_PAIR` | no | Token pair not the vault's pinned pair |
| `ATE_POLICY_TRADE_CAP` | no | Notional above per-trade cap |
| `ATE_POLICY_EPOCH_CAP` | yes (next epoch) | Epoch budget exhausted |
| `ATE_POLICY_COOLDOWN` | yes | Too soon after last trade |
| `ATE_ORACLE_STALE` | yes | Oracle age beyond policy |
| `ATE_ORACLE_INVALID` | yes | Non-positive answer / bad round |
| `ATE_ORACLE_DEVIATION` | yes | Pool too far from oracle (`ERR_ORACLE_DEVIATION`); buys blocked; sells use the exit path |
| `ATE_EXIT_PRICE` | yes | Exit-path sell refused: TWAP more than `maxExitDiscountBps` below oracle (`ERR_EXIT_PRICE`) |
| `ATE_SLIPPAGE` | yes (re-quote) | `minAmountOut` below the vault's floor |
| `ATE_DEADLINE` | yes (re-propose) | Transaction deadline passed |
| `ATE_POLICY_ZERO_AMOUNT` | no | `amountIn` is 0 (`ERR_ZERO_AMOUNT`) |
| `ATE_INSUFFICIENT_BALANCE` | no | Vault lacks `tokenIn` (`ERR_BALANCE`) |
| `ATE_POLICY_EXPOSURE` | no (sell first) | Buy would push the vault's priceToken holdings above `maxExposureUsd` (`ERR_EXPOSURE`) |
| `ATE_STRATEGY_BLOCKED` | yes | Strategy or portfolio guard refused at propose or execute (position limit, portfolio exposure, daily loss limit, turnover budget, exit reserve (rule 3b), re-entry lock, market not a target asset / disabled, proposal invalidated by a guard exit or breaker) |
| `ATE_MARKET_UNKNOWN` | no | `market` is not one of the two v0.1 market ids (§6.2) |
| `ATE_CANDIDATE_REQUIRED` | no | `autonomous` mode proposal with neither a `candidateId` nor `origin=discretionary` + `thesis` |
| `ATE_DISCRETIONARY_LIMIT` | yes (next UTC day / smaller size) | Discretionary proposal over `discretionaryUsd` or beyond `discretionaryTradesPerDay` |
| `ATE_TOOL_NOT_ALLOWED` | no | Tool outside the caller's token scope (e.g. `chat` calling `ate_execute`) |
| `ATE_APPROVAL_REQUIRED` | yes (after signing) | Human-scope strategy change loosens risk; pending (TTL 60 s) until an `ate-approve` signature over the rendered diff arrives (§11.5) |
| `ATE_GAS_LOW` | yes (after top-up) | Agent float below 1 HSK: attestations deferred; below the cost of one tx, nothing can be sent |
| `ATE_CANDIDATE_MISMATCH` | no | Unknown or expired `candidateId`, side differs, or `amountIn > maxAmountIn` |
| `ATE_PROPOSAL_UNKNOWN` | no | Id not found or already used |
| `ATE_PROPOSAL_EXPIRED` | yes | Older than 120 s |
| `ATE_PAYMENT_*` | varies | See §9.6 |
| `ATE_VENUE_ERROR` | maybe | Router revert / RPC failure |
| `ATE_RPC_RATE_LIMITED` | yes | 429 from all configured RPCs |
| `ATE_DAEMON_LOCKED` | yes | Keystore needs unlock |

`hint` must be actionable, e.g. `"Reduce amountIn to ≤ 100 USDT (100000000) or wait until the epoch resets at 00:00 UTC"`.

---

## 8. Wallet and key management

### 8.1 Keys

| Key | Storage | Capability | Hot? |
|---|---|---|---|
| Owner | Ledger on the second device; fallback `cast wallet` encrypted keystore created and used only there (§19 step 0); Safe at v1.0. **Never on the agent's machine.** | `setLimits`, `withdraw`, `setAgent`, `setGuardian`, `pause`, `unpause`, `transferOwnership` | Only during `ate-owner …` on that device |
| Agent (one per daemon; `agent` on both vaults; one per vault at v1.0) | OS keychain on the agent's machine, AES-256-GCM + scrypt | `execute`, `pause` on both vaults (daemon kill switch, breaker) | While daemon unlocked |
| Guardian (`guardian` on both vaults) | Third device (ops' phone wallet, `pause()` via Blockscout) when available; else a `cast wallet` keystore on the second device used by `ate-owner pause --guardian --all` — then independent of the daemon, not of that laptop | `pause` | Only when pausing |
| EAS attester | The agent key (attestations are plain EOA txs to EAS; no vault capability) | `EAS.attest` | While daemon unlocked |
| HSP payer | OKX Agentic Wallet (TEE) on the worker; fallback §8.4 | EIP-712 payment authorizations | Per approved payment |
| Approval (P-256) | Secure Enclave on the agent's Mac; its key blob in a login-keychain item whose ACL trusts only the signed `ate-approve` (§10.1) | Signs human approvals (payments, `confirm` trades, RPC/config changes, `ate chat` sessions, UI attaches, loosening strategy changes) after Touch ID | Per approval |

Encryption: `scrypt(N=2^17, r=8, p=1)` → 32-byte key → AES-256-GCM, versioned header with KDF params.
Keychain names: `ate/<chainId>/agent/<uuid>`.

**Owner operations** use `ate-owner` on the second device with typed arguments and the Ledger (or
fallback keystore) (§4.5). The daemon never builds owner calldata.

**Consequence (the G2 claim, stated precisely):** a fully compromised daemon — or an agent that reads its
token and keychain — can trade within each vault's on-chain limits (§4.6: the portfolio bound is their
sum), pause the vaults, burn the agent gas
float, write misleading EAS attestations from the agent address (they cannot change what `TradeExecuted`
shows), and edit off-chain strategy within the `agent`-scope clamps (journalled `actor=agent`, never
`human`). It cannot change limits, withdraw, unpause, repoint the vault, or stop the guardian from
pausing. The portfolio guard is off-chain, so a compromised daemon can ignore it; against a stolen key
the bound is the sum of the two vaults' on-chain limits, which is how §4.6 states it. It cannot approve
payments without a Touch ID approval of a payload-rendered request (§10.1) —
**except** while an operator AWS session is live on the same Mac, when it can reach the worker and spend
the payer float (≤ $1.00/day; §3.4 residual risk).

### 8.2 Rules

- Private material is never serialized to the renderer, logs, crash reports, or the journal.
- No endpoint returns a private key or mnemonic. Export is absent in v0.1.
- Memory zeroing after signing is best-effort, documented as such.

### 8.3 Unlock policy

The daemon starts locked. `ate unlock` or the UI prompts for the passphrase. Auto-lock after 15 minutes
idle, configurable 1–240 minutes; **disabled while the trader is running in `autonomous` mode** (a locked
daemon cannot trade). Pausing via `ate_pause` (both vaults) also locks the daemon and invalidates open
proposals, so recovery after the owner unpauses needs `ate unlock` on the agent's machine (§19 step 8).
A guardian or owner pause from another device does not lock the daemon; it sees `Paused` and stops
proposing until `Unpaused`.

### 8.4 OKX Agentic Wallet signer (payments)

Use the official `onchainos` CLI as the HSP signer adapter on the worker. Verify vendor release checksums
before installation; inspect installed CLI help and chain support. `wallet status` proves session state
only. EIP-712 support on the exact network returned by `get_chain_config` must be verified before the demo;
generic EVM support is insufficient.

Verification on 2026-11-02: checksum-verified `onchainos 4.6.7` lists HashKey mainnet (177) and does
**not** list HashKey testnet (133); the local wallet is logged out. Support for the HSP-returned QA network
is unknown until `get_chain_config` runs.

- The team completes login and any OTP interactively on the worker. Do not copy the Mac's session to EC2.
  Store session material only in the service user's protected credential store — never in AMIs,
  user-data, CloudFormation outputs, git, logs or screenshots. No private-key export, no unattended
  spending grant.
- **Fallback signer** (used only if OKX cannot sign for the returned network): a dedicated payer EOA on
  the worker, viem `signTypedData`, key file owned by the `ate-pay` service user (mode 0400), funded with
  ≤ the daily payment cap. Same approval
  gates. The guide names OKX as an example wallet, not a requirement; the submission states which signer
  was used.
- Before each signature, show network/chain ID, token contract/decimals, payer, recipient, amount including
  fees, EIP-712 domain/verifying contract, nonce, validity window and the typed-data digest. Approvals are
  bound to `keccak256(typedData)` and `payment_request_id`; a changed digest invalidates the approval.
- Funding and Permit2/token approvals are separate user-approved transactions. The payer EOA is **not**
  constrained by PolicyVault; payment limits are enforced in `ate-pay` (§9.5), and ATE never claims
  on-chain vault protection for payments.

---

## 9. Agent-to-agent payments (HSP) — optional, G-HSP-gated, outside the trade path

**Must-build** (§21.1 item 11): built in full by Lane E either way, tested on recorded HSP responses.
**Live use is optional**: it goes live only if gate G-HSP (§21.4) is go. Nothing in §4, §7.3 or §11
depends on it. **No-go deliverable (pre-registered):** whatever G-HSP says, by 12:00 Lane E commits
`docs/hsp-readiness.md` — each of the eight HSP tools mapped to the §9.4 state-machine transition that
calls it and the recorded-response test that covers it — plus the recorded QA tool listing or, if access
never arrived, the organiser's written reply. The premium signal is for the WHSK market only.

### 9.1 Scenario

Two agents with separate wallets and separate jobs:

- **Signal agent (`ate-signal`, receiving agent).** Runs on the worker. Sells a premium signal the free
  path cannot produce: a 15-minute WHSK fair-value estimate built from the HashKey Global **order book
  depth** (not just the ticker), recent pool swap flow and the pool's depth profile. It is the HSP order's
  merchant side (`merchant_name = Vikings`, its own `pay_to` address) and creates the order itself.
- **Trader agent (`ate-trader` via `ate-pay`, Payment Agent).** Buys a premium signal only when the
  information is worth more than it costs (§9.5).

Honesty: both agents are operated by Vikings, and HSP runs on its QA network. The A2A structure — separate
keys, signed conditions, verified order, mandate, gateway settlement, attribution — is the real one; the
counterparty is not independent in v0.1.

The decision record links `payment_request_id → signalId → decision → proposalId → txHash`.

### 9.2 Payment conditions (receiving agent → payment agent)

`GET /offers` on `ate-signal` creates an HSP order (`create_order`: USD, one line item, x402 v2, its own
`pay_to`, `merchant_name=Vikings`) and returns:

```ts
interface PaymentConditions {
  offerId: string;                 // "sig_<16 hex>"
  orderId: string;                 // HSP order created by the signal agent
  product: "whsk-fair-value-15m";
  priceUsd: string;                // default "0.02"
  payTo: `0x${string}`;            // signal agent's receiving address
  merchantName: "Vikings";
  network: { chainId: number; token: `0x${string}`; decimals: number }; // from get_chain_config
  expiresAt: number;               // unix seconds, ≤ 300 s ahead
  signalTtlSec: 900;               // how long the delivered signal stays valid
  signature: `0x${string}`;        // EIP-191 by the signal agent's key over the canonical JSON
}
```

### 9.3 Payment Mandate (payment agent)

`ate-pay` builds the mandate from the conditions, never from free text:

1. Verify the conditions signature against the configured signal-agent key, expiry, and that `network`
   matches live `get_chain_config` (network, chain ID, token contract, decimals, payment protocol).
2. `get_order(orderId)`: amount, currency, `pay_to` and `merchant_name` must equal the conditions.
3. Check payment policy (§9.5) and **reserve** the amount against the daily cap.
4. `prepare_payment` → EIP-712 typed data + quote (`token_total_raw`, fee, validity). Require payer
   balance ≥ `token_total_raw`.

The **Payment Mandate** is the record `{ conditionsHash, orderId, flow_id, payment_request_id,
typedDataDigest, amountRaw, validUntil }`, persisted before any signature.

### 9.4 Settlement state machine

| State | Event | Next |
|---|---|---|
| `CREATED` | conditions + order verified, cap reserved | `PREPARED` (after `prepare_payment`) |
| `PREPARED` | human approval #1 (signed, digest-bound) | `SIGN_APPROVED` |
| `PREPARED` / `SIGN_APPROVED` | approval denied or timed out (120 s) | `FAILED(denied)` |
| `SIGN_APPROVED` | OKX (or fallback) signs typed data | `SIGNED` |
| `SIGNED` | `finalize_payment` ok (JWT generated server-side) | `AUTH_FINALIZED` |
| `AUTH_FINALIZED` | `estimate_fee`, human approval #2 | `SUBMIT_APPROVED` |
| `AUTH_FINALIZED` | approval #2 denied or timed out (120 s) | `FAILED(denied)` — never submitted; lapses at `validUntil` |
| `SUBMIT_APPROVED` | `submit_payment` ok | `SUBMITTED` |
| `SUBMIT_APPROVED` | `submit_payment` timeout / 5xx | `UNCERTAIN` |
| `SUBMITTED` / `UNCERTAIN` | `query_payment` = `payment-safe` | `SAFE` |
| `SUBMITTED` / `SAFE` / `UNCERTAIN` | `query_payment` = `payment-finalized` **and** `attribution_verified=true` | `SETTLED` |
| `SUBMITTED` / `SAFE` / `UNCERTAIN` | `payment-finalized` **and** `attribution_verified=false` | `SETTLED_UNATTRIBUTED` (terminal; cap consumed; not E8 evidence) |
| any pre-`SUBMITTED` state | error **30043** / quote expiry | `EXPIRED` |
| any | definitive failure from `query_payment` | `FAILED` |
| `SUBMITTED` / `SAFE` | no definitive result after 10 min | `UNCERTAIN` (background reconcile every 60 s) |

Polling: `query_payment` every 3 s for 120 s, then every 30 s up to 10 min. The cap reservation is
released on `FAILED`, on `EXPIRED`, and on `FAILED(denied)` only once no signed authorization for the
mandate is still valid; `UNCERTAIN` keeps
it. `payment-submitted` and `payment-safe` are intermediate; only `SETTLED` is success. Record the gateway
tx reference and `gas_fee_advanced` treatment.

Delivery: `POST /redeem { payment_request_id, offerId }` with the worker token. `ate-signal` checks
`query_payment` itself, requires `payment-finalized` (paid; attribution is evidence, not a delivery
condition), matches `offerId` and `conditionsHash`, and
releases the signal **once** per `payment_request_id`.

### 9.5 Payment policy and economics (enforced in `ate-pay`)

- Buy only when `tradeSizeUsd × |netEdgeBps| / 10000 ≥ 5 × priceUsd` and the free signal is borderline
  (net edge within ±1.5× `entrySpreadBps`). At $0.02 per signal and a $25 trade, that means ≥ 40 bps of
  disputed edge. At the demo profile's $5 size the test cannot pass; see §11.3.
- Per-payment cap $0.10; daily cap $1.00; `payTo` must be the configured signal agent.
- One in-flight mandate per offer. No purchases while Vault-HSK is paused.
- **Asynchronous:** a purchase never blocks the trading loop. Only for the one borderline candidate
  that triggered the purchase may the LLM record `no_trade(awaiting_signal)`; a later cycle consumes the
  signal if it is still within `signalTtlSec`. Other candidates, guard exits and the breaker proceed
  normally, and an unapproved purchase simply expires.
- **Outside the trade path.** Payments run in `ate-pay` on the worker and are the only human-gated step
  in `autonomous` mode, because the HSP guide requires explicit approval before signing and before
  submission. No proposal, execution, exit or stop-loss ever waits on a payment; an unapproved purchase
  simply expires. Trading runs unattended (T1.7).

### 9.6 Failure and idempotency rules

- Never re-prepare while a prior signed authorization is unexpired and non-terminal; `query_payment` first.
- An uncertain `submit_payment` is resolved by `query_payment`, never by resubmitting.
- A denied or timed-out approval moves the mandate to `FAILED(denied)`; nothing further is signed or
  submitted. A denial at approval #2 leaves a finalized, unsubmitted authorization; the cap stays reserved
  until it lapses.
- Session tokens, JWTs and signatures are never logged; the journal stores digests only.
- Errors map to `ATE_PAYMENT_DENIED`, `ATE_PAYMENT_EXPIRED`, `ATE_PAYMENT_LIMIT`, `ATE_PAYMENT_UNCERTAIN`,
  `ATE_PAYMENT_NETWORK_UNSUPPORTED`, `ATE_PAYMENT_UNAVAILABLE` (allowlist/health failure),
  `ATE_PAYMENT_ORDER_MISMATCH` (`get_order` disagrees with conditions), `ATE_PAYMENT_CONDITIONS_INVALID`
  (signature, expiry or network check in §9.3 step 1 fails).

### 9.7 HSP connection prerequisites

Source: official hackathon guide (revision 2026-10-30), summarised in
`.context/track-b-access-requirements.md`.

- Register `hsp-agentic-payment` once using Streamable HTTP at `https://mcp-qa.hashkeymerchant.com/`.
  HSP centrally manages App Key/App Secret; no participant merchant keypair or JWT setup.
- Worker egress IP `13.205.56.13` submitted via the official QA access form (team `Vikings`,
  `akash.jsmith@gmail.com`, `Cloud server`); receipt unverified. Wait for Operations confirmation; do not
  repeatedly retry blocked endpoints. EIP allocation, form receipt, health, tool listing and settlement
  are distinct verification steps.
- Verify all eight tools: `get_chain_config`, `create_order`, `get_order`, `prepare_payment`,
  `finalize_payment`, `estimate_fee`, `submit_payment`, `query_payment`. Stop on a missing tool.
- Neither "QA" nor the "USDC" symbol determines network or token; use `get_chain_config`. Do not bridge a
  same-symbol asset and assume HSP accepts it. Keep this network separate from trading chain 177.

---

## 10. Local API and IPC

### 10.1 Transport

- Daemon binds `127.0.0.1` on an ephemeral port and writes `~/.ate/runtime.json` (mode `0600`) with
  `{ pid, port, agentToken, startedAt, version }`. The `ui` token is **not** written to disk and lives
  only in memory. Electron main gets it one of two ways: (a) it spawns the daemon and receives it over
  the spawn pipe; or (b) **it attaches to an already-running daemon** (the mainnet daemon runs headless
  all day, §21.4) via `POST /ui/attach`: step 1 `{}` → `{ nonce }` (the only unauthenticated route;
  nonce TTL 60 s, 5 req/min); step 2 `{ nonce, approval }` where `approval` is an `ate-approve` signature
  (Touch ID) over the daemon-issued nonce → a fresh `ui` token. Same pattern as `session`. Restarting
  the Electron app re-attaches; it never restarts the trader. Tokens are 32 random bytes, rotated per
  start.
- **Every request requires a bearer token**, except step 1 of `/ui/attach`, which only issues a nonce.
  `Origin`, if present, must be `ate://local`; requests with a
  browser origin are rejected. Origin is never a substitute for the token.
- Token scopes (`rogue` is *additive*, below): `agent` (MCP trading tools; trader runner, `ate mcp serve`, external agents), `chat`
  (minted by the daemon per Chat session, TTL = session, 30 min idle; passed only in the chat runner's
  environment and MCP config, never written to disk; the MCP server enforces the §11.5 allowlist for it),
  `ui` (main process only, via spawn pipe or `/ui/attach`; may open Chat sessions and send `/chat`
  turns), `session` (a handle for one `ate chat` session, issued by `POST /chat/session` only against an
  `ate-approve` signature over a daemon-issued session nonce; it authorizes `/chat` turns for that session and nothing else) and `view` (read-only
  fallback page, one-time token printed by `ate ui`). **`rogue` (*additive*, v0.9)** exists only when the
  daemon was started with `--allow-rogue`: one token minted at daemon start and printed once to the
  daemon's controlling TTY (never to `runtime.json`, a file, a log or `/events`); it reaches only the
  `TxQueue` raw-broadcast route (§22.3), which accepts only calldata whose `to` is one of the two vaults
  and whose selector is `execute`, `withdraw`, `setLimits` or `pause`, and journals every call
  `profile=rogue`. Any other scope on that route → 403. The journal `actor` is derived from the scope that
  made the call. No scope can perform owner operations, because the daemon has no owner key.
- 32 KB body limit; 60 req/min per tool.
- WebSocket `/events` streams `trade.executed`, `trade.rejected`, `policy.violation`, `oracle.health`,
  `strategy.changed`, `payment.state`, `daemon.locked`, `gas.low`, `chat.delta`, `chat.tool`.
- `POST /chat { sessionId, text }` (`ui` or that session's `session` handle; the `agent` scope is
  rejected) runs one Chat turn (§11.5) with the runner holding the session's `chat` token, and streams the
  reply and tool cards over `/events`.
- `POST /cycle {}` (`ui` or `session`; the daemon also self-triggers it on every applied human
  `strategy_change`) starts an out-of-schedule trader cycle, rate-limited to one per 30 s and subject to the
  no-overlap rule (§11.1). `POST /strategy/approve { changeId, approval }` (`ui` or `session`) applies a
  pending loosening change against an `ate-approve` signature over its rendered diff (§11.5).
- `GET /status` (any scope) returns the uptime counter, cycle and trade counts, and HSKSwap trade count and
  routed USD (§15.1).

`runtime.json` is readable by any process of the same OS user, including a shell-capable agent. That is
accepted: the most it yields is `agent` scope, which is bounded on-chain (§3.1, §8.1) and journals as
`actor=agent`. A same-user process that inspects the live chat runner could reuse its `chat` token until
the session ends; that yields only the §11.5 allowlist (strategy inside clamps, pause), all inside §4.6.

**Human approvals are signed, not just token-gated.** The agent's Mac holds a non-exportable P-256 approval
key in the Secure Enclave, usable only after Touch ID / OS authentication. Payment approvals (§8.4),
`confirm`-mode trade approvals, `ate chat` session opens, UI attaches, loosening strategy changes (§11.5) and RPC/config changes are signatures by that key
over the exact digest; the daemon and `ate-pay` verify them against the public key pinned at setup. A
process that steals tokens cannot forge an approval. **v0.1 scope:** the approval key is created and used
by `ate-approve`, a small Swift helper (CryptoKit `SecureEnclave.P256` + LocalAuthentication) invoked by
both Electron main and the CLI, so approvals work from both the desktop app and headless runs.
`ate-approve` takes only the raw payload to sign, decodes it itself, and builds the Touch ID
`localizedReason` **solely from that decoded payload** (payment: amount, token, payTo, chainId; trade:
side, size, market; chat: session id; UI attach: daemon pid and port; strategy: each field before → after
and its market) — a caller cannot supply prompt text.

*Where the protection actually comes from.* Verifiers see only a P-256 signature, so they cannot tell
which binary produced it; pinning a code hash would be unenforceable. The protection is where the key
lives: the Secure Enclave key's `dataRepresentation` blob is stored in a login-keychain item whose access
control list trusts only `ate-approve`'s designated code requirement (signed with the team's Developer ID,
or a code-signing certificate created at setup). Any other process that reads the item triggers a macOS
keychain dialog naming that process, which the user is instructed to deny; without the blob, no process
can ask the Secure Enclave to sign. `ate-approve` is installed root-owned in `/usr/local/libexec/ate/`.
Residual risks, stated: a user who clicks "Allow" on that dialog or approves an accurately described but
unwanted request, and malware holding the user's login password. Both are bounded by the $1.00/day
payment cap (§9.5) and, for trades, by the vault (§4.6). Signed `config.json` is v1.0; in v0.1 the daemon
refuses RPC URLs not in the list pinned by `ate init`.

**v0.1 degradation — TTY one-time code (only if `ate-approve` is still red at 14:30, §21.4).** The
mainnet daemon is started once (§19 step 7, ~13:00) with `--approval-fallback=armed` (*additive* value),
which keeps TTY codes **disabled** until the lead types `approval-fallback enable` on the daemon's own
controlling TTY (stdin; there is no HTTP route for it) — **no restart, so no `ate unlock`, no gap in
cycling and no input to the trader** (G6 and the E12 recording stay continuous). Once enabled, the daemon accepts, for `/ui/attach`, `/chat/session` and pending
loosening strategy changes **only**, a one-time 8-digit code printed solely to the daemon's controlling
TTY (never to a file, log, `/events` or the journal), TTL 60 s, single use, 5 attempts per code; each use
is journalled `approval=tty`. Payments, `confirm`-mode trades and RPC/config changes never accept it. It
switches itself off (and `enable` is refused) once `ate-approve` passes its §18.2 test on that machine.
Weaker than Touch ID — a same-user process that can read that terminal can obtain a code — but it yields
only `ui`/`session` scope and human-anchor strategy edits, all inside §4.6; stated in SECURITY.md.

### 10.2 Renderer bridge

The renderer never talks to the daemon directly; main proxies allowlisted calls. `preload.ts` exposes a
frozen API:

```ts
window.ate = {
  markets:  { list(), get(id) },                // the two v0.1 market ids (§6.2)
  quote:    { get(req) },
  trade:    { propose(req), approve(id, digest), execute(id) },   // confirm mode; signed per §10.1
  vaults:   { status(), pause() },              // both vaults; unpause is owner-only: `ate-owner unpause --all` on the owner's machine
  strategy: { get(), set(patch) },              // clamped like ate_strategy_set
  journal:  { list(filter), get(id) },
  chat:     { send(sessionId, text), history(sessionId) },   // §11.5; streamed via events
  payments: { list(), approve(id, digest), deny(id) },
  settings: { get(), set(patch) },              // RPC changes need native confirm in main
  events:   { subscribe(handler) },
};
```

No `ipcRenderer`, no `require`, no arbitrary channel names. Security-sensitive settings (RPC URLs)
require a native confirmation dialog in main.

---

## 11. Reference trader agent and strategy

### 11.1 Runner and the division of labour

`ate agent run --mode autonomous` invokes the user's MCP agent headlessly (e.g. `claude -p` with
`agents/trader/PROMPT.md`, the `ate` MCP server and the `hashkey-public-market` skill, or any MCP client)
every `cycleSeconds`. Each cycle the prompt makes the LLM call `ate_market_get`, `ate_candidates_get` and
`ate_positions` first (both markets in one call each); that is how candidates reach the LLM. The prompt
then requires it, **every cycle**, to (1) evaluate every candidate for act / veto / size-down and (2)
explicitly evaluate the discretionary lane, and to record in the cycle's `ate_decide` or `ate_propose`
rationale why it did *not* veto, size down or originate when it didn't. This makes the DoD's veto and
discretionary evidence a routine output of the loop rather than luck, and it is still autonomous: there
is no per-trade human input. A 14:45 lead check backs it up (§21.4).

**Cycle rules (normative).** Cycles never overlap: the runner skips a tick (journalled in the cycle count,
not as a decision) while the previous LLM run is active, and an out-of-schedule cycle (`POST /cycle`,
§10.1) obeys the same lock. A run still active after **90 s** is killed and the runner writes
`ate_decide { reason: "timeout" }` (`engine=rules`); its open proposals expire normally and their
reservations are released. **Candidate TTL** `candidateTtlSec = max(120 s, 2 × p95 LLM run latency)`,
measured over the 13:00–13:45 `--dry-run` cycles on the real MCP (decide/propose, never execute) and
recorded in `deployments/177.json`; the 90 s kill keeps every run inside it. Proposals keep their 120 s TTL
(propose and execute happen in the same run). Tests: overlapping tick skipped; 90 s kill → `timeout`
record; TTL read from `deployments/177.json` (§18.2).

**Deterministic scan (*additive*, v0.9).** The daemon re-reads market state and recomputes candidates and
`suppressed` entries every `scanSeconds` (default 20 s; one Multicall3 read for both markets, §18.1),
independently of the LLM cadence. When a scan finds an **entry candidate on a market that had none in
the previous scan** (a gap just opened), it triggers an out-of-schedule LLM cycle through the same path
as `POST /cycle` (≤ 1 per 30 s, no-overlap rule). Guard exits already act without the LLM. This is how
"real time" is met without running the LLM every block. Test: a fixture gap opening between ticks →
one out-of-schedule cycle within `scanSeconds` + 30 s.

| The daemon (deterministic) | The LLM (judgement) |
|---|---|
| Reads market state; computes bound candidates from §11.3 with edge, cost and `maxAmountIn`, plus a standing `discretionary_exit` | Chooses act / skip / size down on each candidate, or exits early via `discretionary_exit`, binding its proposal to the `candidateId` |
| Enforces the discretionary lane's count, size and thesis rules (§11.4 rule 8) | **Originates** up to 3 discretionary trades/day (≤ $10 each) on its own thesis — e.g. "CEX book thinning on the ask for 3 cycles while pool flow is net buy; small long, exit if CEX mid < entry" |
| Enforces the strategy guard (§11.4) and on-chain pre-flight | Reads what the daemon does not score — CEX book shape and recent trades (skill), Supra round age, bot flow in recent pool `Swap`s, epoch/turnover remaining, its own recent outcomes — and vetoes or shrinks with a reason (e.g. "CEX bid/ask is 40 bps wide; the spread is likely stale") |
| Fires stop-loss, take-profit and circuit breaker without asking | Decides whether a premium signal is worth buying (§9.5, only if G-HSP) |
| Journals everything; attests executed trades on EAS; scores every veto/size-down after 30 min (bps saved) | Tunes `entrySpreadBps`, `minNetEdgeBps`, `tradeSizeUsd`, `cycleSeconds` within ×0.5–×1.5 of the user's settings (`actor=agent`); explains decisions |

Each cycle must end in exactly one of `ate_execute` (after `ate_propose`) or `ate_decide` (no trade,
with rationale). Every decision records `engine: "llm" | "rules" | "guard"`, `origin` and the
`candidateId` (if any). What the LLM may do in `autonomous` mode is enforced, not assumed: a
candidate-bound proposal must match the candidate's side and stay ≤ `maxAmountIn` (§11.4 rule 1); a
discretionary proposal must carry a thesis and fit the count and size limits (rule 8); both then pass
rules 2–9 and the vault. So the LLM originates and exits on its own, but its originations are small and
counted, and every trade stays inside §4.6. Unbounded free-form proposals are accepted only in `confirm`
mode, where a human approves each one.

**Bps saved by vetoes (E13).** 30 min after every LLM veto or size-down, the daemon writes an `outcome`
record (`refId` = the decision) with the counterfactual of the declined amount: entry at the candidate's
quoted price vs the exit-executable mark at +30 min, fees included, in bps and USD (negative = the veto
cost money). The Agents view and `ate_positions` show the running count and sum; the number is reported
whatever its sign.

A deterministic fallback (`--engine rules`) runs the same candidates without an LLM, for CI and demo
resilience; its decisions are labelled `engine=rules` and are **not** used as Track 1 evidence.

### 11.2 Monitoring and analysis (per cycle)

One Multicall3 read for both markets: each pool's `slot0`, active liquidity and 300 s TWAP, both Supra
rounds (APRO cross-check by direct `eth_call`), both vaults' balances and epochs. Plus QuoterV2 impact and the exit-executable mark per market
(QuoterV2 sell quote for the full position), HashKey Global HSKUSDT and BTCUSDT bid/ask and top-of-book
depth (via the `hashkey-public-market` endpoint map), recent `Swap` events on both pools, open positions
and P&L per vault and for the portfolio.

### 11.3 Candidate signals

Generators run **per market** (`hsk-dex:WHSK/USDT:3000`, `hsk-dex:WBTC/USDT:3000`), plus guard exits and a
standing discretionary exit per held position. Measured on Nov 2 (§0.2): the **WBTC** pool sat 112.6 bps
below the HashKey Global BTCUSDT mid at 03:50 IST against ~35 bps of one-legged cost (30 bps fee + ~5 bps
impact at $25 + < 0.01 bps half-spread) — a live default-profile `spread-revert` buy with ≈ 78 bps net
edge. The **WHSK** pool sat ~30 bps below its CEX mid against ~36 bps of cost (30 bps fee + ~0.1–2 bps
impact + ~5.7 bps half-spread), and a bot (`0x1127…`) already arbitrages it, so WHSK spread signals will
be rare. Per-market generator sets (config, §16): WHSK runs `spread-revert` + `rebalance`; WBTC runs
`spread-revert` only, and gets `rebalance` only when the user sets a WBTC allocation or de-selects it
(go to cash).

**`spread-revert`** — trade the pool toward the CEX price when the gap pays for itself (open leg), and
realise the lots it opened once they pay (close leg):

```
edgeBps   = |poolPrice − cexMid| / cexMid × 10000
costBps   = feeBps + impactBps(size) + cexHalfSpreadBps
open      = edgeBps ≥ entrySpreadBps (default 60)  AND  edgeBps − costBps ≥ minNetEdgeBps (default 15)
maxAmountIn = min(tradeSizeUsd, exposure headroom (vault and portfolio), epochRemaining,
                  turnover remaining (market allocation), size where impactBps ≤ edgeBps/3)
direction = poolPrice < cexMid ? buy priceToken : sell priceToken
close     = sell up to the open spread-revert lots (FIFO) when (exitMark − lotEntry) / lotEntry
            ≥ minNetEdgeBps, both fee-inclusive; exempt from the entry edge gate and the turnover budget
pre-filter = every buy candidate is run through the vault's check() (same Multicall3 read); a buy that
            would return ERR_ORACLE_DEVIATION is not emitted but listed in `suppressed` and journalled
            once per episode as no_trade (engine=guard, cause=deviation, bps shown); entries are also
            withheld while Supra–APRO disagree > 250 bps (cause=oracle_disagree, §5.1)
```

**USD caps on token amounts.** Every token-denominated `maxAmountIn` (sells: `discretionary_exit`, guard
chunks, closes) is `USD cap ÷ max(P, T) × 0.99` converted to priceToken units, because the vault counts
sell notional at `Pcap = max(P, T)` (§4.2 step 7b); a chunk sized at `P` alone could fail `ERR_TRADE_CAP`.

On WHSK the impact term does not bind below ~$1k per trade. On WBTC at 03:50 it allows up to ~$190 per
trade (impact ≈ 37 bps at `edgeBps/3`), so `tradeSizeUsd` ($25) binds; each $25 buy moves the pool ~10
bps toward the CEX, so the WBTC daily allocation (≤ $100, §11.4 rule 3), spread over ~2 h by `minEntryIntervalSec` (rule 7), closes ~40 of the 112 bps. P&L
is reported two ways per lot: **marked at the CEX mid** (the captured gap, ≈ +78 bps per lot at 03:50)
and **exit-executable** (what selling now would realise, ≈ −60 bps on a fresh lot). The close leg turns
the first into realised P&L only if the pool reverts toward the CEX; both numbers are reported, never
blended. **Structural-discount risk (stated):** the WBTC pool holds ~94% of WBTC supply and sits ~100 bps
below the oracle price, so its discount may be a persistent bridge/liquidity discount; then the close leg may never
fire, and after an upward oracle update the baseline uses enough of the 250 bps deviation budget that
Vault-BTC buys are deviation-blocked exactly when the CEX gap is widest (the `check()` pre-filter shows
this as `suppressed`, never as a reverted tx). The README states this next to the CEX-marked P&L.

**`rebalance`** — inventory management: keep the vault's priceToken share of its value inside a target
band (default 40% ± 10%); when it drifts outside, propose a trade back to target, at most `tradeSizeUsd`
per cycle. **Default profile edge gate:** a rebalance candidate is emitted only if its direction-adjusted
net edge vs CEX mid is ≥ 0 (`edgeBps` signed in the trade's favour − `costBps` ≥ 0), so it waits for a
cycle where the spread pays for the trade. Exempt: `rebalanceTargetPct = 0` ("go to cash", or a market
de-selected from `targetAssets`), which sells down regardless of edge because it reduces risk.

**`guard_exit`** — stop-loss, take-profit and breaker exits from §11.4, surfaced as candidates so the
journal and the LLM see them; they execute without waiting for the LLM.

**`discretionary_exit`** — whenever a vault holds its priceToken, one standing sell candidate for that
market with `maxAmountIn` = min(position, `maxTradeUsd`, epoch remaining), regenerated every cycle. It
lets the LLM "exit early" on its own judgement through normal candidate binding; it reduces exposure, so
it is exempt from the edge gate and the turnover budget (it still counts on-chain).

Neither generator is a two-leg arbitrage (ATE does not trade on the CEX). P&L will be small and is
reported honestly, per market, including no-trade cycles.

**Replay (must-ship, E11, run 11:00–13:00 so its headline is in the BUIDL's first edit).** `ate replay --days 7`
rebuilds both pools' state from `Swap` logs (via Blockscout, batched) and HashKey Global 1 m klines
(skill endpoint `/quote/v1/kline`, HSKUSDT and BTCUSDT), runs the generators with the default profile at
every cycle, and prints per market: pool volume, cycles evaluated, candidates fired per generator,
candidates rejected on net edge, the distribution of `edgeBps − costBps`, counterfactual net edge in
bps and USD at `tradeSizeUsd`, and **gap persistence**: the distribution of the signed pool-vs-CEX gap,
the share of cycles with gap > cost, the median time for a gap > cost to fall below cost, and a one-line
verdict `transient` or `persistent (> N days)`. It needs no vault. Output is written to `docs/replay-7d.md` and labelled
*counterfactual, from logs, not realised P&L*. It is T1.8/T1.9 supporting evidence, whatever it shows; a
zero or negative result is stated as "the market gave no edge after fees; the agent correctly did
nothing".

**Demo profile (WHSK market only).** `--profile WHSK=demo` sets, for the WHSK market, `entrySpreadBps 10`,
`minNetEdgeBps 0`, `tradeSizeUsd 5`, `reentryCooldownSec 600`, a tight rebalance band (40% ± 2%) and
**waives the rebalance edge gate**, so WHSK trades occur within the recording window; `cycleSeconds` stays
120 and the portfolio turnover stays $200 (§11.4 rule 3). Honestly: `spread-revert` still needs edge ≥
cost, so at the ~30 bps WHSK gap most demo trades are `rebalance`-generated, and with a ±2% band they
fire until the WHSK share reaches ~38% (about 2–3 $5 buys from the 33% seed) and afterwards only after a price
move of about 3% or more — not every cycle. **The WBTC market always runs the default profile**: its
trades are real spread capture with no waivers. Every decision is labelled with its `profile` **and its
generator** (`rebalance`, `spread-revert` open/close, `discretionary_exit`, `guard_exit`, `smoke` or
`origin=discretionary`) in the journal, on the evidence page and in the narration; WHSK demo trades are
never described as arbitrage. Under `profile=demo` the §9.5 value test is waived (G-HSP only): the trader
buys at most one signal per hour, on the first WHSK candidate with `|netEdgeBps| ≤ 1.5 ×
entrySpreadBps`, labelled `profile=demo`.

### 11.4 Risk control and stop-loss

Hard layer (on-chain, §4, per vault): trade, epoch and exposure caps; slippage floor; deviation guard
with the exit path floored at `min(P, TWAP)`; pause.

Soft layer (strategy + portfolio guard in the daemon, **at propose and again at execute**, §7.3):

1. **Candidate binding:** in `autonomous` mode a proposal without `origin=discretionary` must carry a
   `candidateId`; market and side must match; `amountIn ≤ maxAmountIn`; candidate unexpired
   (`candidateTtlSec`, §11.1) and single-use. Violations → `ATE_CANDIDATE_REQUIRED` / `ATE_CANDIDATE_MISMATCH`. Unbounded free-form
   proposals only in `confirm` mode. `candidateId` (or `origin=discretionary`) is journalled on every
   decision.
2. **Position limits:** per market `exposure ≤ maxPositionUsd` (default $150, ≤ the vault's on-chain
   `maxExposureUsd`); portfolio `Σ exposure ≤ maxPortfolioExposureUsd` (default $200, ≤ the sum of the
   vaults' caps, $300). Buys only.
3. **Daily turnover budget (portfolio, allocated):** entries (non-exit trades, incl. the $5 smoke) in the
   UTC day sum to ≤ `maxDailyTurnoverUsd` (default **$200**, both profiles), split equally among the
   enabled target assets, and each market's share is clamped to ≤ its vault's `maxEpochUsd −
   maxExposureUsd` = **$100** at defaults. Discretionary entries count against their market's share.
   Guard exits (incl. go-to-cash sell-downs, rule 9), rebalance sells with `rebalanceTargetPct = 0`,
   `discretionary_exit` and spread-close sells are exempt off-chain but still count on-chain. Amounts are
   reserved at propose (§7.3).
   **3b. Exit reserve (per vault).** The guard admits a non-guard trade only if, after it,
   `maxEpochUsd − spentUsd ≥ exposureUsd × 10⁴ / (10⁴ − maxOracleDeviationBps)` (a buy adds its own
   notional to exposure first); guard exits are exempt. A vault that starts the UTC day holding inventory,
   or sells and re-buys, therefore cannot spend the budget a stop-out needs. At defaults it binds only when
   exposure > ~$146 with $100 spent. A full exit fits **by this rule**, not by construction: it can still
   spill into the next epoch if the price rose after the last entry, an exit runs on the 7b path with
   `T > P/(1 − dev)`, or the off-chain guard is bypassed (stolen key); the remaining chunks then run after
   00:00 UTC (stated, T1.11). Test: start the day at $150 exposure, close $100, re-buy → the buy is
   blocked once the reserve would be breached (§18.2).
4. **Stop-loss / take-profit**, defined precisely, per market:
   - *Position* = all priceToken held by that vault.
   - *Entry* = weighted-average effective fill price of the position, fees included (USDT paid ÷ tokens
     received per buy; sells reduce quantity at the current average, realising P&L). Seed WHSK deposited
     by the owner enters at the oracle (Supra) price at the deposit block. **Position P&L, the stop-loss and the
     README use average cost only.** Spread-revert lots are a sub-ledger (`lots`, §12) used only for the
     close trigger: every sell, whatever its generator, consumes open spread-revert lots FIFO first, then
     other inventory; a lot's realised P&L is reported alongside position P&L, never summed with it.
   - *Mark* = QuoterV2 sell quote for the full position ÷ position size (exit-executable, so a fresh
     position marks ≈ −60 bps: 30 bps fee in, 30 bps fee out, plus spread and impact). The 300 s TWAP must
     agree with the mark within `maxOracleDeviationBps`, otherwise the trigger waits a cycle (no
     one-block push can fire it).
   - *Trigger:* `(mark − entry) / entry ≤ −stopLossBps` → stop-loss; `≥ +takeProfitBps` → take-profit.
     The daemon proposes and executes a `guard_exit` sell (`engine=guard`) without asking the LLM, in
     chunks of ≤ `maxTradeUsd ÷ max(P, T) × 0.99` tokens (§11.3) `cooldown` apart. CEX mid is a logged cross-check, never a precondition.
   - *Oracle lag:* when step 7a fails, the exit uses the vault's exit path (§4.2 step 7b) with its floor at
     `min(P, 300 s TWAP)`. Exits **also wait** while spot is more than slippage + fee below that floor
     price — a drop faster than the 300 s TWAP, up to ~5 min — and while the mark disagrees with the TWAP
     by more than `maxOracleDeviationBps` (anti-manipulation); and if the TWAP is > `maxExitDiscountBps`
     below the oracle price (`ERR_EXIT_PRICE`), the epoch budget is spent (`ERR_EPOCH_CAP`, until 00:00 UTC), or the oracle
     is stale/invalid (step 6; the daemon first tries a Supra refresh, §5.2). The exposure cap (at the last buy) bounds what rides through any of these.
   - *Pause:* while a vault is paused nothing executes on it, **including guard exits** — a pause freezes
     the remaining exposure until the owner unpauses. The breaker therefore tries to flatten before it
     pauses (rule 6), and the Chat "Stop everything" reply states this and offers "go to cash" first.
5. **Re-entry cooldown:** after any guard exit on a market, that market's generators (and discretionary
   buys on it) may emit only sells until `reentryLockUntil = exitAt + reentryCooldownSec` (default 14400 s;
   **600 s under the WHSK demo profile**, so a scripted stop-out does not silence the afternoon); the lock
   is journalled. This stops `rebalance` from buying straight back into a stopped-out position.
   `reason=target_assets` sell-downs (rule 9) do not arm the lock (de-selection already blocks entries).
6. **Daily loss circuit breaker (portfolio):** realised + unrealised P&L across both vaults for the UTC
   day ≤ `−dailyLossLimitUsd` → **flatten first** (guard-exit both positions within the trade caps) for
   **at most 2 cycles or 5 min, whichever comes first**, then `pause()` both vaults with the agent key
   **regardless** (flatten blocked by `ERR_EPOCH_CAP`, stale/invalid oracle or `ERR_EXIT_PRICE` cannot keep
   the vaults unpaused), journalling any unflattened exposure, then notify the user (Chat view,
   `/events`). Test (§18.2): exits blocked → pause after the bound.
7. **Frequency:** at most one entry per market per `cycleSeconds`, **and** (*additive*, v0.9) at least
   `minEntryIntervalSec` between entries on the same market (default WBTC **1800**, WHSK **0** = the cycle
   rule only), so the WBTC $100 share spreads over ~2 h of spread-revert buys instead of four
   back-to-back cycles; a suppressed entry is listed in `suppressed` with `cause=entry_interval`. Exits are
   never throttled. On-chain cooldown is the hard floor. Test: two WBTC candidates 120 s apart → the second
   suppressed `cause=entry_interval` (§18.2).
8. **Discretionary lane (portfolio):** an `autonomous` proposal with `origin=discretionary` needs a
   `thesis` (≥ 40 chars: why, invalidation, exit plan), notional ≤ `discretionaryUsd` (default and v0.1
   maximum **$10**) and fewer than `discretionaryTradesPerDay` (default and v0.1 maximum **3**, across both
   markets) discretionary executions in the UTC day; otherwise `ATE_DISCRETIONARY_LIMIT`. Rules 2–7, rule 9 and the
   vault apply unchanged. The user may lower both limits (to 0 disables the lane); no scope may raise
   them above the v0.1 maxima. Journalled and attested `origin=discretionary, engine=llm` with the thesis
   as rationale.
9. **Target assets:** a market not in `targetAssets` gets no entry candidates and its `rebalanceTargetPct`
   is 0; `targetAssets: []` is go-to-cash for the portfolio. **A de-selection or go-to-cash change
   triggers an immediate daemon run** (no LLM, no waiting for the cycle) that emits and executes the
   sell-down as `generator=guard_exit, engine=guard, reason=target_assets`, in chunks of ≤ `maxTradeUsd`
   (token-converted, §11.3) `cooldown` apart; it is turnover-exempt, exempt from the exit reserve, and
   invalidates open buys on that market. Test: de-selection → first sell submitted within one block of the
   `strategy_change` record (§18.2).

**Invalidation.** A guard exit or breaker on a market invalidates every open buy proposal on it (the
breaker: on both), and their reservations are released; a later `ate_execute` on one returns
`ATE_STRATEGY_BLOCKED`.

### 11.5 Natural-language control (Chat view and `ate chat`)

The **Chat view** in the desktop app is the primary NL surface; `ate chat` is the same thing in a
terminal; any external MCP agent works the same way. A Chat turn goes renderer → main → daemon
`POST /chat`, which runs the configured agent headlessly (`claude -p` resumed per `sessionId`, with
`agents/chat/PROMPT.md` and the `ate` MCP server configured with that session's `chat` token). The runner
is started with an **allowlist, not a denylist**: `--strict-mcp-config --allowedTools "mcp__ate__*"` and
no built-in tools enabled (no Bash, Read, Write, Edit, Grep, Glob, WebFetch, WebSearch or Task), and it
loads no skill; CEX data reaches the chat agent only through `ate_market_get`, which already carries the
CEX reference. A test asserts the runner's reported tool list equals the allowlist (§18.2). The chat
agent's MCP tool allowlist — **enforced by the MCP server for the `chat` scope**, not by the prompt — is
`ate_market_get`, `ate_candidates_get`, `ate_quote`, `ate_positions`, `ate_strategy_get`,
`ate_strategy_set`, `ate_journal_read`, `ate_pause` — no shell, no file access and no `ate_execute`
(trading stays with the trader). Every tool call renders as a card (tool, arguments, result,
journal link); strategy changes are journalled as `strategy_change` with `actor=human, via=chat` (derived
from the `chat` scope; an `agent`-token call can never produce it) and the user's words as rationale; they
also reset the human anchors the trader's own tuning is clamped to (§7.2). If no LLM is configured or it fails, a deterministic intent matcher handles
the five intents below marked ★ and labels its replies `engine=rules`.

**Loosening needs a signature (confused-deputy defence).** Chat- or `ui`-scope changes that **loosen** —
make the agent larger or more active, per the direction table below — return `ATE_APPROVAL_REQUIRED`
with a rendered before/after diff; main (or `ate chat`) invokes `ate-approve` over that diff and posts it
to `/strategy/approve` (TTL 60 s; TTY code only in the §10.1 degradation). **Tightening** changes apply
immediately. A patch with any loosening field is loosening as a whole; a `riskProfile` is expanded to
its fields first and judged field by field.

| Field | Loosening (needs `ate-approve`) | Tightening (applies at once) |
|---|---|---|
| `stopLossBps`, `dailyLossLimitUsd`, `maxPositionUsd`, `maxDailyTurnoverUsd`, `maxPortfolioExposureUsd`, `tradeSizeUsd`, `discretionaryTradesPerDay`, `discretionaryUsd` | raise | lower |
| `rebalanceTargetPct` | raise to any value > current and > 0 | lower, or 0 (go to cash) |
| `entrySpreadBps`, `minNetEdgeBps`, `cycleSeconds`, `reentryCooldownSec`, `rebalanceBandPct` | lower | raise |
| `takeProfitBps` | any change | — |
| `enabled` / `targetAssets` | enable a market / add a target asset | disable / remove (sells down) |
| `riskProfile` (*additive*) | judged per expanded field | judged per expanded field |
| `ate_pause` | — | always |

Test (§18.2 MCP): one case per field and direction. **`riskProfile` presets (*additive*, v0.9):**
`conservative` = `tradeSizeUsd 10, entrySpreadBps 90, minNetEdgeBps 25, stopLossBps 200, maxPositionUsd
75`; `balanced` = the §16 defaults (`25, 60, 15, 300, 150`); `aggressive` = `50, 45, 10, 400, 150`
(`maxPositionUsd` clamped to the vault's `maxExposureUsd`). Applied to `patch.market` or every enabled
market; on a demo-profile market only `stopLossBps` and `maxPositionUsd` apply. Every
tool result that carries agent-authored text (journal rationales, theses, candidate reasons) reaches the
chat agent wrapped in `<untrusted_agent_text>…</untrusted_agent_text>`, and the chat prompt treats it as
data. **Scope:** stop-loss / take-profit changes without a market ("stop out at 2%") are not applied until the
chat agent (or rules matcher) asks "HSK, BTC or both?" and the user answers (test, §18.2). **Effect
timing:** every applied human change triggers an immediate out-of-schedule trader cycle (§10.1
`POST /cycle`, ≥ 30 s apart); go-to-cash and de-selection sell at once as guard exits (§11.4 rule 9).

| User says | Tool call |
|---|---|
| ★ "How am I doing today?" | `ate_positions` → per vault and portfolio: realised / CEX-marked / exit-executable P&L, exposure, entry vs mark, budget and turnover left, AI scoreboard |
| "Halve the size and only trade if the spread is over 1%" | `ate_strategy_set { tradeSizeUsd, entrySpreadBps: 100 }` (every enabled market) |
| "Be more aggressive" / "Be more conservative" | `ate_strategy_set { riskProfile: "aggressive" }` (loosening fields: Touch ID) / `{ riskProfile: "conservative" }` (tightening: applies at once) |
| ★ "Be more conservative, stop out at 2%" | Asks "HSK, BTC or both?", then `ate_strategy_set { market, stopLossBps: 200 }` per answer (tightening: applies at once) |
| "Stop out HSK at 0.5%" (E6) / "Back to a 3% stop on HSK" | `ate_strategy_set { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: 50 }` / `{ market: "hsk-dex:WHSK/USDT:3000", stopLossBps: 300 }` (loosening: Touch ID) |
| ★ "Go to cash" / "Go to cash on HSK, keep the BTC" / "Only trade BTC" / "Target 20% HSK" | `ate_strategy_set { targetAssets: [] }` / `{ targetAssets: ["WBTC"] }` (both phrasings; immediate guard sell-down) / `{ market: "hsk-dex:WHSK/USDT:3000", rebalanceTargetPct: 20 }` |
| ★ "Why did you sell at 3am?" | `ate_journal_read` |
| ★ "Stop everything" | `ate_pause` on both vaults (reply notes that a pause also stops stop-loss exits and offers "go to cash" first) |
| "Raise the daily cap to $800" | Not possible from the agent. It replies with the exact `ate-owner set-limits` command for the owner to run on their own device |

`ate_strategy_set` values above on-chain limits are clamped, and the response says so.

## 12. Persistence

SQLite (`better-sqlite3`) at `~/.ate/ate.db` (desktop) and `/var/lib/ate/pay.db` (worker), WAL mode.
Numbered SQL migrations in a transaction, with a `schema_version` table. Migration `001_init.sql` (all
tables below) is generated from this section by the freeze agent and reviewed and frozen by the lead at
10:30 IST, while lanes build against them (§21.4); later changes are new
numbered migrations owned by Lane B.

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, address TEXT NOT NULL, chain_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE vaults (                    -- one row per market (§4.1); mirrors deployments/177.json
  address TEXT PRIMARY KEY, market TEXT UNIQUE NOT NULL, agent_id TEXT REFERENCES agents(id),
  price_token TEXT NOT NULL, price_decimals INTEGER NOT NULL, oracle TEXT NOT NULL, pool TEXT NOT NULL,
  deployed_block INTEGER NOT NULL
);

CREATE TABLE limits (
  id TEXT PRIMARY KEY, vault TEXT NOT NULL, hash TEXT NOT NULL,
  max_trade_usd TEXT NOT NULL, max_epoch_usd TEXT NOT NULL,
  epoch_duration INTEGER NOT NULL, max_slippage_bps INTEGER NOT NULL,
  max_oracle_deviation_bps INTEGER NOT NULL, max_exit_discount_bps INTEGER NOT NULL,
  max_oracle_age INTEGER NOT NULL,
  max_exposure_usd TEXT NOT NULL, cooldown INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE strategy (                  -- scope = 'portfolio' or a market id
  scope TEXT PRIMARY KEY, params TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY, market TEXT NOT NULL, vault TEXT NOT NULL REFERENCES vaults(address), side TEXT NOT NULL,
  token_in TEXT NOT NULL, amount_in TEXT NOT NULL, min_amount_out TEXT NOT NULL,
  rationale TEXT NOT NULL, rationale_hash TEXT NOT NULL, candidate_id TEXT, signal_id TEXT,
  origin TEXT NOT NULL,                   -- candidate | discretionary | guard | human
  thesis TEXT,                            -- required iff origin = discretionary (§11.4 rule 8)
  journal_hash TEXT NOT NULL,             -- = on-chain proposalId (§13)
  oracle_price TEXT NOT NULL, oracle_updated_at INTEGER NOT NULL, pool_price TEXT NOT NULL,
  policy_reason INTEGER NOT NULL, status TEXT NOT NULL,   -- … | expired | invalidated (§7.3)
  reserved_turnover_usd TEXT NOT NULL DEFAULT '0',        -- released on expired/rejected/invalidated/failed
  approved_by TEXT, approved_at INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY, proposal_id TEXT REFERENCES proposals(id),
  tx_hash TEXT, block_number INTEGER, status TEXT NOT NULL,
  amount_out TEXT, gas_used TEXT, exit_path INTEGER, eas_uid TEXT,
  error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY, market TEXT NOT NULL, generator TEXT NOT NULL, leg TEXT,   -- leg: open | close (spread-revert)
  side TEXT NOT NULL, max_amount_in TEXT NOT NULL,
  edge_bps INTEGER, cost_bps INTEGER, net_edge_bps INTEGER, reason TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_by TEXT
);

CREATE TABLE fills (                      -- cost basis for P&L, per market; spread-revert lots by generator
  id TEXT PRIMARY KEY, execution_id TEXT REFERENCES executions(id), market TEXT NOT NULL,
  generator TEXT NOT NULL, side TEXT NOT NULL, base_qty TEXT NOT NULL, quote_qty TEXT NOT NULL,
  price TEXT NOT NULL, cex_mid TEXT, at INTEGER NOT NULL
);

CREATE TABLE lots (                       -- spread-revert sub-ledger, close trigger only (§11.4 rule 4)
  id TEXT PRIMARY KEY, market TEXT NOT NULL, open_fill_id TEXT NOT NULL REFERENCES fills(id),
  qty_open TEXT NOT NULL, qty_remaining TEXT NOT NULL, entry_price TEXT NOT NULL,
  realised_usd TEXT NOT NULL DEFAULT '0',  -- reported alongside position P&L, never summed with it
  opened_at INTEGER NOT NULL, closed_at INTEGER
);                                         -- every sell consumes open lots FIFO first, then other inventory

CREATE TABLE payments (                   -- worker; mirrored read-only to desktop
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, conditions_hash TEXT NOT NULL,
  order_id TEXT, flow_id TEXT, payment_request_id TEXT UNIQUE,
  typed_data_digest TEXT, amount_raw TEXT, token TEXT, chain_id INTEGER,
  state TEXT NOT NULL, valid_until INTEGER,
  sign_approved_at INTEGER, submit_approved_at INTEGER,
  gateway_tx TEXT, attribution_verified INTEGER, last_status TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE decisions (                 -- the §13 journal; append-only, hash-chained
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  ref_id TEXT,                            -- the decision this record follows up (execution, payment_update, attestation)
  record TEXT NOT NULL,                   -- canonical JSON (RFC 8785) of the Decision
  prev_hash TEXT NOT NULL UNIQUE,         -- genesis prev_hash = 0x00…00 (32 zero bytes); UNIQUE forbids forks
  hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,   -- user | assistant | tool
  content TEXT NOT NULL, tool_name TEXT, decision_id TEXT, at INTEGER NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events   (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, payload TEXT);

CREATE INDEX idx_exec_proposal ON executions(proposal_id);
CREATE INDEX idx_prop_expires  ON proposals(expires_at);
CREATE INDEX idx_pay_state     ON payments(state);
CREATE INDEX idx_dec_ref       ON decisions(ref_id);
CREATE INDEX idx_chat_session  ON chat_messages(session_id, at);
```

Time is Unix seconds; all amounts are **decimal strings**, never floats. Knowledge-base tables are added
by a v1.0 migration.

---

## 13. Decision journal

Append-only, stored in the `decisions` table (§12) whose triggers reject `UPDATE` and `DELETE`. A record
is never edited after its hash is taken: outcomes are **new records** that point back with `refId`.
**Single writer:** every journal write — the trader's and chat agent's tool calls, guard exits, outcomes,
attestations and `ate rogue`'s records — goes through the daemon's journal API, which appends inside
`BEGIN IMMEDIATE` (read head, hash, insert, commit). `ate rogue` submits its records to the daemon; no
other process opens the database for writing. With `prev_hash UNIQUE` and a fixed genesis, the chain
cannot fork.

**Hashing and ids.** `hash = keccak256(prevHash ‖ canonical(record without id and hash))`; then
`id := kind-prefix + hash[2:18]` (e.g. `prop_` + 16 hex for proposals, `dec_` for no-trade). The id is
derived from the hash, never part of it, so it cannot be circular; the on-chain `proposalId` is the full
`hash`. A test recomputes every id from its hash (§18.2).

```ts
interface Decision {
  id: string;                             // derived: kind-prefix + hash[2:18]; excluded from the hash
  at: number;
  prevHash: string;                       // hash = keccak256(prevHash ‖ canonical(record without id and hash))
  kind: "proposal" | "no_trade" | "execution" | "attestation" | "strategy_change" | "pause"
      | "outcome" | "payment" | "payment_update";
  refId?: string;                         // execution / attestation → proposal id; outcome → vetoed/sized-down
                                          // decision id; payment_update → payment id
  engine: "llm" | "rules" | "guard" | "human";
  profile: "default" | "demo" | "rogue";
  actor: { kind: "agent" | "human" | "guard"; via?: "chat" | "cli" | "mcp" | "ui"; agentId?: string; address?: string };
                                          // derived from the caller's token scope (§10.1), never from input
  origin?: "candidate" | "discretionary" | "guard" | "human";
  candidateId?: string;
  thesis?: string;                        // discretionary proposals only
  intent?: { market: string; vault: string; side: "buy" | "sell"; tokenIn: string; amountIn: string };
  rationale: string;
  rationaleHash: string;
  context: {
    oracle: { price: string; updatedAt: number; roundId: string; ageSec: number };
    pool:   { price: string; twap: string; liquidity: string; deviationBps: number; twapDeviationBps: number };
    cex?:   { mid: string; halfSpreadBps: number; topDepthUsd: string; at: number };
    signal?: { id: string; generator: string; leg?: "open" | "close"; edgeBps: number; costBps: number; paid?: { paymentId: string } };
    quote?: { amountOut: string; impactBps: number; minOutFloor: string; exitPath: boolean; source: "simulation" | "estimate" };
    policy: { maxTradeUsd: string; epochRemainingUsd: string; turnoverRemainingUsd: string; cooldownRemainingSec: number };
    position?: { market: string; qty: string; entry: string; mark: string; cexMarkBps: number; unrealisedBps: number };
    portfolio?: { exposureUsd: string; turnoverRemainingUsd: string; dailyPnlUsd: string };
    suppressed?: { cause: "deviation" | "oracle_disagree"; side: "buy"; bps: number; supra?: string };
    blockNumber: string;
  };
  verdict: { ok: boolean; code: AteErrorCode | "OK" | "NO_TRADE"; message?: string; approvedBy?: "policy" | "human" };
  // kind-specific payloads (only on the matching kind):
  execution?:   { txHash: string; blockNumber: number; gasUsed: string; amountOut: string; exitPath: boolean; reverted?: boolean };
  attestation?: { easUid: string; schemaUid: string; txHash: string };
  outcome?:     { horizonSec: 1800; declinedAmountIn: string; markThen: string; savedBps: number; savedUsd: string };
  payment?:     { flowId: string; paymentRequestId: string; state: string; gatewayTx?: string; attributionVerified?: boolean };
}
```

**On-chain anchoring.** The on-chain `SwapParams.proposalId` is the `hash` of the proposal's journal
record (`ate_propose` returns its derived id, `prop_` + `hash[2:18]`). One journal chain covers both
markets, so every `TradeExecuted` on either vault commits the journal head **as of that trade's proposal
record** to the chain, for free, and the per-trade EAS attestation repeats it; records written between
propose and execute are anchored by the next trade. Edits to
records **before the last on-chain anchor** are detectable (the chain no longer recomputes to the anchored
hash); a same-user attacker can still rewrite records after the last anchor, which is why
no-trade-only stretches are anchored by the next trade (v1.0: a daily EAS-anchored Merkle root).

**EAS attestation per executed trade (must-ship).** Schema registered on the SchemaRegistry
(`0x4200…0020`) at deploy (§19 step 2) and pinned in `deployments/177.json`:
`bytes32 proposalId, bytes32 rationaleHash, bytes32 txHash, uint256 notionalUsd, bool exitPath, string engine,
string origin`, `recipient` = the trade's vault (identifies the market), non-revocable. After each `TradeExecuted` receipt the daemon (agent
key, gas float) enqueues `EAS.attest` on `0x4200…0021` in the `TxQueue` at the lowest priority (§7.1) and
journals an `attestation` record with the UID. A failed attestation is retried 3× and then journalled as
failed; below 1 HSK of gas it is deferred and back-filled after top-up (§4.2 Gas float); it never blocks
or reverses a trade. The Decisions view links
tx → attestation → journal record, so every judge click goes from the trade to its rationale.

The Decisions view is a timeline grouped by day; every row expands to the full record with Blockscout links
(trade tx, attest tx, `EAS.getAttestation(uid)` read), and shows the chain head hash. Only executed trades carry an on-chain `rationaleHash`; no-trade,
strategy and pre-flight-rejected records are verifiable through the hash chain up to the next anchor, not
individually on-chain.

## 14. Knowledge bases (v1.0)

Deferred; specified so the data model need not change.

- Namespaces `market`, `protocol`, `journal`, `user`. Ingest PDF, markdown, text, URL; chunk 800 tokens /
  120 overlap. Embeddings provider-agnostic; default local `all-MiniLM-L6-v2` via ONNX.
- Retrieval: BM25 (FTS5) + cosine, reciprocal-rank fusion, top-k 8. Tool `ate_kb_search`.
- Ingested text is untrusted, wrapped in `<untrusted_document>` markers. No retrieved text can trigger a
  tool call on its own; execution still requires a proposal and a policy pass.

---

## 15. UI specification

Layout: 56px icon rail · 280px context panel · fluid main · 320px inspector (collapsible).

### 15.1 Views

| View | Contents | States | Tier |
|---|---|---|---|
| **Chat** | Conversation with the agent (§11.5): streamed replies, tool-call cards (tool, args, result, journal link), clamping notices, quick prompts ("How am I doing?", "Go to cash on HSK, keep the BTC", "Only trade BTC", "Pause") | empty, thinking, tool running, clamped, LLM unavailable (rules fallback) | v0.1 must |
| **Decisions** | Journal timeline, filters (market / trade / no-trade / rejected / exit-path / discretionary / payment), market, generator and `origin` on every row, expandable records, Blockscout + EAS links, chain head hash | empty | v0.1 must |
| **Trade** | Market selector (WHSK/USDT, WBTC/USDT); market header with oracle, Supra cross-check, deviation and CEX-gap badges, simulated quote, policy checklist that ticks live, propose → execute | empty, loading, quoted, blocked (reason + hint), submitting, filled, error | v0.1 must |
| **Agents** | Trader status (running/paused), mode, target assets, profile per market, strategy params (human anchor vs agent-tuned value), key fingerprints, pause-all button, epoch budget bar per vault, portfolio turnover and exposure bars, P&L incl. fee drag per market; **AI scoreboard tile**: "LLM decisions today: X acts / Y vetoes + size-downs (bps saved ±W, E13) / Z of 3 discretionary — each with its rationale hash"; agent gas with low-gas alarm | no agents, gas low | v0.1 must |
| **Payments** | Mandates with state machine position, approval dialogs with full preview (§8.4) | none, G-HSP no-go (built, shown as not live) | v0.1 must (built on recorded responses); live only if G-HSP |
| **Positions** | Per vault and portfolio: balances, cost basis, spread-revert lots, realised P&L, unrealised marked at CEX mid and exit-executable | no positions | v0.1 must |
| **Chart** | Candles from pool `Swap` events, oracle line, CEX line | insufficient history | v1.0 |
| **Settings** | RPCs, unlock timeout, export journal | locked, unlocked | v0.1 minimal |

**Persistent evidence footer** on every view (and in the demo recording): both vault addresses
(Blockscout links), `limits()` summary, chain head hash, last `TradeExecuted` tx, an **uptime counter**
("running Xh Ym · N cycles · M trades", computed by the daemon from the journal since the trader's start
record, served on `GET /status`), **HSKSwap trades routed and USD routed** through both vaults (from
`TradeExecuted`, also on `GET /status`), and `docs/JUDGE.md` short link. Narration quotes the counter instead
of "day and night".

If Electron work slips, the daemon serves the same Decisions view and the footer read-only at
`http://127.0.0.1:<port>/view`, opened via a URL printed by `ate ui` carrying a one-time `view`-scope
token; GET-only, no mutating endpoint, the one exception to the `ate://local` Origin rule (§10.1). The
demo is never blocked on the shell; `ate chat` covers the Chat view. The fallback is a demo path, not a
scope cut: the Electron app with all six v0.1 views still ships (§21.1 item 9).

### 15.2 Interaction rules

- "Execute" is enabled only when a quote is fresh (< 15 s) and `check() == OK`.
- Blocked state shows the exact contract reason plus an actionable hint. No generic "failed".
- Every action produces a toast with an explorer link when a tx exists.
- Keyboard: `⌘K` command palette, `⌘Enter` execute, `Esc` cancel.
- Accessibility: WCAG 2.1 AA, full keyboard path, visible focus rings, `prefers-reduced-motion` honored.

### 15.3 Design constraints

- Dark-first, single accent, no gradients on financial data.
- Tabular numerals; amounts right-aligned; never abbreviate a value the user might sign.
- Red/green are never the only signal (icon + text + color).
- Slippage, impact and deviation are always shown as numbers, never hidden behind a tooltip.

---

## 16. Configuration

`~/.ate/config.json`, validated with Zod at startup; unknown keys are an error.

```jsonc
{
  "version": 1,
  "chain": {
    "id": 177,
    "rpcUrls": ["https://mainnet.hsk.xyz", "https://177.rpc.thirdweb.com"],
    "explorer": "https://hsk.blockscout.com"
  },
  "agentKeyId": "uuid",                  // one agent key, `agent` on both vaults
  "guardian": "0x… (address only; key off the agent's machine)",
  "vaults": [
    { "market": "hsk-dex:WHSK/USDT:3000", "address": "0x… (deployments/177.json)" },
    { "market": "hsk-dex:WBTC/USDT:3000", "address": "0x… (deployments/177.json)" }
  ],
  "eas":   { "address": "0x4200000000000000000000000000000000000021", "schemaUid": "0x… (from deployments/177.json)" },
  "venues": {
    "hskdex": {
      "factory": "0x972cA9D1662F5e029cD18327D29026532E84c742",
      "router":  "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
      "quoter":  "0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD",
      "routerKind": "swaprouter02",
      "markets": [
        { "id": "hsk-dex:WHSK/USDT:3000", "base": "WHSK", "baseDecimals": 18, "quote": "USDT", "fee": 3000,
          "pool": "0x4ff515761864e7838b0adb8b5b2b8b7a068905dc",
          "oracle": "0x… (SupraAggregatorAdapter, deployments/177.json)", "supraPair": 517, "refreshThresholdSec": 1800,
          "apro": "0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b",   // cross-check only (§5.1)
          "cexSymbol": "HSKUSDT" },
        { "id": "hsk-dex:WBTC/USDT:3000", "base": "WBTC", "baseDecimals": 8, "quote": "USDT", "fee": 3000,
          "pool": "0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A",
          "oracle": "0x… (SupraAggregatorAdapter, deployments/177.json)", "supraPair": 0, "refreshThresholdSec": 1800,
          "apro": "0x204ED500ab56A2E19B051561258E3A45c850360F",   // cross-check only (§5.1)
          "cexSymbol": "BTCUSDT" }
      ]
    }
  },
  "oracle": {
    "maxAgeSec": 90000,                  // Supra age bound; adapter, pair and APRO cross-check address are per market above
    "cex":  { "provider": "hashkey-public-market", "site": "glb",
              "baseUrl": "https://api-glb.hashkey.com", "skillCommit": "<pinned>" }
  },
  "strategy": {
    "engine": "llm", "mode": "autonomous", "enabled": false,
    "portfolio": {
      "targetAssets": ["WHSK", "WBTC"],
      "maxDailyTurnoverUsd": "200",       // split equally among target assets; ≤ maxEpochUsd − maxExposureUsd each
      "maxPortfolioExposureUsd": "200",   // ≤ Σ vault maxExposureUsd ($300)
      "dailyLossLimitUsd": "10",
      "discretionaryTradesPerDay": 3, "discretionaryUsd": "10",   // v0.1 maxima; user may lower
      "agentTuneRange": [0.5, 1.5],                                 // agent-scope clamp vs human anchors
      "runTimeoutSec": 90,                                          // §11.1 kill → no_trade(timeout)
      "scanSeconds": 20,                                            // ADDITIVE v0.9, optional: deterministic candidate re-scan (§11.1)
      "candidateTtlSec": "from deployments/177.json"                // max(120, 2 × p95 LLM latency)
    },
    "markets": {
      "hsk-dex:WHSK/USDT:3000": { "profile": "default", "generators": ["spread-revert", "rebalance"],
        "tradeSizeUsd": "25", "maxPositionUsd": "150", "cycleSeconds": 120,
        "entrySpreadBps": 60, "minNetEdgeBps": 15, "rebalanceTargetPct": 40, "rebalanceBandPct": 10,
        "stopLossBps": 300, "takeProfitBps": 150, "reentryCooldownSec": 14400,
        "minEntryIntervalSec": 0 },        // ADDITIVE v0.9, optional (§11.4 rule 7)
      "hsk-dex:WBTC/USDT:3000": { "profile": "default", "generators": ["spread-revert"],
        "tradeSizeUsd": "25", "maxPositionUsd": "150", "cycleSeconds": 120,
        "entrySpreadBps": 60, "minNetEdgeBps": 15, "rebalanceTargetPct": null, "rebalanceBandPct": 10,
        "stopLossBps": 300, "takeProfitBps": 150, "reentryCooldownSec": 14400,
        "minEntryIntervalSec": 1800 }      // ADDITIVE v0.9, optional: spreads the $100 WBTC share over ~2 h
    }
  },
  "chat":  { "runner": "claude -p", "prompt": "agents/chat/PROMPT.md", "fallback": "rules",
             "runnerFlags": ["--strict-mcp-config", "--allowedTools", "mcp__ate__*"],   // allowlist; no built-ins, no skills
             "allowedTools": ["mcp__ate__*"] },
  "payments": {
    "enabled": false,                    // set true only after G-HSP go
    "worker": "http://127.0.0.1:7401",
    "provider": "hsp", "endpoint": "https://mcp-qa.hashkeymerchant.com/",
    "transport": "streamable-http", "merchantName": "Vikings",
    "signer": "okx-agentic-wallet", "fallbackSigner": "local-eoa",
    "requireSignApproval": true, "requireSubmitApproval": true,
    "signalPriceUsd": "0.02", "perPaymentCapUsd": "0.10", "dailyCapUsd": "1.00"
  },
  "daemon": { "autoLockMinutes": 15, "port": 0, "gasAlarmHsk": "2", "attestFloorHsk": "1",
              "approvalFallback": "off" },   // "off" | "armed" (ADDITIVE v0.9: codes off until enabled on the daemon TTY, no restart) | "tty"; §10.1; refused once ate-approve passes
  "supra":  { "storage": "0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57", "pull": "0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD",
              "proofUrl": "https://rpc-mainnet-dora-2.supra.com/get_proof", "chainType": "evm",
              "maxDisagreeBps": 250 },   // §5.1/§5.2; maxDisagreeBps gates entries against the APRO cross-check
  "ui": { "theme": "dark", "reducedMotion": false }
}
```

**Changed in v0.9.1:** each market's `oracle` is now its `SupraAggregatorAdapter` (not the APRO feed), with new
`supraPair`, `refreshThresholdSec` (default 1800) and the APRO address moved to `apro` (cross-check only);
`oracle.apro.maxAgeSec` became `oracle.maxAgeSec`; `supra` gained `pull`, `proofUrl`, `chainType` and lost
`use` and `maxAgeSec`. A v0.9.0 config whose `oracle` is an APRO address fails the immutables check below.

**Additive keys (v0.9):** `strategy.portfolio.scanSeconds` (default 20), per-market
`minEntryIntervalSec` (default 0; WBTC 1800) and the `daemon.approvalFallback` value `"armed"` are
optional with defaults, so a v0.8 config still validates; the Zod schema adds them, nothing is renamed.
Precedence: CLI flag > env (`ATE_*`) > config file > defaults. Secrets never live in this file. The second
RPC is a fallback candidate and must pass `ate doctor` (chain ID, head freshness) before use.
For each entry in `vaults`, `venues.hskdex.router`, `factory` and the matching market's `pool`, `oracle`,
`base` token and `baseDecimals` must equal that vault's immutables (§4.1) — a mismatch is a
`ConfigError` (the market's `oracle` is the adapter; `ate doctor` also checks `adapter.supraStorage()` ==
`supra.storage` and `adapter.pairIndex()` == `supraPair`); `routerKind` accepts only `swaprouter02`; `oracle.maxAgeSec` is capped at each vault's
`maxOracleAge`. `--profile WHSK=demo` overrides the WHSK market's profile only (§11.3); the WBTC market
cannot be given the demo profile in v0.1. Each market's turnover share is clamped to ≤ its vault's
`maxEpochUsd − maxExposureUsd` at load and on every `ate_strategy_set`.

---

## 17. Security

### 17.1 Threat model

| # | Threat | Impact | Mitigation |
|---|---|---|---|
| T1 | Agent compromised / prompt-injected | Execution loss, exposure on both vaults | Bounded per vault by §4.6 (portfolio = sum); immutable pair/pool/oracle/router; exposure cap per vault; proceeds stay in each vault |
| T2 | Agent lies about market to widen slippage | Overpay | Floor computed in-contract from oracle; agent input ignored |
| T3 | Shell-capable agent reads daemon agent token/keychain | Trades within both vaults' limits (ignoring the off-chain portfolio guard), pause, gas burn, agent-clamped strategy edits (journalled `actor=agent`), junk attestations | Daemon holds no owner or guardian key; agent key can only `execute`/`pause`; `ui` token never on disk and minted only via spawn pipe or a Touch-ID-signed `/ui/attach`; `chat` tokens per session, allowlist enforced server-side, `actor` derived from scope; approvals need a Secure Enclave signature whose key blob only `ate-approve` can read (keychain ACL), with a payload-derived Touch ID prompt (§10.1) |
| T4 | Stale oracle exploited (sandwich / colluding pool) | Overpay | Spot + TWAP deviation check; loss per trade ≤ deviation + slippage + fee while the Supra feed is live (§4.6 assumptions) |
| T4b | TWAP held down to abuse the exit path | Sell below fair | Sells only; 300 s TWAP; floor at `min(P, TWAP)` minus slippage + fee; TWAP ≥ `P` − `maxExitDiscountBps` (500); bounded in §4.6: ≤ $7.50 extra per vault per episode, ≤ $25.75 per vault and ≤ $51.50 for the portfolio per UTC day across all paths ($103 rolling 24 h). Thin arbitrage (cheaper still on the ~$101k WBTC pool) makes the attack cheap, so the bound, not its cost, is the defence |
| T5 | Agent or tricked owner routes into attacker-seeded pool / oracle / router | Drain | Pool, oracle and router immutable; no pool parameter; owner ops on the second device with typed args |
| T6 | Renderer XSS | Unauthorized actions | Renderer has no daemon token; owner ops impossible; CSP; no `innerHTML` |
| T7 | Malicious / rate-limited RPC (429, Cloudflare 1015 bans) | Wrong quote, stuck tx, demo outage | ≥ 2 RPCs with head/chain-ID cross-check, Multicall3 batching, backoff, pre-flight `eth_call`; owner CLI uses its own RPC list |
| T8 | Supply-chain compromise | Code in daemon | Lockfile, `pnpm audit`, no postinstall scripts, signed releases (v1.0) |
| T9 | Replay of an old proposal | Unintended trade | 120 s expiry, single-use ids, on-chain `deadline` |
| T10 | Owner key loss | Frozen funds | Two-step transfer; Safe owner (v1.0) |
| T11 | Denial via epoch exhaustion or deviation | Agent idle | Explicit reason + reset time; accepted |
| T12 | Double payment on retry | Duplicate charge | §9.6 query-before-retry; unique `payment_request_id` |
| T13 | Forged payment conditions / signal | Pay wrong party, act on junk | Conditions signed by known key; `payTo` allowlist; signal treated as data |
| T14 | Local process hits forwarded worker port | Unauthorized payment | Worker token + Secure Enclave–signed, digest-bound approvals |
| T15 | AWS operator credentials stolen, or the agent's Mac compromised while an operator AWS session is live | Payer funds (≤ $1.00), OKX session | MFA 1 h sessions, SSM logging, payer balance ≤ daily cap; vault unaffected. Residual, stated in §3.4/§8.1: no Touch ID is needed on this path |
| T16 | Same-user malware edits config/journal | Bad data to guard/UI; forged history | Signed config (v1.0; pinned RPC list in v0.1); append-only triggers; hash chain anchored on-chain by every `proposalId` and EAS attestation (edits before the last anchor detectable); on-chain limits unaffected |
| T17 | Prompt injection via chat text, CEX data or journal content (confused deputy: agent-written rationale read by the chat agent) | Agent changes strategy or target assets, pauses, or spends its discretionary lane | Chat runner started with a tool **allowlist** (`mcp__ate__*` only; no built-ins, no skills — tested) and the MCP server enforces the `chat`-scope allowlist (no shell, no file access, no `ate_execute`); agent-authored text wrapped in `<untrusted_agent_text>`; **loosening changes need an `ate-approve` signature over the rendered diff** (§11.5); trader tuning clamped ×0.5–×1.5 of human anchors; discretionary lane ≤ 3 × $10/day; strategy clamped to on-chain limits; every change journalled. Worst case without a Touch ID: a pause, go-to-cash or a *tighter* / less active agent, inside §4.6 — accurate because every field that makes the agent larger or more active is loosening (§11.5 direction table, one test per field and direction) |
| T18 | Sandwich / back-run of honest trades | Worse fills | Honest `minAmountOut = max(floor, quote × 0.995)` re-quoted at execute (§4.2); ≤ ~50 bps + fee per honest trade; $5–$100 clips too small to pay a sandwich |
| T19 | Nonce collisions or a stuck tx between executes, exits, attests and pause on either vault | Stuck or dropped exit or pause | Single `TxQueue`, depth-1 (one agent-key tx in flight), priority (pause > exits > executes > attests) at every nonce; same-nonce replacement after 20 s at `max(original × 1.25, suggested)` fees; a pause or guard exit replaces a pending execute/attest at its nonce, and is re-signed at the next nonce if the displaced tx mines first (§7.1) |
| T20 | WBTC loses its BTC peg, or the WBTC pool's TWAP is unavailable (low observation cardinality) | Mis-valued exposure; buys and exits on Vault-BTC blocked | Peg is a stated §4.6 assumption, `doctor` warns when the pool disagrees with both the oracle and the CEX; cardinality is 240 (read Nov 2) and `doctor` re-checks ≥ 64 before deploy and the demo (§19); `check()` pre-filter withholds deviation-blocked buys (§11.3); exposure ≤ $150 on that vault |
| T21 | A buy proposed before a stop-loss executes after it, or concurrent proposals jointly exceed turnover / discretionary counts | Re-entry into a stopped-out position; budget overrun | Guard re-run at execute; reservations at propose; guard exits and the breaker invalidate open buys (§7.3, §11.4) |
| T22 | Entries and re-buys spend the epoch budget a stop-out needs | Stop-loss blocked by `ERR_EPOCH_CAP` | Exit-reserve rule 3b at propose and execute (§11.4); breaker pauses after its bounded flatten (rule 6) |
| T23 | Supra feed wrong, delayed or compromised (committee, Supra-administered storage proxy) | Mis-priced floor; trades and exits at a wrong `P` | The pricing trust root since v0.9.1 (APRO is no longer in the path). Bounded by the §4.6 oracle assumption and its oracle-is-wrong ceiling (per vault ≤ $250 of USDT plus holdings); spot and TWAP deviation guard; the adapter is immutable, ownerless and read-only; the Supra–APRO cross-check withholds entries at > 250 bps; owner/guardian pause |
| T24 | Supra round stale or refresh impossible (proof endpoint down, agent out of gas, pair unpopulated) | Buys and exits revert `ERR_ORACLE_STALE` / `ERR_ORACLE_INVALID` | Daemon pull-refresh before entries past `refreshThresholdSec` and on any stale revert (§5.2); anyone can pull; the market goes read-only rather than falling back to DEX spot; stop-loss exits wait while the oracle is stale or invalid (stated limit, T1.11, §11.4); `gas.low` alarm; `doctor` prints ages |
| T25 | Hostile, replayed or future-dated proof submitted by a third party | None on price | `verifyOracleProof` checks the committee signature and Merkle proof, writes only rounds newer than stored (older or equal: silent no-op) and rejects rounds > 3 s ahead; the adapter caps `updatedAt` at `block.timestamp` |
| T26 | APRO never grants contract access, or later revokes it | None: APRO is not in the enforcement path | The cross-check degrades to inactive per market, stated in `doctor` and the badge; APRO-backed vaults only if access is granted (`ORACLE_SOURCE=apro`, §25 Q13)

### 17.2 Non-negotiables

1. No product telemetry, analytics or remote crash reporting. Disclosed provider calls: configured RPCs,
   Blockscout API (replay), HashKey Global public market data, the user's configured LLM provider (via
   their own agent CLI, for the trader and Chat — it receives market data, positions and journal
   excerpts, never keys or tokens), HSP and OKX (worker only, if G-HSP). Cloud infrastructure uses AWS SSM and
   operational logs with secret redaction.
2. No remote code execution path in the daemon.
3. Owner operations are never signed by the daemon. Payments require two explicit approvals; the payer
   EOA is outside PolicyVault.
4. Dependency additions require a written justification in the PR.

### 17.3 CSP

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self';
frame-ancestors 'none';
```

---

## 18. Reliability, performance and testing

### 18.1 Budgets

| Metric | Budget |
|---|---|
| Quote round-trip (RPC 100 ms) | < 400 ms |
| Trader cycle, both markets (excluding LLM latency) | < 2 s (one Multicall3 read carrying slot0/TWAP/Supra/vault state, plus two direct APRO `eth_call`s, `check()` pre-filters and ≥ 4 QuoterV2 calls — entry-size quote and full-position exit mark per market — + two CEX `bookTicker` reads) |
| LLM run | killed at 90 s (§11.1); candidate TTL = max(120 s, 2 × p95) |
| Journal query (10k rows) | < 50 ms |
| Cold start to interactive | < 2.5 s (v1.0 gate) |
| Daemon RSS idle | < 180 MB |

Retry: RPC calls retry 3× with jitter (250 ms base, 8 s cap) on network errors, 5xx **and 429**
(honouring `Retry-After`), then fail over to the next RPC. A Cloudflare 1015 ban takes that RPC out of
rotation for 10 minutes. Per-cycle reads are one Multicall3 call for both markets; the trader never fans
out requests. Transaction retries re-broadcast the identical raw tx; **replace-by-fee happens only inside
`TxQueue`** (same nonce, fees `max(original × 1.25, suggested)` after 20 s, or a pause/guard exit
displacing a pending execute/attest; §7.1).

Degraded modes — the UI names which one applies, per market where relevant: **read-only** (RPC down,
or that market's oracle invalid),
**deviation-blocked** (pool too far from oracle: buys blocked, exits via the 7b exit path), **locked** (keystore sealed), **paused** (kill switch;
guard exits stop too), **policy-blocked** (chain refuses), **gas-low** (agent float < 2 HSK: alarm; < 1 HSK:
attestations deferred).

### 18.2 Tests

| Layer | Tool | Submission gate | GA gate |
|---|---|---|---|
| Contract unit | Foundry | every reason code 1–15 hit, both directions, exit path 7b with `T > P` and `T < P`; **both priceToken shapes (18-dp, 8-dp)**; constructor rejects wrong orientation/decimals; I5 owner-only per function × non-owner actors; `exposureUsd()` formula/rounding/oracle-revert | 100% branch |
| `check()`/`execute()` parity | Foundry | every reason code: view code == custom error; same `minOutFloor`, `exitPath`; both shapes | — |
| Contract invariants | Foundry `invariant_` on local mocks | I1–I4, I6, I7 (handler assertion), I8, I9, I11–I13; `runs = 64, depth = 32`, 6 actors; both shapes (I5 unit, I10 parity) | all; `runs = 500, depth = 100`, 8 actors, both shapes, plus fork |
| Fork smoke (pre-deploy) | `forge script` + `forge test --fork-url` on Anvil fork of 177 (pinned block, cached) | **both vaults**: constructor asserts pass against the real factory, both pools, router and both Supra adapters (**no APRO access granted**); `check()` OK; $5 buy + sell (output equals QuoterV2; ~168k gas buy, ~120k sell); forced deviation → 7b exit sell; `observe([300, 0])` succeeds on both pools; a real DORA proof through `verifyOracleProof`; the APRO-backed variant shows `check()` = 6 until `addAccess(vault)` | in CI |
| Policy math TS ↔ Sol | vitest + forge | — (Demo Day: 200 cases, both shapes) | 500 |
| Adapter | vitest on Anvil fork of 177 | one quote vs fork execution (in the fork smoke) | Demo Day: within 1 bps over 50 sizes; in CI |
| Journal | vitest | `UPDATE`/`DELETE` abort; chain recomputes; `proposalId` == record hash; every id derivable from its hash; a second record with the same `prev_hash` is rejected (`UNIQUE`); concurrent writers serialise via `BEGIN IMMEDIATE` | — |
| MCP | vitest + MCP Inspector CLI | schemas, envelope, error codes (incl. `ATE_MARKET_UNKNOWN`), candidate binding (required / mismatch / expired), discretionary lane (thesis, count, size), **propose buy → guard exit → execute rejected `ATE_STRATEGY_BLOCKED`**, loosening change → `ATE_APPROVAL_REQUIRED` until signed, **one case per field and direction of the §11.5 table** (incl. `riskProfile` expansion and mixed patches), tightening applies at once, `rogue` scope: an `agent` token on the raw path → 403, a foreign `to` or selector → refused, agent text wrapped `<untrusted_agent_text>`, deviation/`oracle_disagree` buys listed in `suppressed`, not emitted, reservations (two concurrent proposals cannot exceed turnover), scope tool sets (`chat` → `ATE_TOOL_NOT_ALLOWED` on `ate_execute`), `actor` from scope, agent tuning clamp; stdio proxy | — |
| Portfolio guard | vitest | `minEntryIntervalSec`: two WBTC candidates 120 s apart → second suppressed `cause=entry_interval`; `scanSeconds`: a gap opening between ticks → one out-of-schedule cycle; turnover split among target assets and clamped to `maxEpochUsd − maxExposureUsd`; portfolio exposure cap; **exit reserve: start at $150 exposure, close $100, re-buy → blocked once the reserve would be breached**; `targetAssets` de-selection → immediate `guard_exit` sell-down (turnover-exempt, no re-entry lock); breaker flattens, and **with exits blocked pauses both vaults after 2 cycles / 5 min**; lots: every sell consumes spread-revert lots FIFO, position P&L stays average-cost; token caps sized at `max(P, T) × 0.99` | — |
| Strategy seam | vitest, both lanes | Lane B's pass-through stub (rules 1–3) and Lane C's implementation pass the same `strategy.ts` contract fixtures (generate, check at propose/execute, reserve/release, onGuardExit) | — |
| Runner | vitest with a stub LLM | overlapping tick skipped; 90 s kill → `no_trade(timeout)`; `candidateTtlSec` read from `deployments/177.json`; `strategy_change` → out-of-schedule cycle ≤ 1 per 30 s; `ate smoke` binds its `smoke` candidate in `autonomous` mode with no approval path | — |
| TxQueue | vitest on Anvil | concurrent execute + exit + attest + pause across both vaults: no nonce gap or reuse; depth-1; priority order; **stuck attest → pause replaces it at the same nonce** with fees `max(original × 1.25, suggested)`; **displaced tx mined first → pause re-signed at the next nonce**; unmined 20 s → same-nonce replacement | — |
| Chat | vitest with a stub runner | allowlist enforced server-side; **runner's reported tool list == `mcp__ate__*` allowlist** (no built-ins); five ★ intents via rules fallback; strategy change journalled `actor=human, via=chat`; unscoped stop change asks "HSK, BTC or both?" before applying | Playwright |
| `ate-approve` | XCTest + vitest | payload-derived prompt text; signature verifies against pinned key; key item ACL rejects an unsigned reader; `/ui/attach` issues a `ui` token only for a valid signature over a fresh nonce; strategy-diff payload signs and applies; TTY-code fallback refused once this test passes; `armed` mode: codes refused until `approval-fallback enable` is typed on the daemon TTY (no HTTP route), and enabling needs no restart | — |
| Replay | vitest on a recorded day of logs | deterministic output for the fixture, both markets, incl. gap-persistence stats and verdict | — |
| Rogue agent | `ate rogue` on mainnet (§22.3) | every on-chain attack reverts with expected code | in CI on fork |
| Payments | vitest with recorded HSP responses | state machine incl. 30043, denial, uncertain submit | live QA |
| E2E | Playwright (Electron) | Decisions view renders E3–E7 and E14 rows with links (Lane E if G-HSP not confirmed by 12:00, else Lane D) | happy, blocked, kill switch, crash-restart |
| Security | `pnpm audit`, gitleaks | no high/critical, no secret in bundle | CSP test |

---

## 19. Deployment runbook (mainnet 177)

Pre-flight (`ate doctor --chain`), **per market**: chain ID 177; ≥ 2 RPC heads agree; adapter reads (`adapter.supraStorage()` and `pairIndex()` match config; `latestRoundData()` non-zero) and Supra age <
`maxOracleAge` (prints the age; if older than `refreshThresholdSec`, runs one `oracle_refresh`; re-run before the demo); APRO feeds readable by direct `eth_call` (cross-check only; `answeredInRound == roundId` already recorded, Q7); pool spot and TWAP vs oracle < `maxOracleDeviationBps` (if not, a normal-path smoke trade
will revert — record it and re-check later); router `factory()` matches; pool `fee()` == 3000,
`token0()` == priceToken, `token1()` == USDT; priceToken `decimals()` ∈ {8, 18}; adapter `decimals()` == 8;
**pool `observationCardinality` ≥ 64 and `observe([300, 0])` succeeds** (both pools read 240 on Nov 2;
no cardinality transaction is planned); QuoterV2 impact at $5 / $25 / $100; Supra vs APRO printed (bps,
ages, whether the entry gate is active per market; APRO unreadable → gate inactive, not a failure); agent gas ≥ 2 HSK (else alarm).

Step 0 runs at 10:30 IST; steps 1–5, 8 and 9 run from the second device (owner); steps 6–7 run on the agent's
machine with the daemon unlocked. Step 1 starts only after the Anvil-fork smoke of both vaults (§18.2) is
green and the bytecode is frozen (11:45 checkpoint, §21.4).

**Funding (09:50–11:00, ops).** All funds land first in an **ops hot wallet** on 177, never directly on
the owner. Route: USDT and HSK withdrawn from HashKey Global to HashKey Chain where the exchange supports
that network, otherwise bridged from Ethereum through the OP-standard L2StandardBridge predeploy
(`0x4200…0010`); arrival confirmed on Blockscout by 11:00. Target: ≥ 40 HSK gas (25 agent, 2 guardian,
~13 for two deploys, two verifies, limits, the EAS schema and margin), ~$60 of HSK to wrap
into WHSK (`WHSK.deposit()`), and ~$220 USDT. **Smaller-seed fallback:** if < $220 USDT is on 177 by
11:00, deploy anyway with the minimum seed — Vault-HSK $60 USDT + $25 WHSK, Vault-BTC $40 USDT — and set
`maxExposureUsd` to $60 per vault in step 3 (so the §22.3 exposure attack still has a reachable
precondition); §4.6 per-vault and portfolio numbers are then recomputed by the UI from `limits()`, and
the pitch card is regenerated from them.

0. **Owner signer test (10:30 IST).** `cast send --ledger` a 0-value tx to self on 177 **from the ops hot
   wallet-funded Ledger address** (fund it with 1 HSK only). If Ledger signing on 177 fails or is not
   working by 11:30, create the fallback owner with `cast wallet import owner --interactive` (encrypted
   keystore) **on the second laptop only**. Only after step 0 passes (Ledger or fallback) does ops move
   gas and seed from the hot wallet to the owner. Create the guardian keystore on the third device if
   available, else on the second laptop (§4.1). Never on the agent machine.
1. **Deploy the oracle adapters first, then the vaults**, from the same script (`forge script
   script/Deploy.s.sol:Deploy --rpc-url hsk --ledger --sender <owner> --broadcast`, or `--account owner`; env
   `AGENT`, `GUARDIAN`, `MARKETS=hsk|btc|both`; never a plaintext `--private-key`). Per market the script
   deploys a `SupraAggregatorAdapter(storage 0x58e1…3d57, pair, description)` — HSK pair 517, BTC pair 0 — and
   then the vault with `oracle = adapter`; the vault bytecode is the same source and creation code, runtime
   bytecode differs only in the immutables. Full constructor args: `(USDT, WHSK, <HSK adapter>, SwapRouter02
   0x2c16…D8F3, pool 0x4ff5…05dc, factory 0x972c…c742)` for Vault-HSK and `(USDT, WBTC 0x6119…5b14, <BTC
   adapter>, SwapRouter02 0x2c16…D8F3, pool 0xd9EA…449A, factory 0x972c…c742)` for Vault-BTC. Before step 3,
   read each adapter (`latestRoundData()` non-zero, `updatedAt` sane); if the pair is older than
   `refreshThresholdSec`, run one `oracle_refresh` so the first `check()` is not `ERR_ORACLE_STALE`. No APRO
   allow-listing is needed. `ORACLE_SOURCE=apro` deploys an APRO-backed vault instead, only if APRO has
   allow-listed the vault address (§25 Q13). The same one-command form is the `docs/INTEGRATE.md` example.
2. Record both vault **and both adapter** addresses in `deployments/177.json`; verify each adapter
   (`SupraAggregatorAdapter.sol:SupraAggregatorAdapter`) and each vault on Blockscout with its own
   `forge verify-contract --constructor-args …` (immutables differ, so Blockscout may label the second a
   similar match); register the EAS schema (§13) once on SchemaRegistry
   `0x4200…0020` and record its UID.
3. `setLimits(...)` on **each** vault, defaults: `maxTradeUsd=100e8`, `maxEpochUsd=250e8`,
   `maxExposureUsd=150e8`, `epochDuration=86400`, `maxSlippageBps=250`, `maxOracleDeviationBps=250`,
   `maxExitDiscountBps=500`, `maxOracleAge=90000`, `cooldown=60`.
4. On each vault `setAgent(<agent>)` (the same agent address), `setGuardian(<guardian>)`; send **25 HSK**
   gas to the agent and 2 HSK to the guardian (§4.2 Gas float); ops tops the agent up whenever the
   `gas.low` alarm fires.
5. Seed **Vault-HSK** with ~$120 USDT and ~$60 of WHSK (seed WHSK basis = the oracle (Supra) price at that block,
   §11.4) and **Vault-BTC** with ~$100 USDT (no WBTC seed: its first position is the spread-revert buy).
   Disconnect the owner signer.
6. Smoke (agent's machine), per vault: `check()` → `OK`; `ate smoke --market <id> --usd 5` runs one
   **`autonomous`, `--engine rules`** cycle in which the daemon emits a single one-shot $5 buy candidate
   (`generator=smoke`, only under `ate smoke`) and the rules engine binds it via `ate_propose` →
   `ate_execute` → `TradeExecuted` + EAS attestation (counts against that market's turnover share; labelled
   `smoke`, not Track 1 evidence). No approval path is involved, so it does not depend on `ate-approve`.
   $5,000 `check()` → `ERR_TRADE_CAP`. Record all in `docs/evidence.md` (§22.2).
7. **Start the mainnet daemon once, headless, with `--approval-fallback=armed --allow-rogue`** (~13:00,
   before step 6; the `rogue` token is printed once to its TTY and is dormant until §22.3 runs), so neither
   the 14:30 TTY degradation nor the 15:30 rogue run needs a restart (a restart locks the daemon, §8.3).
   Start the trader (`ate agent run --mode autonomous --profile WHSK=demo`; WBTC runs the default
   profile; portfolio turnover $200) **as soon as step 6 is green and Lane C's strategy guard has replaced
   the stub, target ~14:00** (never on the stub; latest 14:30). **Trader start opens the G6/E12 window**:
   ops-2's continuous screen recording starts at the same minute, and no human input reaches the trader
   until the 15:30 rogue run.
8. After any demo or circuit-breaker pause: `ate-owner unpause --all` from the second device (after
   step 9: Vault-HSK via `ate-owner`, Vault-BTC as a Safe transaction); record the
   txs (E5); **then, if the pause came from `ate_pause` or the breaker (which lock the daemon, §8.3),
   `ate unlock` on the agent's machine**, and confirm the trader's next cycle (a new journal row) before
   declaring recovery.
9. **Safe owner for Vault-BTC (~17:00, after E5 and E6 are recorded).** Ops-1 creates a Safe on 177 with
   `safe-core-sdk` (v0.1: the Ledger/keystore owner as sole Safe owner, threshold 1 — never the guardian
   or agent key; 2-of-3 at v1.0) and runs the two-step ownership transfer of Vault-BTC to it (§4.5); the transfer and
   acceptance txs go in `docs/evidence.md`. Vault-HSK keeps the Ledger owner, so `ate-owner` still covers
   it; Vault-BTC's owner operations (incl. Demo Day unpause) run as Safe transactions via `safe-core-sdk`.

**Epoch budget for Nov 2, per vault** (UTC day = 05:30 IST Nov 2 → 05:30 IST Nov 3; `maxEpochUsd`
$250): entries incl. the $5 smoke and discretionary trades ≤ $100 (the market's turnover share, §11.4
rule 3); the exit reserve (rule 3b) keeps `exposure / (1 − dev)` of budget free after every non-guard
trade, so a full exit fits by that rule (stated exceptions in rule 3b). Reverted rogue txs consume nothing; only the exposure and slippage attacks need headroom
(they must pass step 9 to reach steps 11–13). The rogue run is on **Vault-HSK** at 15:30 IST. On-chain
`spentUsd` counts entries **and** turnover-exempt sells (spread-close, `discretionary_exit`, guard exits),
so headroom is not assumed: **`ate doctor` reads `headroom = maxEpochUsd − spentUsd` at 15:15**; the
exposure attack needs ≥ (150 − WHSK holdings) × 0.975 of it (at the default seed Vault-HSK holds ~$72 of
WHSK and ~$108 USDT at its 40% band, so ~$76–$100), the slippage attack ≥ $5. `ate rogue` sizes its buys
from `epoch()`; the rogue key bypasses the off-chain reserve, which is the point. Until E4 is recorded the
guard keeps an off-chain $100 rogue reserve on Vault-HSK (non-guard trades only). **If headroom is short
at 15:15**, the exposure attack runs at 05:35 IST Nov 3 (fresh epoch, before the pitch list) and is
added to E4; the other attacks run at 15:30 as planned. E7 and the HSK rebuild follow, then E6, on
Vault-HSK only (market-scoped, §11.5; §21.4 15:45–16:30).

Gas on 177 is negligible: ~500 gwei on Nov 2, so a 3M-gas deploy costs ~$0.13 plus the L1 data fee.

---

## 20. Error taxonomy (daemon-level)

```
AteError
├─ ConfigError        invalid/missing config, schema violation
├─ WalletError        locked, decrypt failed, keychain denied
├─ ChainError         rpc unreachable, rate limited, nonce conflict (TxQueue resyncs, §7.1), stuck tx
│                     (TxQueue same-nonce replacement), gas low, revert (decoded)
├─ PolicyError        on-chain reason codes 1–5 and 9–14
├─ StrategyError      position limit, portfolio exposure, daily loss limit, turnover budget, re-entry
│                     lock, exit reserve, not a target asset / disabled, invalidated by guard exit or breaker,
│                     candidate required / mismatch, discretionary limit
├─ VenueError         router revert, no route, pool missing, market unknown, TWAP unavailable
│                     (observation cardinality)
├─ OracleError        on-chain codes 6–8 and 15 (invalid round, stale, deviation, exit price); source
│                     unavailable
├─ ProposalError      unknown, expired, consumed, invalidated
├─ ChatError          runner unavailable (falls back to rules), tool not allowed for scope, runner tool
│                     list ≠ allowlist (refuses to start)
├─ AuthError          missing/invalid token, invalid or expired `/ui/attach`, `/chat/session` or
│                     `/strategy/approve` approval (`ATE_APPROVAL_REQUIRED`), TTY code invalid/expired
├─ AttestationError   EAS attest failed after retries (journalled; never blocks a trade)
├─ PaymentError       denied, expired, limit, uncertain, network unsupported, unavailable, order mismatch,
│                     conditions invalid
└─ InternalError      invariant break — writes a diagnostic bundle, never auto-retries
```

Every error carries `{ code, message, hint, retryable, context }`. Hints are written for an LLM to act on.

---

## 21. Scope, plan and gates

**Submission deadline:** team-confirmed **≈ 18:30 IST, 2026-11-02**. Public sources conflict (page text
says Nov 1 21:30 IST; the DoraHacks widget said Nov 2 04:00 UTC = 09:30 IST); both earlier readings had
passed when implementation started at 09:50. **Ops-2 gets the deadline in writing from the organisers by
11:00** (organisers' channel or in person; screenshot committed as `docs/deadline.md`). If they say the
window has closed, nothing in this plan recovers it: ops-2 asks in the same message for written
acceptance of a late BUIDL, and the build continues for Demo Day either way. **The Track 1 BUIDL is
created and submitted as soon as the first vault is deployed and verified (target ~12:30; latest 13:30
via the 13:15 rule)** — repo link, the vault address(es) on Blockscout, `limits()` read, the 03:50 WBTC
snapshot, a one-paragraph summary whose first sentence names the customer (§0 *Who it is for*) and states
the WBTC figure realised-first, and a `docs/JUDGE.md` stub. It is then edited: smoke tx + EAS UID and the
E11 replay headline (~13:30), the first LLM-decided trade (~14:30), JUDGE.md link (3) (16:00), full draft
saved 17:00, **final edit submitted by 18:00 (hard)**, leaving the 18:00–18:30 buffer. **The BUIDL is
never submitted without a mainnet vault address.** The timeline is re-read live at 16:00.
**Pitch list:** Nov 3. **Demo Day:** Nov 4, Mumbai, in person (in-person gets selection priority).

Starting point: the plan was written 02:30–04:00 IST; implementation lanes started at **09:50 IST** from
the spec, the AWS network + worker and no application code. The scope below is a fixed team decision and
is kept whole; the WBTC market adds a second instance of the same vault, a second market config and
per-market strategy state, not a second design. It is delivered by five lane coding agents working in
parallel against interfaces and stubs frozen at **10:30** (every lane can run its acceptance tests
without waiting for another lane), fixed checkpoints with pre-agreed reassignments (§21.4), and a
demo-path fallback for every user-facing surface. The human team does only what agents cannot: signing,
funding, organizer contact, recording.

### 21.1 v0.1 — must ship (submission)

| # | Item | Lane |
|---|---|---|
| 1 | `PolicyVault` (generic 8/18-dp priceToken, exit path 7b with `min(P, T)` floor, post-swap exposure check) fork-smoked against both pools, **deployed twice (Vault-HSK, Vault-BTC) and verified** on 177, limits set on both, EAS schema registered, smoke evidence recorded; one-command `Deploy` script (adapter first, then vault) and `SupraAggregatorAdapter` with its tests | A |
| 2 | Foundry suite at the submission gate (§4.4): unit, parity, core invariants on local mocks for both shapes, fork smoke of both vaults | A |
| 3 | Daemon: keystore (agent), config (two markets, *additive* keys §16), chain client (Multicall3, ≥ 2 RPCs), single depth-1 `TxQueue` with same-nonce replacement (§7.1) and the `rogue`-scoped raw route (§10.1), gas alarm, Supra oracle reader + pull refresher (`oracle_refresh`) + APRO cross-check reader + pool + CEX readers for both markets (`hashkey-public-market`), candidates incl. spread-revert open/close, `discretionary_exit`, `check()` pre-filter, `scanSeconds` re-scan (§11.1) and `smoke`, QuoterV2 quote + vault pre-flight, strategy-seam stub (rules 1–3) behind the frozen `strategy.ts` (Lane C's full guard, §11.4 rules 1–9 incl. 3b, reservations, replaces it), single-writer append-only hash-chained SQLite journal (§12–§13), veto `outcome` scoring (E13), `/status` uptime + HSKSwap routed counters, `/cycle`; `ate doctor` incl. the **Supra entry gate + cross-check**, pool cardinality and epoch headroom; `ate smoke`; npm publication of `@ate/venues` and `@ate/mcp` by 17:30 | B |
| 4 | MCP server with the §7.2 trading tools (both markets, `targetAssets`, *additive* `riskProfile`), scope-enforced tool sets (`agent` / `chat`), `actor` from scope, stdio proxy | B |
| 5 | Reference trader running autonomously from ~14:00 (cycle rules §11.1: no overlap, 90 s kill, measured candidate TTL; WHSK demo profile allowed, labelled by profile and generator; WBTC default profile with `minEntryIntervalSec` 1800): ≥ 1 candidate-bound LLM trade, ≥ 1 discretionary LLM trade, ≥ 1 veto/size-down and ≥ 1 `no_trade` on mainnet; the WBTC spread-revert trade when the gap is open (E14) | C |
| 6 | Chat (§11.5): prompt, allowlisted runner with the `chat` token, loosening direction table, `riskProfile`, rules fallback, `ate chat` (C); Chat view (D) | C, D |
| 7 | `ate replay --days 7` for both markets → `docs/replay-7d.md` (E11, incl. top-decile gaps for the T1.8 second path), headline in the BUIDL's first edit | C |
| 8 | Rogue-agent script (`agents/rogue` + `ate rogue` entry), runnable from a Claude Code session over stdio as the on-stage second client; every on-chain attack in §22.3 reverted on Blockscout | A |
| 9 | Electron app with Chat, Decisions, Trade, Agents (AI scoreboard), Positions and Payments views and the evidence footer (uptime counter), attaching to the running daemon; daemon-served read-only `/view` page | D |
| 10 | `ate-approve` (Swift, Secure Enclave, keychain-ACL-held key blob, §10.1) for `confirm`-mode trades, `ate chat` sessions, UI attaches, loosening strategy changes and payment approvals, **plus the daemon approval endpoints `/ui/attach`, `/chat/session`, `/strategy/approve`, the `armed` TTY degradation (§10.1) and the EAS attester** (E; Lane A takes `apps/approve/` from 14:00 if red); `ate-owner` incl. `pause --guardian --all` / `unpause --all` (A) | E, A |
| 11 | Payments **built**: `ate-signal`, `ate-pay` state machine tested on recorded HSP responses, wired to the Payments view; `docs/hsp-readiness.md` + recorded tool listing or organiser reply by 12:00. **Live use is optional**: only if G-HSP is go (then `ate_signal_buy` is registered and E8 is required) | E |
| 12 | Evidence and submission: `docs/evidence.md` E1–E14 and README incl. per-market realised and CEX-marked P&L since the trader's start with fee drag, realised-first, and the WBTC structural-discount caveat (lead); `docs/JUDGE.md` (D, or E per the 12:00 contingency); `docs/superpowers-log.md` (A); 60 s unedited live capture E12 as a separate file linked from `docs/JUDGE.md`, and a demo video ≤ 3 min containing a 25–30 s unedited E12 excerpt with timestamp overlay, plus the 90 s cut (ops-2); `docs/deadline.md` by 11:00, DoraHacks BUIDL created at the first vault deploy and final by 18:00 (ops-2); `vault-v0.1.0` tag + `docs/INTEGRATE.md` (one-command deploy, HSKSwap trades/routed USD) + draft `agent-policy-vault` skill PR to `HashKeyChain/HSK-Superpowers` + ecosystem-directory listing request by 17:30 (A; request sent by ops-2); Vault-BTC → Safe transfer (ops-1, §19 step 9) | lead, A, D/E, ops-1, ops-2 |

### 21.2 Should ship (in order; cut from the bottom)

Kredo `VenueAdapter` interface stub test.

### 21.3 Demo Day (Nov 3–4) and v1.0

Demo Day: rehearse §22 (3 min and 90 s), refresh evidence, full invariant run (`runs = 500, depth =
100`, 8 actors, both shapes, fork), TS ↔ Sol math parity (200 cases), quote vs fork execution within 1
bps, finish should-ship items, HSP live if access arrived late.
v1.0 GA: knowledge bases, `AgentRegistry`, daily EAS journal anchoring, atomic pull-and-trade freshness (proof submitted in the same transaction), other
token orientations/decimals, more markets (WETH: Supra already lists ETH/USD, pair 1), one agent key per vault,
on-chain portfolio limits, Kredo adapter, Safe owner by default, Chart view, Tauri shell, signed
releases, backtesting, SSM tunnel under a separate macOS user (§3.4).

### 21.4 Plan (IST, re-timed: lanes started 09:50 → submit 18:00 → buffer to 18:30)

**Staffing (resolves Q12).** One **lead** (human: orchestrates the agents, owns the frozen interfaces and
the integration branch, writes `docs/evidence.md` and the README), **five lane coding agents** (one per
lane, each in its own git worktree `lane-a` … `lane-e`; started 09:50 from the lane briefs and rebased
onto the 10:30 freeze commit), and **two ops humans, named in the lane briefs**: **ops-1 — signing**
(second laptop: funding, Ledger/keystore owner, guardian key, deploy/limits/seed signing, pause/unpause,
Safe transfer) and **ops-2 — recording and submission** (deadline in writing, screen recording, E12 cut,
demo beats, video, DoraHacks, HSP/organiser contact, ecosystem-directory request). Each is the other's
named backup; the lead backs up both. The 15:30 pause/unpause signing (ops-1) and the E12/demo recording
(ops-2) never share one person. "Ops" below means ops-1 unless a row says ops-2. Lane PRs that touch only
the lane's owned paths merge automatically when CI is green; the lead reviews only PRs that touch frozen
interfaces or another lane's paths. If an ops human is unavailable at a checkpoint, the other ops human
takes the task, then the lead.
Checkpoints are fixed: **10:30, 11:00, 11:45, 12:00, 12:45, 13:15, 14:00, 14:30, 14:45, 15:15, 15:30,
16:00, 16:20, 16:30, 17:00, 17:30, 18:00**.

**Interface freeze and stubs.** *Generation (09:50–10:30, the freeze agent — Lane B's agent before its
lane work):* from §4, §7, §12 and §13 it generates `contracts/src/IPolicyVault.sol` + custom errors +
`Limits`/`SwapParams` (ABI exported as JSON); `packages/core/src/types.ts` (`Decision`, `Candidate`,
`ToolResult`, `AteErrorCode`, `PriceSnapshot`, `Limits`, `MarketId`); **`packages/core/src/strategy.ts`**
— the B↔C seam: `CandidateGenerator.generate(snap: MarketSnapshot, pf: PortfolioState): Candidate[]`;
`StrategyGuard.check(p: ProposalDraft, pf: PortfolioState, phase: "propose" | "execute"): GuardVerdict`;
`Reservations.reserve(proposalId) / release(proposalId)`; `Invalidation.onGuardExit(market)` — with shared
contract-test fixtures; Lane B ships a pass-through stub implementing rules 1–3 so its MCP tools and the
smoke run early, and Lane C replaces it with the full guard (target 13:30, latest 14:15; the autonomous
trader never runs on the stub); `packages/journal/migrations/001_init.sql` (§12);
`packages/mcp/schemas/*.json` (§7.4, incl. `ate_candidates_get`, the discretionary fields, `targetAssets`
and the market enum); `/events`, `/chat`, `/status` and `/ui/attach` payload types;
`apps/cli/src/commands/index.ts` (§3.3); and **`packages/mcp/stub`**, an MCP server generated from the
frozen schemas that returns fixture responses for both markets (Lanes C and D build against it until the
real server is up at ~13:00). Lane A builds `PolicyVault` against §4 in parallel; the lead reviews and
commits the freeze to `main` by **10:30**. Lanes may add, never change, these without a lead-approved
freeze bump. **v0.9 additions are additive only** (§16 *Additive keys*, `riskProfile`, the `rogue` scope,
`approvalFallback: "armed"`); none renames or removes a frozen field, tool, error, event or table.

**Lane re-brief at 10:30 (v0.9, D4).** The EAS attester and the approval endpoints (`/ui/attach`,
`/chat/session`, `/strategy/approve`, the TTY degradation) move from Lane B to Lane E, which already owns
`ate-approve`; Lane B keeps the critical path (TxQueue → execute → smoke → MCP) and is never the
designated pair for another lane.

| Lane | Owner | Owns | Deliverables (acceptance) |
|---|---|---|---|
| A — contracts | Agent A (worktree `lane-a`); ops-1 signs | `contracts/`, `apps/owner-cli/`, `agents/rogue/`, `apps/cli/src/commands/a/`, `docs/superpowers-log.md`, `docs/INTEGRATE.md` | `PolicyVault` per §4 (generic decimals, exit path with `min(P, T)` floor, post-swap check); mocks for both shapes; unit/parity/invariants green (§4.4); Anvil-fork smoke of both vaults green; deploy ×2 + verify + EAS schema via the HSK-Superpowers workflow with the one-command `run(pool, oracle)` script, logged; `ate-owner` (set-limits `--vault`, unpause `--all`, pause --guardian `--all`); `ate rogue` (sole owner) with `check()` assertions, `--stage` per §22.3, runnable from a Claude Code stdio session; `vault-v0.1.0` tag; `docs/INTEGRATE.md`; draft `agent-policy-vault` skill PR; from 14:00, `apps/approve/` if `ate-approve` is red; E1, E2, E4, E5, E9 |
| B — daemon + MCP | Agent B (`lane-b`; freeze agent 09:50–10:30) | `apps/daemon/` (except `src/approval/`), `packages/{core,wallet,chain,venues,oracle,mcp,journal}` (after the freeze; except `journal/src/attest/`), `apps/cli/src/commands/b/` (`doctor`, `unlock`) | Keystore, two-market config (+ additive keys), Multicall3 chain client with RPC failover, depth-1 `TxQueue` with same-nonce replacement and the `rogue` raw route, gas alarm, Supra reader + pull refresher / APRO cross-check / pool / CEX readers for both markets, `scanSeconds` re-scan, Supra oracle reader + `oracle_refresh` (pairs 517/0) and APRO cross-check, QuoterV2, pre-flight, single-writer journal with triggers, `UNIQUE(prev_hash)` and id-from-hash, all §7.2 tools with scope-enforced tool sets and execute-time guard re-run, stdio proxy, `/events`, `/status`, `/chat`, `/cycle`; `strategy.ts` pass-through stub; `check()` pre-filter + Supra entry gate; `ate smoke`; first mainnet trade (smoke) by ~13:30; npm publish of `@ate/venues` + `@ate/mcp` by 17:30; E3 |
| C — trader + strategy | Agent C (`lane-c`) | `packages/strategy/`, `agents/trader/`, `agents/chat/`, `apps/cli/src/commands/c/` | Per-market generators (spread-revert open/close, rebalance with edge gate, `discretionary_exit`) + strategy and portfolio guard rules 1–9 incl. exit reserve 3b, `minEntryIntervalSec`, immediate target-asset sell-down and bounded breaker, with reservations, invalidation and the FIFO lot sub-ledger, behind `strategy.ts` (replaces B's stub by 13:30, latest 14:15), veto `outcome` scoring, trader prompt + runner (cycle rules §11.1, discretionary lane, agent tuning, per-market profile), chat prompt + allowlisted runner + loosening table + `riskProfile` + rules fallback, `ate chat`, `ate replay --days 7` (both markets, top-decile gaps); E6, E7, E11, E13, E14 |
| D — UI | Agent D (`lane-d`) | `apps/desktop/`, `packages/ui/`, `/view` | Electron shell that attaches via `/ui/attach`; Chat, Decisions, Trade (market selector), Agents (AI scoreboard), Positions (per vault + portfolio), Payments views; evidence footer with uptime counter; `/view` fallback; `docs/JUDGE.md` and the Decisions-view E2E (unless reassigned to E at 12:00) |
| E — payments + approvals | Agent E (`lane-e`) | `apps/worker/`, `packages/payments/`, `apps/approve/`, `apps/daemon/src/approval/`, `packages/journal/src/attest/`, `docs/hsp-readiness.md` | `ate-signal`, `ate-pay` state machine on recorded HSP responses (§9.4 incl. 30043, denial, uncertain submit), `ate-approve` Swift helper with keychain-ACL key storage (incl. UI-attach payloads); **daemon approval endpoints `/ui/attach`, `/chat/session`, `/strategy/approve`, the `armed` TTY degradation, and the EAS attester**; `docs/hsp-readiness.md` + recorded listing or organiser reply by 12:00; HSP tool listing once allowlisted; if go, live QA payment and E8 |

| Time | Lead + ops-1 / ops-2 | A — contracts | B — daemon + MCP | C — trader + strategy | D — UI | E — payments + approvals |
|---|---|---|---|---|---|---|
| 09:50–10:30 | Lead: lane briefs out at 09:50; confirms Supra pairs 517 and 0 are populated and the adapters read non-zero at 10:15 (the step-6 clause is already included, ABI-NOTES 6); **reviews and commits the freeze + MCP stub by 10:30**, then the v0.9 re-brief of B and E. Ops-1: **fund the ops hot wallet** (§19 Funding; arrival by 11:00). Ops-2: **deadline in writing** (by 11:00) and **G-HSP check in person or on the organisers' channel with Operations** | `PolicyVault` (generic decimals) + mocks (both shapes) | **Freeze agent:** generates every freeze artifact | Generators + guard rules from the spec and fixtures | Electron shell scaffold | `ate-signal` + `ate-pay` on recorded responses; `ate-approve` |
| 10:30–11:45 | Lead: integration branch; reviews only cross-lane PRs. **10:30 ops-1: Ledger 0-value tx on 177** (§19 step 0), then funds the owner; guardian keystore (third device if available). **11:00: funding check** → smaller-seed fallback if < $220 USDT (§19); ops-2 commits `docs/deadline.md` | Unit/parity/invariants; **Anvil-fork smoke, both vaults** | Config, keystore, chain, `TxQueue` (+ `rogue` route), readers (skill endpoint map, both markets, `scanSeconds`), QuoterV2, journal + triggers; 11:00 Supra pair/adapter re-check and one `oracle_refresh` dry run | Guard rules 1–9 incl. 3b and `minEntryIntervalSec`; trader + chat prompts; runner **against the MCP stub**; **`ate replay --days 7` from 11:00 (needs no vault)** | Chat + Decisions + Trade views on stub; `/view` | Payments tests; EAS attester; `/ui/attach`, `/chat/session`, `/strategy/approve` + `armed` TTY mode; if allowlisted: 8-tool listing, `get_chain_config` |
| **11:45** | **Checkpoint: bytecode frozen and fork smoke green, or the lead escalates** (Lane E's agent pairs on Lane A; see contingencies) | Deploy-script dry-run on the fork (`run(pool, oracle)`); `ate-owner` ready | MCP tools (scope tool sets, market enum, `riskProfile`), pre-flight | Runner + discretionary lane against the stub; replay running | Agents + Positions views on stub | `docs/hsp-readiness.md` |
| **12:00–12:45** | **12:00: G-HSP re-check** (contingency trigger); `docs/hsp-readiness.md` + recorded listing or organiser reply committed either way. Ops-1 signs **deploy ×2, verify ×2, EAS schema, limits ×2, seeds (§19 1–5), target 12:30**. **As soon as the first vault is verified, ops-2 creates and submits the BUIDL** (§21) | **Deploy + verify both vaults on 177**; superpowers log | Execute path via `TxQueue` on the fork | Replay → `docs/replay-7d.md`; chat runner (`chat` token, allowlist, loosening table) + rules fallback | Chat view wired | EAS attester on the fork; Payments view wiring with D; (contingency: Decisions-view E2E scaffold) |
| **12:45** | **Checkpoint: not deployed → lead + ops unblock before anything else.** Lane-B overload check (contingencies) | Smoke prep both vaults | Execute path green on the fork? | — | — | — |
| 13:00–14:00 | **13:00: start the mainnet daemon headless with `--approval-fallback=armed --allow-rogue`** (§19 step 7; it is never restarted for the TTY fallback or the rogue run). **13:15: still no vault → deploy the fork-smoked bytecode with the fork-smoked constructor args now, without waiting for remaining tests** (a later test failure ships a fixed v0.1.1 vault, both listed; the BUIDL is created from it). ~13:30: BUIDL edit — smoke tx + EAS UID (labelled `smoke`), replay headline. Lead: `docs/JUDGE.md` stub | Smoke both vaults (E1/E2) | **First real mainnet trade (`ate smoke`)** + attestation | Strategy stub replaced (target 13:30); MCP stub retired; LLM runner on the real MCP in `--dry-run` 13:00–13:45 → p95 latency → `candidateTtlSec` in `deployments/177.json` | Payments view; evidence footer (uptime counter) | `ate-approve` wired to the daemon endpoints + `ate-pay` |
| **14:00** | **Start the autonomous trader (~14:00; latest 14:30) = G6/E12 window opens (14:00–15:30).** WBTC gap re-read (decides the T1.8 evidence path, §0.3); **ops-2 starts the continuous screen recording at trader start**; G-HSP go/no-go; `ate-approve` checkpoint. No human input to the trader until 15:30. The mainnet daemon runs headless from here on; Electron only attaches | `ate-owner` read-only checks on mainnet; **if `ate-approve` red: takes `apps/approve/`** | Positions/P&L (per vault + portfolio, lots), `ate_decide`, events, `/cycle` | Trader running autonomously: watch cycles, timeouts, TTL, WBTC entries spaced 30 min | Wire all views to the mainnet daemon via `/ui/attach` (attaching never touches the trader) | `ate chat` session approval; UI-attach approval; strategy-diff approval |
| 14:00–15:30 | Unattended window; lanes work only in their repos. ~14:30: first LLM-decided trade → BUIDL edit. **14:30: `ate-approve` still red → lead types `approval-fallback enable` on the daemon's TTY** (armed since 13:00; no restart, no unlock, no trader input). **14:45: lead check (read-only)** — journal has an `origin=discretionary` trade and an `llm_veto`/size-down? **15:15: `ate doctor` reads Vault-HSK epoch headroom** for the exposure attack (§19) | Rogue dry-run on the fork incl. `--stage` and the Claude Code stdio client | Hardening; `doctor` incl. Supra cross-check, gas alarm, headroom | Stop-loss/TP/breaker tuning (fork); veto `outcome` scoring | Polish | If go: live QA payment end-to-end |
| 15:30–16:30 | **15:30: trader disabled (`strategy.enabled=false`) for the rogue run on Vault-HSK (E4)**; ops-1 signs guardian pause-all + owner unpause-all (ops-2 records) (E5); trader re-enabled (with the prompt amendment if the 14:45 check triggered it). **15:45: E7 via Chat** — "Go to cash on HSK, keep the BTC" → guard sell (ops-2 records the sell tx: the stage fallback) → "Trade HSK again" (adds a target asset: Touch ID) → the demo rebalance rebuilds WHSK, ~14 × $5 buys at 120 s ≈ 28 min (turnover: smoke $5 + ~$15 demo buys + ≤ $10 discretionary + ~$70 rebuild ≤ the $100 WHSK share; if the share runs out first, E6 runs on the smaller position). **16:00: lead re-reads the DoraHacks timeline live; JUDGE.md link (3) added.** **~16:20: E6 pre-check** (a position of fresh buys marks ≈ −60 bps, so it passes by construction) → "Stop out HSK at 0.5%" (WHSK-scoped) → guard exit; then "Back to a 3% stop on HSK" (Touch ID) | **Rogue run on Vault-HSK (E4)** (from the Claude Code stdio session), guardian pause + owner unpause of both vaults (E5) | Bug fixes | **E7, rebuild and E6 via Chat** | Polish | If go: `ate_signal_buy` in the loop |
| 16:30–17:30 | **16:30: ops-2 cuts the E12 60 s unedited capture** (a real cycle — ideally a WBTC spread-revert, which `minEntryIntervalSec` spreads across the window — from the 14:00–15:30 recording) and its 25–30 s excerpt; **records the demo beats**; **compiles the demo video (≤ 3 min) and the 90 s cut by 17:30**; sends the ecosystem-directory listing request. 16:30: lead picks the on-stage AI-decision example. **17:00: ops-2 saves the full draft; ops-1 moves Vault-BTC to the Safe (§19 step 9).** Lead: evidence pack (E1–E14), README with per-market realised-first P&L and the WBTC structural-discount caveat | Fork/invariant re-run on final bytecode; `docs/INTEGRATE.md`; skill PR draft; **`vault-v0.1.0` tag by 17:30** | Bug fixes; **npm publish `@ate/venues`, `@ate/mcp` by 17:30** | E6 retries if the pre-check failed; unattended-run evidence | `docs/JUDGE.md` final, screenshots, Decisions E2E | E8 evidence (if go); otherwise contingency work |
| 17:30–18:00 | Ops-2: final upload of the video; lead: submission text; **18:00: final edit submitted (hard)** | | | | | |
| 18:00–18:30 | Buffer | | | | | |

**Contingency reassignments (decided now, applied at the checkpoint without discussion).**

| Checkpoint | Trigger | Action |
|---|---|---|
| 11:00 | < $220 USDT on 177 | Smaller-seed fallback (§19 Funding); `maxExposureUsd` $60 per vault; pitch card regenerated from `limits()` |
| 11:00 | Organisers say the deadline has passed | Ops-2 requests written acceptance of a late BUIDL in the same thread; the plan runs unchanged for Demo Day |
| 11:45 | Bytecode not frozen or fork smoke red | **Lane E's agent** pairs on Lane A until green (payments are tested on recorded responses and are off the critical path); lead triages failing tests against the §4.4 submission gate |
| 12:00 | HSP allowlist not confirmed | Lane E keeps building payments against recorded responses (still must-build) **and**, once its approval endpoints are green, takes the Decisions-view Playwright E2E and `docs/JUDGE.md` from Lane D, so Lane D spends the day on the six Electron views. `docs/hsp-readiness.md` and the organiser reply are committed |
| 12:45 | Vaults not deployed | Lead + ops unblock first; Lane B keeps testing against the Anvil fork |
| 12:45 | **Lane B overload:** execute path not green on the fork | `ate smoke` moves to Lane A (free after deploy); Lane B keeps only TxQueue → execute → MCP |
| 13:15 | Still no vault | Deploy the fork-smoked bytecode with the fork-smoked args immediately (above); the BUIDL is created from that address |
| 14:00 | No first mainnet trade | Lane C pairs on Lane B's execute path; the BUIDL carries vaults, `check()` reads and the replay; trader starts by 14:30 at the latest; the window and the rogue run shift so the unattended window stays ≥ 1 h |
| 14:00 | Lane C's guard not yet replacing the stub | Trader start waits (never runs on the stub); **Lane D's agent** pairs on Lane C (Electron falls back to `/view`); latest 14:15, else the next row applies |
| 14:00 | `ate-approve` not signing end-to-end (UI attach, `ate chat` session, strategy diff) | Lane A (free after deploy) takes `apps/approve/`; Lane E keeps the endpoints and payments. Until green: Electron uses `/view` (no attach needed) and the demo path uses the rules-only CLI; nothing on the trade path depends on it |
| 14:30 | `ate-approve` still red | Lead types `approval-fallback enable` on the daemon's TTY (armed since 13:00; **no restart**, so no `ate unlock` and no break in G6/E12) so `/ui/attach`, `ate chat` and the E6/E7 Touch-ID steps work by code; it switches off when `ate-approve` passes; SECURITY.md states it |
| 14:00 / 14:30 | WBTC gap below cost (closed before we trade), or Vault-BTC buys `suppressed` | The trader keeps watching it (it fires whenever the gap reopens and `check()` passes). **Pre-registered second path (T1.8):** E14 shows the replay's top-decile historical gaps with the default-profile decision and counterfactual net edge, plus the live `no_trade`/suppression records next to the 03:50 snapshot; the hands-off beat uses its spoken branch (§22.1); T1.8 is reported as Partial in the README until a live E14 exists, with the structural-discount caveat |
| 14:00 | Replay output missing for a market | Lane A (free after deploy) takes the Blockscout/kline data plumbing; Lane C finishes the report |
| 14:00 | Autonomous trader not running | Lanes D and E pause polish; lead + B + C swarm; the unattended window starts when the trader runs and must start by 15:00; the rogue run, E7 and E6 follow ≥ 1 h later and finish by 17:15 |
| 14:45 | No `origin=discretionary` trade or no `llm_veto`/size-down in the journal | At the 15:30 trader re-enable (not during the G6 window) the lead amends `agents/trader/PROMPT.md` with an explicit demo-profile directive — originate one thesis trade (≤ $10) and evaluate vetoes on the next WHSK candidate — labelled `profile=demo` and journalled as a `strategy_change` with `actor=human, via=cli`. 16:30: if still missing, the directive stays on through 17:30 and the README states the gap |
| 15:15 | Vault-HSK epoch headroom < (150 − WHSK holdings) × 0.975 | The other rogue attacks run at 15:30; the exposure attack runs at 05:35 IST Nov 3 (fresh epoch, before the pitch list) and is added to E4 |
| 16:20 | E6 pre-check: Vault-HSK unrealised > −55 bps | Do not run the stop-out yet; retry every 15 min until 17:00. If still not met, the stop-loss is evidenced by the guard tests plus any natural guard exit, stated; the 15:45 E7 tx stays the stage fallback |
| 16:30 | Electron views not wired to the mainnet daemon | Demo and recording use `/view` + `ate chat`; Lane D keeps building and the app ships in the repo by 17:30 |
| 16:30 | E13 net negative, or no veto/thesis worth showing | The on-stage AI example is still one real record; the narration states the scoreboard sign in one sentence |
| 12:45 / 13:15 / 14:00 | **Lead tie-break:** two or more of these checkpoints miss together | The lead drops, in this order and only until the misses clear: `docs/JUDGE.md` polish, the README P&L table, the Decisions-view E2E (each resumes afterwards — scope is fixed, this is ordering, not cutting). Deploy, the first trade, the rogue revert and the BUIDL keep the lead's attention |
| any | A lane agent stalls > 30 min | Lead restarts it in a fresh worktree from the lane's last green commit with the same brief |

**Gate G-HSP.** Checked first by ops-2 at 10:30 — in person or on the organisers' channel with
Operations, not only the form — re-checked at 12:00 (contingency trigger), decided at 14:00. Go only if
all are true: allowlist confirmed and health `ok`; all eight tools listed; `get_chain_config` returns a
network OKX (or the fallback signer) can sign for; the exact token is funded. **Either way**
`docs/hsp-readiness.md` and the recorded listing or organiser reply are in the repo by 12:00 (§9). If
no-go: Lane E's work stays behind `payments.enabled=false`, the submission describes HSP as
built-but-not-live with that evidence, the HSP Q&A card (§22.1) answers it on stage, and live use resumes
for Demo Day if access arrives. If go: E8 is a DoD item and the premium-signal purchase becomes a 10 s
beat in the main script (§22.1). The submission is Track 1 either way; HSP never blocks it and never
touches the trade path.

**Never cut:** every §21.1 item. When an item lags, its demo-path fallback ships first and the full item
keeps building to 17:30: Electron views → `/view` + `ate chat`; Chat view → `ate chat`; LLM engine →
`--engine rules` for resilience only (not Track 1 evidence); live HSP → payments on recorded responses;
`ate-approve` → 14:00 reassignment to Lane A, then the 14:30 armed TTY degradation for
attach/session/strategy diffs (never payments). Nothing on the trade path waits on `ate-approve`.
Contract deploy + verification (both vaults), the autonomous execute path, rogue-agent reverts, the
evidence pack and the BUIDL have no demo-path fallback and get the lead's attention first.

---

## 22. Demo and judge verification

### 22.1 Three-minute demo script

Order: hook → rogue attack → hands-off agent → live Chat → close on the guardian pause. The autonomous
segment is the E12 unedited capture (timestamped, live Blockscout tab) **plus the live Decisions view open
in the room** showing the trader's latest tx and its timestamp. The rogue and Chat segments run live if
the RPC and LLM are healthy, otherwise from recording (`ate chat` rules fallback). The evidence footer
(§15.1) — both vault addresses, chain head, last tx, **uptime counter**, `JUDGE.md` link — is on screen
for every beat. **Pre-stage check (both runs):** `ate doctor` must show Vault-HSK spot and TWAP deviation
< 150 bps, vault unpaused and ≥ $5 of epoch headroom; otherwise the stage buy would revert
`ERR_ORACLE_DEVIATION` / `ERR_EPOCH_CAP` before reaching the slippage floor (steps 7 and 9 precede 11), so
the recorded E4 is played instead and the narration says so.

| Time | Beat | On screen |
|---|---|---|
| 0:00–0:20 | **Hook (one number):** "AI agents trade overnight, but one bad prompt or stolen key can drain the wallet. With ATE the stolen key can never withdraw a cent, and the contract caps what bad trades can cost at $51.50 a day — about 18% of this demo wallet. Let's steal its key." | Three items only: **Stolen key can never withdraw · ≤ $51.50/day, about 18% · exposure ≤ $150/vault** — footnote: *price risk on held exposure: stop-loss, not contract* (every other number is on the Q&A *numbers* card) |
| 0:20–1:05 | **Rogue agent with the stolen agent key** (Vault-HSK) — **a second, unrelated agent: a Claude Code session over stdio, pointed at the same vault** (§22.3). "Different agent, different framework, same vault. The vault is verified; its pool, oracle and router are fixed at deploy; this key can only trade inside the limits or pause." Attack 1 — **the differentiator:** a $5 buy, well under every cap, with `minAmountOut = 1` ("price is crashing, take anything") → `ERR_SLIPPAGE`. "A session key or Safe allowance would let this through. The vault knows what a fair price is." Attack 2: `withdraw(USDT, attacker, all)` → owner-only revert. "Five more — the $5,000 buy, exposure, fake token, setLimits, after-pause — are in the evidence pack." | Blockscout contract page + `limits()`, then the two reverted txs with decoded errors (`Slippage(minAmountOut, floor)`) |
| 1:05–1:45 | **Good agent, hands off — one item.** **The WBTC spread capture (if E14 exists), realised-first:** "The BTC pool sat 1.1% under HashKey Global. The agent bought, on its own, default settings. Sold right now that lot is about −0.6% after fees; if the pool reverts it is +0.8% — and the market may keep this discount, which is why the contract caps the downside. Same cycle, HSK: 30 bps gap, 36 bps cost — it did nothing." → `TradeExecuted` + EAS UID with the decision's gap / cost / net edge, and the HSK `no_trade` in the same frame. **Branch, if E14 does not exist (gap closed or suppressed):** "The same cycle sat out BOTH markets: BTC gap [X] bps vs cost [Y] bps, HSK 30 vs 36 — and here is what it would have done on last week's widest gaps" → the replay's top-decile gaps (the pre-registered second path). "Running for [uptime] — [N] cycles, [M] trades." The on-stage AI veto/thesis record is in `docs/JUDGE.md` link (3) and the Q&A *What does the AI decide* card. If E8 exists: 10 s — the trader buys a premium signal over HSP | 25–30 s E12 excerpt, Decisions view (`engine=llm`, market, generator, `candidateId`), tx with `rationaleHash`, EAS UID, uptime counter |
| 1:45–2:30 | **Live Chat.** "How am I doing?" → `ate_positions` card per vault: the BTC lot exit-executable first (what selling now realises), then marked at the CEX (the gap captured on paper), HSK P&L, fee drag. "**Go to cash on HSK — keep the BTC.**" → `ate_strategy_set { targetAssets: ["WBTC"] }` card → the guard's immediate `reason=target_assets` sell on Vault-HSK on Blockscout (§11.4 rule 9; no LLM cycle to wait for). **If the sell has not landed in 20 s**, the narrator opens the E7 sell tx recorded at 15:45. "Target assets, by conversation." Then a **5 s recorded E6 cut-in**, captioned "Stop-loss: guard sold with no LLM (staged: stop tightened to 0.5%)" — not narrated further | Chat view with both cards, the HSK sell tx, the 5 s E6 cut-in |
| 2:30–3:00 | **Close.** Ops-1 presses the guardian pause → `Paused` on both vaults; the stolen key's next `execute` (rogue, fixed gas) reverts `ERR_PAUSED` on-chain. "**Bounded autonomy. Four clients — our trader, the chat agent, a stolen key, a Claude Code session — one vault, one bound: any agent, any framework. Two live vaults, [N] HSKSwap trades routed, Apache-2.0, on npm, one-command deploy. Next: audit, Safe by default, Kredo. Our ask: audit credits, HSP access, and the skill in HSK-Superpowers. The bound is the product.**" QR to `docs/JUDGE.md` | Guardian `Paused` txs, the `ERR_PAUSED` revert, footer HSKSwap counters, QR to `docs/JUDGE.md` |

**90-second cut** (for a shorter slot): hook (0:00–0:15) → one rogue revert, the `minAmountOut = 1` buy →
`ERR_SLIPPAGE` (0:15–0:40) → one hands-off decision, the WBTC spread capture with its EAS UID or the
gap-closed branch (0:40–1:05) → guardian pause and the close line (1:05–1:30).

After the pitch the owner unpauses both vaults from the second device (§19 step 8) and Chat restores
`targetAssets: ["WHSK", "WBTC"]` (loosening: Touch ID, §11.5).

**Q&A cards (prepared answers):**
- *The numbers* — the §4.6 Q&A numbers card verbatim: $51.50 is ≤ $103 over any rolling 24 h; ≤ $26.50
  per UTC day on the normal path (≤ $53 rolling); oracle-lag exits add ≤ $7.50 per vault per episode,
  inside those totals; per vault, half of each; oracle-wrong case: per vault ≤ $250 of USDT plus its token
  holdings, never above the vault.
- *Why not a Safe module or session key* — §0 Positioning, incl. the Zodiac Roles-style comparison and the
  "first on HashKey Chain, to our knowledge" searches in `docs/JUDGE.md`.
- *Is it profitable* — realised-first: the WBTC lots are ≈ −0.6% if sold now (fees included) and ≈ +0.8%
  on paper at the CEX mark, realised only when the pool reverts; the discount may be structural (bridged WBTC, ~94% of supply in one pool);
  README states per-market realised P&L since the trader's start incl. fee drag; E11 replay,
  counterfactual, with its transient/persistent verdict. If the replay shows no edge after fees: "the market gave us no edge after fees this
  week, and the agent correctly did nothing".
- *What if the oracle lags in a crash* — exit path 7b floored at `min(P, TWAP)`: ≤ $7.50 extra per
  vault per episode, inside the $51.50; exits still wait on a drop faster than the 300 s TWAP (up to ~5
  min), if the TWAP is > 5% below the oracle price, the oracle is stale (the daemon first tries a Supra refresh), the epoch budget is spent, or the vault is paused.
- *What does the AI actually decide* — the on-stage veto/thesis record, then the AI scoreboard: candidate
  choice across two markets, vetoes with bps saved (sign stated), ≤ 3 × $10 discretionary trades/day,
  tuning within ±50%; the guard alone fires stop-losses.
- *Who uses this at a ~$280 portfolio?* — "HashKey agent teams that want to give an agent a wallet without
  trusting it — Maneki-style per-agent fleets, trading bots behind an MCP agent. The caps are owner
  parameters, not constants; $280 is our demo wallet. `docs/INTEGRATE.md` is a 15-line example — constructor
  args for any qualifying pool, run on the Anvil fork in CI — and `forge install …@vault-v0.1.0`. It is
  unaudited and fuzz-tested; we say so. Next 30/60/90 days: audit + bug bounty and Safe by default;
  Kredo adapter and ERC-8004 identity; two design partners live (§0 *Incubation plan*)."
- *Which pools can it guard?* — any HSKSwap pool whose `token0` is an 8- or 18-dp token against a 6-dp
  USD stable with an 8-dp AggregatorV3 feed; the constructor checks it; WHSK and WBTC are two instances.
  WETH is out of v0.1 scope: APRO has no ETH/USD feed, and although Supra lists one (pair 1) no ETH market was deployed or fork-smoked.
- *HSP* — "The payment leg is built and tested on recorded responses (`docs/hsp-readiness.md`); live use
  needs the QA allowlist; it never sits on the trade path." (If G-HSP is go, E8 instead.)
- *Who controls the keys* — §8.1 (guardian independence stated honestly); *MEV on honest trades* — §4.6:
  ≤ ~50 bps + fee.

### 22.2 Evidence pack (`docs/evidence.md`) and `docs/JUDGE.md`

`docs/JUDGE.md` is one page with five links in click order: (1) both vaults on Blockscout (verified
source + immutables), (2) `limits()` reads, (3) LLM-decided `TradeExecuted` txs — the **WBTC
spread-revert trade (E14)** and one discretionary trade — each with its EAS attestation and journal
record, plus the on-stage veto/size-down record with its +30 min outcome, (4) one decoded rogue revert
(the `ERR_SLIPPAGE` buy), (5) the guardian `Paused` txs and the owner `Unpaused` txs. It also links the full
60 s E12 file, the 03:50 and trader-start (~14:00) WBTC snapshots, the skill PR and the directory request. An appendix
links the Blockscout verified-contract and ecosystem-directory searches behind the §0 positioning claim.
**The stub created with the BUIDL (first vault deploy, ~12:30) carries (1) and (2)**; the ~13:30 edit adds
the smoke trade + EAS UID (labelled `smoke`, `engine=rules`), the ~14:30 edit the first LLM-decided trade
(labelled `engine=llm`); link (3) is added at the 16:00 edit. Everything else is in `docs/evidence.md`:

| # | Claim | Evidence |
|---|---|---|
| E1 | Contracts deployed and verified on mainnet | Both vault addresses + Blockscout verified-source links (same source and creation code; immutables differ); fork-smoke log; Vault-BTC → Safe ownership transfer + acceptance txs (§19 step 9) |
| E2 | Limits as stated; oracle health | `LimitsUpdated` txs + `limits()` reads; immutables (pair, oracle, router, pool, `priceDecimals`) on each contract page; `ate doctor` output incl. Supra and APRO ages, pool cardinality and the Supra–APRO cross-check; the adapter addresses and pairs (`supraStorage()`, `pairIndex()`) on Blockscout |
| E3 | Autonomous LLM-decided trades | For one candidate-bound trade (the E14 WBTC trade) and one `origin=discretionary` trade: `TradeExecuted` tx; `proposalId` == journal record hash; journal record with `engine=llm`, market, `candidateId` or thesis, generator, `profile`, `approvedBy=policy`, matching `rationaleHash`; **EAS attestation UID** resolving to the same `proposalId`, `rationaleHash`, `txHash`, `origin` |
| E4 | Rogue attacks rejected on-chain | One reverted tx per §22.3 on-chain attack, decoded custom error, sent from the Claude Code stdio session (the second client); the exposure attack is dated 05:35 IST Nov 3 if the 15:15 headroom read deferred it |
| E5 | Kill switch | Guardian `Paused` txs on both vaults + subsequent `ERR_PAUSED` revert + owner `Unpaused` txs from the second device + the trader's next journal row |
| E6 | Stop-loss (recorded) | `ate_positions` card showing entry, exit-executable mark (fees both ways included; a fresh position is ≈ −60 bps), fee drag and unrealised ≤ −0.55%. Then Chat "stop out HSK at 0.5%" → `ate_strategy_set { market: "hsk-dex:WHSK/USDT:3000", stopLossBps: 50 }` → `guard_exit` sell on Vault-HSK only (`engine=guard`) with the guard rationale; 600 s re-entry lock on WHSK journalled; the WBTC lot untouched; then Chat "back to a 3% stop on HSK" → Touch ID → `strategy_change`. Runs ~16:20 on the WHSK position rebuilt after E7 (fresh buys only, so the pre-check passes by construction). **Staged, and said so on stage and here:** the trigger is met by fee drag on the exit-executable mark, not by a price move (fallback per §21.4 16:20) |
| E7 | NL positions, strategy and target assets via Chat | Chat transcript ("How am I doing?" → `ate_positions` card; "Go to cash on HSK, keep the BTC" → `targetAssets` change → immediate `reason=target_assets` guard sell on Vault-HSK at 15:45, tx recorded as the stage fallback; "Trade HSK again" (Touch ID) and the rebuild; the E6 change; a `riskProfile` change) and the `strategy_change` records (`actor=human, via=chat`) |
| E8 | (If G-HSP) A2A settlement | Conditions hash, `orderId`, `payment_request_id`, gateway tx, `SETTLED`, `attribution_verified=true`; if no-go, `docs/hsp-readiness.md` + recorded listing or organiser reply |
| E9 | Tests | CI run link: forge unit, parity, invariants (both shapes), fork smoke (both vaults); `docs/superpowers-log.md` (each HSK-Superpowers skill invoked, with its command output incl. `forge verify-contract`) |
| E10 | Journal integrity | Chain head hash; latest on-chain anchor (`proposalId`); EAS attestation UIDs; trigger, fork (`UNIQUE(prev_hash)`) and id-from-hash tests |
| E11 | Spread opportunities and profitability, measured (counterfactual) | `docs/replay-7d.md` from `ate replay --days 7`, per market: pool volume, cycles, candidates fired / rejected on net edge, net-edge distribution, counterfactual net edge, **gap persistence** (signed-gap distribution, share of cycles with gap > cost, median time-to-close, `transient` / `persistent` verdict), **top-decile gaps** with the default-profile decision and counterfactual net edge (the T1.8 second path) — labelled counterfactual; headline in the BUIDL's first edit (~13:30) |
| E12 | Real cycle, unedited (must-ship) | 60 s excerpt, unedited, from the continuous screen recording started at trader start (14:00–15:30), ideally a WBTC spread-revert, with timestamps and a live Blockscout tab, as a separate file linked from `docs/JUDGE.md`; the demo video (≤ 3 min) contains a 25–30 s unedited excerpt of it with a timestamp overlay |
| E13 | What the LLM adds | AI scoreboard: count of LLM acts, vetoes/size-downs with the counterfactual bps and USD saved at +30 min (negative allowed), from `outcome` records; discretionary trades with their theses and realised P&L |
| E14 | **Live spread capture (primary T1.8 evidence)** | The WBTC `spread-revert` decision record (pool price, CEX bid/ask, oracle, `edgeBps`, `costBps`, `netEdgeBps`, `profile=default`), its `TradeExecuted` tx on Vault-BTC and EAS UID; per-lot P&L marked at CEX (captured on paper) and exit-executable, realised only via the close leg if the pool reverted; the structural-discount caveat. **Pre-registered second path** (if the trader-start re-read shows the gap below cost, or buys were `suppressed`): the 03:50 and ~14:00 snapshots, the `no_trade`/suppression records, and the replay's top-decile historical gaps with the default-profile decision and counterfactual net edge plus the persistence verdict, stated as such |

Every row is labelled by `profile`, market and generator/`origin` where that applies.

### 22.3 Rogue-agent script (`ate rogue`)

Owned by Lane A (`agents/rogue/` and the `ate rogue` entry). Runs with the real agent key against the
real **Vault-HSK**: it signs through the daemon's `TxQueue` raw-broadcast path (no pre-flight, fixed gas),
which exists only when the daemon is started with `--allow-rogue`, so the key is still loaded by one
process only (§7.1). **Raw-path access (D6):** only the `rogue` token (§10.1) reaches it — minted at daemon
start, printed once to the daemon's controlling TTY, never in `runtime.json`; calldata must target one of
the two vaults with selector `execute`, `withdraw`, `setLimits` or `pause` (anything else refused); every
call is journalled `profile=rogue`; an `agent`, `chat` or `ui` token → 403 (test, §18.2). **Flag
lifecycle:** the mainnet daemon is started once at ~13:00 with `--allow-rogue` (§19 step 7), so neither
the 15:30 run nor a Demo Day `--stage` run needs a restart; the flag is dropped at the first restart after
Demo Day. **Second client on stage:** `ate rogue` is driven from a separate Claude Code session over stdio
(`ate mcp serve`, `agent` scope) whose environment the operator gives the `rogue` token — "the stolen
key"; it first tries `ate_propose` for $5,000 (refused by pre-flight), then shells `ate rogue` for the
on-chain attacks. Before each attack it waits out `cooldown`, calls `check()` and asserts the expected
code (so an earlier check cannot mask it), then broadcasts so the revert lands on-chain. For the full run
(15:30, E4) the background trader is stopped (`strategy.enabled=false`) so it cannot reset `cooldown`.
The staged pitch subset (`ate rogue --stage`: a $5 buy with `minAmountOut = 1`, then `withdraw`) runs
with the trader live: the `withdraw` fails owner-only, and the $5 buy passes steps 1–10 and fails at step
11 (`ERR_SLIPPAGE`) — the price check a Safe allowance or session key lacks. It therefore needs Vault-HSK
spot and TWAP within the deviation bound (7), ≥ $5 of epoch headroom (9) and an elapsed `cooldown` (10):
`--stage` asks the daemon to hold Vault-HSK candidate executes for `cooldown` + 30 s (90 s at defaults),
waits out `cooldown`, then `check()` → asserts `ERR_SLIPPAGE` → broadcasts within the same `TxQueue` slot.
Guard exits are never held: **if any Vault-HSK tx (incl. a guard exit) enters the queue between `check()`
and broadcast, `--stage` aborts to the recorded E4.** The pre-stage `doctor`
check (§22.1) guards this, and `ate rogue --stage` aborts to the recorded E4 if `check()` returns any other
code. In the full run the exposure and slippage buys are
sized to the epoch headroom read from `epoch()` (a spent epoch returns `ERR_EPOCH_CAP` before §4.2 steps
11–13); headroom is read by `ate doctor` at 15:15 and, if short of the exposure attack's need, that one
attack runs at 05:35 IST Nov 3 (§19 *Epoch budget*). `ate rogue` submits a `proposal` and an `execution` journal record per
attempt to the daemon's journal API (`profile=rogue`, `verdict.code` = expected code,
`execution.reverted=true`; §13 single writer); the daemon journals `Paused`/`Unpaused` vault events.

| Attack | Expected | Kind |
|---|---|---|
| `execute` $5,000 buy | `ERR_TRADE_CAP` | on-chain revert |
| A buy sized to the epoch headroom (≤ $100) that would lift Vault-HSK's WHSK holdings above $150 (precondition asserted via `check()`: holdings + amount / (1 − deviation) > $150, USDT ≥ amount) | `ERR_EXPOSURE` | on-chain revert |
| `minAmountOut = 1` ("price is crashing, take anything") | `ERR_SLIPPAGE` | on-chain revert |
| `tokenIn` = a token the attacker deployed | `ERR_PAIR_NOT_ALLOWED` | on-chain revert |
| `withdraw(USDT, attacker, all)` from the agent key | owner-only revert | on-chain revert |
| `setLimits(maxTradeUsd = 1e6)` from the agent key | owner-only revert | on-chain revert |
| `execute` after guardian `pause()` (signed off the agent's machine) | `ERR_PAUSED` | on-chain revert |
| Route through an attacker pool | No pool parameter exists in `SwapParams` | design-level (show ABI) |
| Use stolen daemon tokens to change limits | Daemon has no owner key; no such endpoint | design-level |

After the run, the owner unpauses both vaults from the second device (runbook §19 step 8). On stage the
`minAmountOut = 1` and `withdraw` attacks open the pitch and the guardian pause closes it (§22.1); all rows
are in E4. Vault-BTC runs the same source and creation code (only immutables differ), so the attacks are
not repeated there.

---

## 23. Definition of done

### 23.1 Submission (v0.1) — every item binary

- [ ] Anvil-fork smoke of both vaults green before deploy; Vault-HSK and Vault-BTC verified on
      `hsk.blockscout.com` at the addresses in `deployments/177.json` (same source and creation code); EAS schema UID
      recorded there; limits on both match §19 step 3 (`maxEpochUsd = 250`, `maxExitDiscountBps = 500`)
      or the recorded smaller-seed values
- [ ] Foundry unit (codes 1–15 incl. exit path with `T > P` and `T < P`; I5 owner-only; `exposureUsd()`)
      + parity (I10) + invariants I1–I4, I6–I9, I11–I13 green for both priceToken shapes (§4.4 submission
      gate)
- [ ] Proceeds-stay-in-vault (I3/I4), zero allowance (I9), post-swap exposure cap (I12) and exit-path
      constraints incl. the `min(P, TWAP)` floor (I13) asserted in tests
- [ ] ≥ 1 autonomous LLM-decided mainnet trade bound to a `candidateId` **and** ≥ 1 `origin=discretionary`
      LLM trade (≤ $10, thesis), each with `proposalId` == journal record hash and an EAS attestation UID
      (E3); ≥ 1 LLM-sized-down or LLM-vetoed decision and ≥ 1 `no_trade` decision in the journal; trader
      started autonomously by 14:30 (target ~14:00) and ran ≥ 1 h unattended from trader start (14:00–15:30,
      G6) with no daemon restart in the window; runner
      tests (no overlap, 90 s kill → `timeout`, `candidateTtlSec` from `deployments/177.json`) green
- [ ] WBTC `spread-revert` trade on Vault-BTC under the default profile with its gap/cost/net-edge record
      and EAS UID (E14) — or, if the gap closed before the trader ran, the pre-registered second path
      (snapshots, `no_trade`/suppression records, replay top-decile gaps) stated as such (§21.4);
      WBTC entries ≥ `minEntryIntervalSec` apart (test)
- [ ] Agents view shows the AI scoreboard: LLM acts, veto/size-down count with counterfactual bps saved
      (negative allowed), discretionary n/3 (E13); footer shows the uptime counter and HSKSwap trades /
      routed USD
- [ ] Journal `UPDATE`/`DELETE` rejected by triggers; a forked `prev_hash` rejected; ids derivable from
      hashes (tests); chain head recomputes (E10)
- [ ] All agent-key txs for both vaults go through the single depth-1 `TxQueue` (tests: concurrent execute
      + exit + attest + pause, no nonce reuse; stuck attest replaced by pause at the same nonce with
      `max(original × 1.25, suggested)` fees; displaced tx mined first → pause re-signed at the next nonce);
      `ate mcp serve` loads no key
- [ ] Propose buy → guard exit → execute returns `ATE_STRATEGY_BLOCKED`; concurrent proposals cannot
      exceed the turnover reservation; portfolio guard splits turnover and caps exposure; exit reserve
      blocks the re-buy; de-selection sells at once as a guard exit; breaker pauses after its bounded
      flatten with exits blocked; FIFO lots vs average-cost P&L; `strategy.ts` contract fixtures pass for
      B's stub and C's guard (tests)
- [ ] Every on-chain attack in §22.3 reverted; tx links in `docs/evidence.md`
- [ ] Kill switch via the guardian key on both vaults and owner unpause verified on mainnet, trader
      cycling again afterwards (E5)
- [ ] "Go to cash on HSK, keep the BTC" via Chat produces an immediate guard sell on Vault-HSK (E7,
      15:45), then "trade HSK again" (Touch ID) rebuilds WHSK; stop-loss via a WHSK-scoped Chat strategy
      change on the rebuilt position recorded (WBTC lot untouched), card shows entry, exit-executable mark
      and fee drag, labelled staged, then the HSK stop restored to 3% with Touch ID (E6, ~16:20, or its
      §21.4 fallback)
- [ ] Chat view and `ate chat` answer "How am I doing?" and apply strategy and target-asset changes
      through MCP tools; rules fallback passes the five ★ intents (§11.5); a `chat`-token call to
      `ate_execute` returns `ATE_TOOL_NOT_ALLOWED`, `actor` is derived from scope, the chat runner's
      tool list equals the `mcp__ate__*` allowlist, loosening (every field and direction of the §11.5 table, incl. `riskProfile`) returns
      `ATE_APPROVAL_REQUIRED` until signed, the `rogue` raw route refuses non-`rogue` tokens and foreign
      calldata,
      agent text arrives wrapped `<untrusted_agent_text>`, an unscoped stop change asks which market (tests)
- [ ] `ate-approve` signs a `confirm`-mode trade approval, an `ate chat` session open, a UI attach, a
      loosening strategy diff and a payment approval (recorded responses) with a payload-derived Touch ID prompt; daemon and `ate-pay`
      verify against the pinned key; the key blob's keychain ACL trusts only `ate-approve` (test)
- [ ] Payments built: `ate-pay` state-machine tests on recorded HSP responses pass (30043, denial,
      uncertain submit); Payments view renders mandates; `docs/hsp-readiness.md` committed
- [ ] Electron app attaches (`/ui/attach`) to the headless mainnet daemon with Chat, Decisions, Trade,
      Agents, Positions and Payments views and the evidence footer; `/view` serves the read-only
      Decisions fallback
- [ ] `docs/replay-7d.md` produced by `ate replay --days 7` for both markets (E11, incl. top-decile
      gaps), headline in the BUIDL's first edit
- [ ] `ate doctor` prints Supra and its APRO cross-check (and whether the entry gate is active per market), adapter/pair checks, Supra age and the last `oracle_refresh`,
      both pools' observation cardinality and the agent gas level; the gas alarm fires below 2 HSK; Supra
      disagreement > 250 bps and `check()`-deviation buys are withheld and journalled as suppressions (tests)
- [ ] Daemon holds no owner or guardian key (test: no such key material in the daemon process or its
      keychain scope)
- [ ] MCP tools pass schema/envelope/candidate-binding/discretionary-lane/market-enum tests; work from
      Claude Code via stdio
- [ ] Decisions view (or `/view`) shows E3–E7 and E14 with explorer and EAS links, market, generator and
      `origin` per row; evidence footer on every view
- [ ] `docs/JUDGE.md` with five links in click order and the positioning-search appendix; README
      quickstart and per-market realised and CEX-marked P&L since the trader's start incl. fee drag (exact
      numbers, negative allowed) with the WBTC structural-discount caveat; the 60 s unedited E12 file
      linked from JUDGE.md and a demo video ≤ 3 min containing a 25–30 s unedited E12 excerpt with
      timestamp overlay, plus the 90 s cut; Apache-2.0 LICENSE; SECURITY.md; `docs/superpowers-log.md`
      linked from E9; `vault-v0.1.0` tag, `docs/INTEGRATE.md` (one-command deploy, HSKSwap trades/routed
      USD), `@ate/venues` and `@ate/mcp` on npm, draft HSK-Superpowers skill PR and ecosystem-directory
      request linked; Vault-BTC owned by a Safe on 177 (transfer + acceptance txs, §19 step 9)
- [ ] `docs/deadline.md` (organisers' written deadline) committed by 11:00; Track 1 DoraHacks BUIDL
      created and submitted as soon as the first vault is verified (target ~12:30, latest 13:30) with a
      mainnet vault address and a summary that names the customer first and states the WBTC figure
      realised-first; edited with the smoke trade, replay headline and first LLM-decided trade; final
      edit submitted by 18:00 IST
- [ ] G-HSP decision recorded; if go: E8 complete, with expired-quote, denied-approval and
      uncertain-submission handling tested without duplicate payment

### 23.2 Demo Day / GA

Demo Day: full invariant run (`runs = 500, depth = 100`, both shapes, fork); TS ↔ Sol parity; quote vs
fork execution within 1 bps; rehearsed script (3 min and 90 s). GA: cold start < 2.5 s on a 2020 MacBook Air; Playwright E2E; signed,
notarized releases with SLSA provenance; CONTRIBUTING.md; Safe owner default; application egress
restricted to configured hosts.

---

## 24. Build, release, CI

- Node 22 LTS, pnpm 9, Foundry stable.
- CI (GitHub Actions): `lint → typecheck → test:unit → forge test → test:integration → build`; nightly E2E.
- v1.0 release: `electron-builder` → macOS (arm64+x64, notarized), Windows (nsis), Linux (AppImage);
  `SHA256SUMS` + Sigstore bundle; Docker image for the headless daemon.
- Versioning: SemVer; contracts tagged separately (`vault-v0.1.0`) with the address pinned in
  `deployments/177.json`.
- **Reusable for the ecosystem:** `contracts/PolicyVault` (Foundry package), `@ate/venues` (typed HSKSwap
  adapter: QuoterV2, SwapRouter02, Multicall3 batching) and `@ate/mcp` (HSKSwap + vault MCP server) are
  released under Apache-2.0 with a one-page integration guide, so other HashKey agent teams can put
  their agents behind a vault without adopting the desktop app. **By 17:30 on Nov 2:** the public repo is
  tagged `vault-v0.1.0`, the Foundry package installs from that tag (`forge install <repo>@vault-v0.1.0`),
  and `docs/INTEGRATE.md` gives a one-command deploy for any qualifying pool — `forge script script/Deploy.s.sol:Deploy --rpc-url $HSK_RPC --ledger --broadcast` (env `AGENT`, `GUARDIAN`, `MARKETS`; it deploys a `SupraAggregatorAdapter` per market first; for another pool, deploy an adapter for its Supra pair and pass it as the vault's `oracle` constructor arg; the vault asserts the §4.1 shape) — with the two live deployments as
  worked examples. **Scope of reuse in v0.1:** the vault supports an 8- or 18-dp
  `priceToken` as pool `token0` priced against a 6-dp USD-stable `quoteToken` (`token1`) with an 8-dp
  AggregatorV3 feed — the constructor reads and asserts this shape (§4.1); WHSK/USDT and WBTC/USDT are
  the two live instances. Other orientations and decimals, and a second venue (Kredo), are v1.0. `@ate/venues`
  and `@ate/mcp` are **published to npm by 17:30 Nov 2** (Lane B; `vault-v0.1.0`-matched `0.1.0`).
- **Ecosystem contribution (by 17:30 Nov 2):** a draft PR to `HashKeyChain/HSK-Superpowers` adding an
  `agent-policy-vault` skill (deploy + verify + `setLimits` + fork-smoke a vault for any qualifying pool,
  Lane A); an ecosystem-directory listing request (ops-2); `docs/INTEGRATE.md` and the evidence footer
  report HSKSwap trades routed and USD routed through both vaults.

---

## 25. Open questions

| # | Question | Owner | Blocks | Default if unresolved |
|---|---|---|---|---|
| Q1 | ~~Canonical router~~ **Resolved Nov 2:** verified SwapRouter02 `0x2c16…D8F3`. The "active router" `0x1127…B790` is a private bot contract, not a router; it calls SwapRouter v1 `0x56d1…fBf5` | Eng | — | SwapRouter02 |
| Q2 | ~~APRO ETH/USD feed for WETH notional?~~ **Resolved Nov 2:** none exists; the HSKSwap WETH/USDT pool `0xb92b…4C16` is out of v0.1 scope (Supra lists ETH/USD as pair 1, but no ETH market is adapter-deployed or fork-smoked). WBTC/USDT is the second market (Supra BTC/USD, pair 0) | Eng | — | WETH excluded |
| Q3 | ~~Supra pull cost/complexity; which pair indices the storage contract serves~~ **Resolved Nov 2:** HSK/USD = 517, BTC/USD = 0 (ETH/USD = 1); a combined pull is ~330k gas; Supra is now the vault's price source (adapters), so pull refresh is v0.1 (§5.2) | Eng | — | Record pairs and adapters in `deployments/177.json` |
| Q4 | Owner signer for v0.1? | Ops | Deploy | Ledger on the second laptop, tested on 177 from a 1-HSK float at 10:30 (§19 step 0); fallback `cast wallet` encrypted keystore created and used only on that laptop; Vault-BTC moves to a Safe at ~17:00 (§19 step 9); Safe by default at v1.0. Guardian on a third device if available (§4.1) |
| Q5 | ~~QuoterV2 on 177?~~ **Resolved Nov 2:** `0x603f…bFDD` paired with the HSKSwap factory; four other verified quoters point at other factories — do not use | Eng | — | — |
| Q6 | Is the public HashKey Global API rate-limited for a 2-minute cycle (and for replay's kline pulls)? | Eng | Signals, E11 | Cache 10 s; back off; replay pages klines at ≤ 2 req/s |
| Q7 | ~~Does APRO return `answeredInRound == roundId`?~~ **Resolved Nov 2:** yes on both feeds, so the step-6 clause is included; the Supra adapter returns `answeredInRound = roundId`, so it never fires there | Eng | — | Clause included (`contracts/ABI-NOTES.md` 6) |
| Q8 | Funding source for the exact token `get_chain_config` returns | Ops | Payment funding | No-go at G-HSP |
| Q9 | Does OKX sign for the HSP-returned network? | Eng | Payment signing | Fallback signer (§8.4) |
| Q10 | HSP allowlist confirmation for `13.205.56.13` | Ops | HSP connection | Checked 10:30; not confirmed by 12:00 → Lane E contingency (§21.4); no-go at G-HSP 14:00 |
| Q11 | Second RPC for 177 (thirdweb or other) passes `doctor`? | Eng | Demo reliability | Blockscout `/api/eth-rpc` as second read/head-check source; if nothing passes, single RPC with 429/1015 backoff and `doctor` downgrades the 2-head check to a warning |
| Q12 | ~~How many builders?~~ **Resolved:** lead + five lane coding agents + ops-1 (signing) + ops-2 (recording/submission), each the other's backup (§21.4 Staffing) | Team | — | Lead covers either ops role if needed |
| Q13 | **Optional:** ask APRO (controller owner `0x9876…c7A7`) to `addAccess(vault)` for each vault so an APRO-backed vault can be deployed? | Ops | Nothing (APRO is a cross-check) | Not requested for v0.1; vaults stay on the Supra adapters; if granted later, `ORACLE_SOURCE=apro` deploys new vaults (immutables, so a new deployment), §0.2 |
| Q13 | Funding route for ~$220 USDT + HSK onto 177 (HashKey Global withdrawal network support vs OP bridge `0x4200…0010` delay) | Ops | Deploy, seeds | Ops hot wallet; confirmed by 11:00; smaller-seed fallback at 11:00 (§19 Funding) |
| Q14 | ~~WBTC pool `observationCardinality`?~~ **Resolved Nov 2:** 240/240 (`onchain-verification.md`, WBTC section); no cardinality tx | Eng | — | `doctor` re-checks ≥ 64 |
| Q15 | Does the WBTC gap (112.6 bps at 03:50) persist until the trader runs, and is it transient or a structural bridge discount? | Eng | E14 | Re-read at trader start (~14:00) for the BUIDL; replay top-decile gaps as the pre-registered second path (T1.8); replay persistence verdict (E11); the trader fires whenever it reopens and `check()` passes; otherwise §21.4 contingency and the spoken branch (T1.8 reported Partial) |

---

## 26. Glossary

**ATE** — Agentic Trading Environment. **Oracle** — the vault's immutable AggregatorV3-like price source: since v0.9.1 a `SupraAggregatorAdapter` over one Supra pair (HSK/USD 517, BTC/USD 0). **SupraAggregatorAdapter** — stateless, ownerless view over Supra's storage proxy (8 dp, rounds down, ms→s, `updatedAt` capped at `block.timestamp`, unpopulated → zeros → `ERR_ORACLE_INVALID`). **DORA / pull refresh** — Supra's oracle network and the permissionless `verifyOracleProof(bytes)` path the daemon uses to refresh a pair on demand (`oracle_refresh`, §5.2). **APRO** — the other HashKey feed provider; its feeds serve only EOAs / allow-listed contracts, so ATE reads them off-chain as a cross-check, not in the vault (§0.2, §5.1). **Vault** — `PolicyVault` instance, one per market (Vault-HSK,
Vault-BTC; same source and creation code, immutables differ); pair, oracle, router and pool fixed at deployment. **Market** — one of
`hsk-dex:WHSK/USDT:3000`, `hsk-dex:WBTC/USDT:3000`. **Portfolio guard** — the off-chain layer that splits
turnover among target assets and caps total exposure across vaults (§11.4). **Target assets** — the
markets allowed to hold inventory (`targetAssets`; `[]` = cash). **Limits** — the vault's mutable numeric caps. **Agent key** — signer allowed only to
call `execute` and `pause`. **Guardian key** — signer allowed only to `pause` (both vaults), held off the agent's machine (third
device if available, else the second).
**Owner** — the Ledger (or second-device keystore; Safe at v1.0) that sets limits and withdraws, used from
a separate device; never held by the daemon. **Candidate** — a daemon-computed, guard-sized trade
opportunity (`cand_<16hex>`, valid `candidateTtlSec` = max(120 s, 2 × p95 LLM latency)) that an
autonomous proposal binds to unless it is discretionary. **Exit reserve** — epoch budget the guard keeps
free for a full exit (§11.4 rule 3b).
**Discretionary trade** — an LLM-originated autonomous trade without a candidate: ≤ 3 per UTC day, ≤ $10,
thesis required, `origin=discretionary`, still under the guard and the vault (§11.4 rule 8).
**`TxQueue`** — the daemon's single agent-key signer and nonce manager (§7.1). **Token scopes** — `agent`,
`chat`, `ui`, `session`, `view`, and `rogue` (*additive*, only with `--allow-rogue`, §10.1); the journal `actor` is derived from the scope (§10.1). **Exit path** — the vault's
sell-only route when the deviation check fails, floored at `min(oracle, 300 s TWAP)` (§4.2 step 7b).
**Exposure** — a vault's priceToken held, valued at its oracle. **Proposal** — a validated,
single-use, 120-second intent record whose journal hash is the on-chain `proposalId`. **Journal** —
append-only, hash-chained decision log (`decisions` table). **Chat** — the in-app NL surface (§11.5). **Notional** — USD value of a
trade at oracle price, 8 dp. **Epoch** — fixed, aligned window of `epochDuration` seconds within which
spend is capped. **Deviation** — pool spot and 300 s TWAP vs oracle, in bps; both must be within `maxOracleDeviationBps`. **Payment conditions** — the receiving
agent's signed offer. **Payment Mandate** — the payer's persisted record binding conditions to an HSP
order and a prepared EIP-712 authorization.
