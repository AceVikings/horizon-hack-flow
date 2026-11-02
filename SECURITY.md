# Security

## Status

ATE is unaudited. `PolicyVault` and `SupraAggregatorAdapter` are unit-tested, including:

- every reason code in both directions, for both priceToken shapes;
- `check()`/`execute()` parity;
- invariant fuzzing;
- an Anvil-fork smoke against the real HSKSwap pools and Supra feeds on chain 177.

They are not formally verified. Use the caps as the size of the bet you are willing to lose.

## Reporting a vulnerability

Email `security@<TBD>`. Include the affected component and, if possible, a reproduction. A fork test is
ideal. Do not open a public issue for an unfixed vulnerability. No bug bounty is live yet; an audit and a
public bounty are planned.

## Design premise

The vault is the security boundary, not the daemon. The agent usually runs as the same OS user as the
daemon and has a shell, so ATE assumes the agent key can be stolen. Instead it makes the agent key low
privilege: it can only `execute` (bounded on-chain) and `pause`.

## Keys

| Key | Where it lives | Can do |
|---|---|---|
| Agent | The agent's machine: OS keychain, or an AES-256-GCM + scrypt keystore. One key per daemon, `agent` on both vaults | `execute` and `pause` on the vaults; EAS attestations; permissionless Supra refreshes |
| Owner | Second device only: a Ledger, or a `cast wallet` encrypted keystore created there. A Safe later. Never loaded by the daemon | `setLimits`, `withdraw`, `setAgent`, `setGuardian`, `pause`, `unpause`, two-step `transferOwnership` |
| Guardian | Off the agent's machine. A third device if available, else the second device (then it is independent of the daemon but not of that laptop) | `pause` only |
| Approval (P-256) | Secure Enclave on the agent's Mac, behind Touch ID. Used through `ate-approve`, a signed helper that is the only reader allowed by the keychain ACL | Signs human approvals over a payload it renders itself: UI attach, `ate chat` sessions, loosening strategy changes, `confirm` trades, payments |
| HSP payer | Worker side (OKX Agentic Wallet TEE, or a fallback EOA). Outside the vault | Payments of at most $1.00 per day; optional, outside the trade path |

The daemon holds no owner key and no guardian key. It never builds owner calldata, and no endpoint can
perform an owner operation. Dev-only overrides (`ATE_AGENT_PRIVATE_KEY` with `ATE_ALLOW_RAW_KEY=1`, and
`ATE_KEYSTORE=file`) exist for the Anvil fork and must not be used on mainnet.

## Local API token scopes

The daemon binds `127.0.0.1` only. Every request needs a bearer token. The one exception is step 1 of
`/ui/attach`, which only issues a nonce. Browser origins are rejected. Tokens are 32 random bytes and
rotate at each start. The journal `actor` is derived from the token scope, never from the request body.

| Scope | How it is issued | What it reaches |
|---|---|---|
| `agent` | Written to `~/.ate/runtime.json` (mode 0600) | The full MCP trading tool set, used by the trader runner, `ate mcp serve` and external agents. It is bounded on-chain |
| `chat` | Minted per Chat session. Lives only in the chat runner's environment and MCP config, never on disk. Expires with the session (30 min idle) | Only the chat allowlist, which the MCP server enforces: `ate_market_get`, `ate_candidates_get`, `ate_quote`, `ate_positions`, `ate_strategy_get`, `ate_strategy_set`, `ate_journal_read`, `ate_pause`. No `ate_execute`, no shell, no files |
| `ui` | Held in memory by Electron main. Obtained through the spawn pipe, or through `/ui/attach` with an `ate-approve` signature | Opens Chat sessions, `/chat` turns, `/cycle`, `/strategy/approve` |
| `session` | Issued by `POST /chat/session`, only against an `ate-approve` signature over a daemon nonce | `/chat` turns for one `ate chat` session |
| `view` | One-time token printed by `ate ui` | The read-only fallback page |
| `rogue` | Exists only when the daemon is started with `--allow-rogue`. Printed once to the daemon's controlling TTY, never to a file, log or `/events`. The demo operator passes it to `ate rogue` as `ATE_ROGUE_TOKEN` | Only the raw-broadcast route. Calldata must target one of the vaults with selector `execute`, `withdraw`, `setLimits` or `pause`. Every call is journalled `profile=rogue`. Any other scope on that route gets 403 |

Notes:

- The `ate ui` command is specified but not yet built.
- `ate rogue` is in progress per SPEC §22.3.
- `ate chat` currently connects through a chat-scoped MCP proxy (`--mcp-command`, or `--stub` for
  fixtures). The approval-gated `/chat/session` flow is being wired up against the real daemon.

Loosening strategy changes return `ATE_APPROVAL_REQUIRED`. Loosening means anything that makes the agent
larger or more active. These changes apply only after an `ate-approve` signature over the rendered diff.
Tightening changes apply at once.

v0.1 has a degraded fallback, off by default, enabled only by typing on the daemon's own TTY. It allows a
TTY one-time code for `/ui/attach`, `/chat/session` and loosening changes only. It is weaker than Touch ID:
a same-user process that can read that terminal can obtain a code. Even so, it yields only `ui`/`session`
scope, inside the vault bound.

## What the vault guarantees

These hold whatever the agent is told or believes, and with its key stolen:

- **No withdrawal by the agent.** Only the owner can `withdraw`, `setLimits`, `setAgent`, `setGuardian`
  or `unpause`. Swap proceeds never leave the vault.
- **Fixed market.** The pair, pool, oracle and router are immutable. `SwapParams` has no pool or router
  parameter, so the agent cannot route through an attacker's pool.
- **USD caps per vault.** Per-trade and per-epoch notional caps. An exposure cap on priceToken holdings,
  valued at the oracle and checked before and after every buy. A cooldown between executions.
- **Oracle-anchored price.** The contract computes the minimum output from the oracle and
  `maxSlippageBps`, and agent input cannot widen it. Spot and 5-minute TWAP must both sit within
  `maxOracleDeviationBps` of the oracle, otherwise buys are refused. Sells can use the bounded exit path
  (floor at `min(oracle, TWAP)`; TWAP no more than `maxExitDiscountBps` below the oracle).
- **Stale or invalid oracle means no trade.** It never falls back to DEX spot.
- **Fail-safe pause.** The owner, the agent or the guardian can pause. Only the owner can unpause.

At the default limits, execution loss across both vaults is at most $51.50 per UTC day while the Supra feed
is live, and exposure is at most $150 per vault. SPEC §4.6 gives the full bounds, including rolling 24 h,
the exit path and the oracle-wrong ceiling.

## What it does not guarantee

- **Price risk on held exposure.** The contract caps how much exposure you hold, not what the market does
  to it. Stop-loss is off-chain (the daemon guard), and it cannot exit while the vault is paused, the oracle
  is stale, the epoch budget is spent, or the TWAP is more than `maxExitDiscountBps` below the oracle.
- **A wrong oracle.** Supra's committee and its storage proxy are the pricing trust root. A wrong feed
  mis-prices the floor. The loss is bounded per vault by the vault's balance and the caps. The Supra–APRO
  cross-check withholds entries off-chain only.
- **Peg of the price token or the stable.** USDT is valued at $1, and bridged WBTC is assumed to track BTC.
- **The off-chain guards.** The portfolio guard, strategy clamps, discretionary lane and daily-loss
  breaker are off-chain, so a compromised daemon can ignore them. Against a stolen key, the bound is the
  sum of the vaults' on-chain limits.
- **Gas, pause and attestations.** A stolen agent key can burn the agent's gas float, pause the vaults,
  and write misleading EAS attestations from the agent address. Those attestations cannot change what
  `TradeExecuted` shows.
- **MEV on honest trades.** Honest trades are bounded by `minAmountOut = max(floor, quote × 0.995)`, about
  50 bps plus the fee.
- **Same-user compromise of the payment path while an operator AWS session is live.** This can spend the
  payer float, up to $1.00 per day. Vault funds are unaffected.
- **Formal correctness.** The contracts are unaudited and fuzz-tested, not proven.

## Threat model summary (SPEC §17.1)

| Threat | Mitigation |
|---|---|
| Agent compromised or prompt-injected | Bounded per vault by on-chain caps; immutable pair, pool, oracle and router; exposure cap; proceeds stay in the vault |
| Agent lies about the market to widen slippage | Floor computed in-contract from the oracle; agent input ignored |
| Shell-capable agent reads the daemon token or keychain | Only `agent` scope and the agent key (`execute`/`pause`); no owner or guardian key on the machine; human approvals need a Secure Enclave signature |
| Stale oracle, sandwich or colluding pool | Spot and TWAP deviation checks; staleness check; per-trade loss bounded |
| TWAP held down to abuse the exit path | Sells only; 300 s TWAP; floor at `min(P, TWAP)`; TWAP no more than 500 bps below the oracle |
| Routing into an attacker pool, oracle or router | Immutable; no pool parameter; owner operations on a separate device |
| Renderer XSS | The renderer holds no daemon token; strict CSP; no `innerHTML` |
| Malicious or rate-limited RPC | Two or more RPCs with chain-ID and head cross-check; pre-flight `eth_call`; backoff |
| Supply chain | Lockfile, `pnpm audit`, no postinstall scripts; signed releases in v1.0 |
| Replay of an old proposal | 120 s expiry, single-use ids, on-chain `deadline` |
| Prompt injection through chat, CEX data or journal text | Chat runner tool allowlist (`mcp__ate__*` only); server-enforced chat scope; agent text wrapped in `<untrusted_agent_text>`; loosening needs Touch ID |
| Nonce collisions or a stuck tx | Single `TxQueue` with depth 1 and priority pause > exits > executes > attests; same-nonce replacement |
| Supra feed wrong, stale or unrefreshable | Bounded by the caps; permissionless pull refresh; the market goes read-only rather than falling back to spot |
| Same-user malware edits config or journal | Append-only triggers; hash chain anchored on-chain by `proposalId` and EAS; pinned RPC list (signed config in v1.0) |

## Non-negotiables

- No telemetry, analytics or remote crash reporting.
- No remote code execution path in the daemon.
- The daemon never signs owner operations.
- Private keys are never sent to the renderer, logs or the journal. No endpoint returns key material.
