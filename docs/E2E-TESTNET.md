# End-to-end run of the desktop app on testnet (chain 133)

The real Electron app (no fixtures) was driven through its own UI on 2 Nov 2026, from a fresh app home, against the
existing testnet vaults in [`deployments/133.json`](../deployments/133.json). Every transaction below is on
<https://testnet-explorer.hskchain.net>. No new vaults were deployed.

## Setup

```sh
npx -y pnpm@9.15.0 --filter "@ate/daemon..." --filter "@ate/desktop..." --filter "@ate/trader..." build
cd apps/desktop
ATE_HOME=~/.ate-e2e ATE_KEYSTORE=file FLOW_TOUCH_ID=off ./node_modules/.bin/electron . --remote-debugging-port=9555
```

- `~/.ate-e2e` started empty. The app spawned its own daemon (`start --setup`) and wrote the testnet config itself.
- The UI was driven over the Chrome DevTools Protocol with `playwright-core` (`chromium.connectOverCDP`): clicks,
  typing and screenshots, the same controls a person uses. Screenshots are in `.context/e2e/` (not committed).
- `ATE_KEYSTORE=file` keeps the agent key and its sealed passphrase under the app home instead of the login
  keychain. `FLOW_TOUCH_ID=off` because this Mac has no `ate-approve`.
- AI: this Mac has no `ANTHROPIC_API_KEY` and no `ant` login. Claude Code (`claude`) is installed and signed in, so
  the run used the engine's Claude Code CLI path (`engine: "claude-code"`, model Claude Opus 5.5). The in-app SDK
  path (`runtime: sdk`) was **not** exercised: it needs an API key.

## First-run flow (UI)

| Step | What happened |
|---|---|
| Welcome | "I already have vaults". |
| Connect | Testnet 133 (selected by default). Both vaults found, owner `0xFF7D…569e`. Ticked "This is my wallet", "Use these vaults". Agent key: "Advanced: use an existing key", pasted the existing testnet agent key, Import. Both vaults "accept this key" (`0xC11C…4f8a`). |
| Set limits | Read from chain: $100 per trade, $250 a day, $150 held, worst day $51.50 across both vaults. Matches on-chain, Continue. |
| Start | AI account: no key, so "Use Claude Code on this Mac" (added in this run, see Fixes) → "Claude Opus 5.5 · Claude Code on this Mac, ready". Money: $501.05 in the vaults, agent gas 0.029 HSK. Safety checks: 18 of 18 passed. "On its own", Start trading. |
| Home | "Your agent is trading". Trader status: `runtime: claude-code`, `engine: llm`. |

## Trades

The testnet pools have no arbitrageurs, so no candidate fired at first (both pools were within the trading cost of
the HashKey Global price). The gaps were **staged on purpose** with `RecenterTestnetPool.s.sol` `OFFSET_BPS`, then
restored. Every trade below used a staged gap.

| When (UTC) | Trade | Decided by | Trade tx | EAS attestation tx (UID) |
|---|---|---|---|---|
| 10:14:02 | Sold 252.78 tWHSK for 22.45 tUSDT on Vault-HSK | daemon guard (take-profit exit, `engine: guard`) | [`0xe9a4…20dd`](https://testnet-explorer.hskchain.net/tx/0xe9a4994ec7956fe649901634632740cb20c15589f1beffcf968a8acb4f4720dd) | [`0x586a…0cc3`](https://testnet-explorer.hskchain.net/tx/0x586aca73b4900032daada8f58013320f642042d0402d1d8dc2d5f7ddacfe0cc3) (`0x152d…2382`) |
| 10:18:24 | Bought 0.00032366 tWBTC for $25.00 on Vault-BTC (spread-revert open, pool 137 bps under the CEX mid, cost 65, net +72 bps) | **LLM, Claude Code CLI** (`engine: llm`, `runtime: claude-code`) | [`0x0091…5657a`](https://testnet-explorer.hskchain.net/tx/0x00919b0764994b1a23c0b242a3b558bb3a4f16961f91d6bb3f1572bebcd5657a) | [`0xeb13…dff3`](https://testnet-explorer.hskchain.net/tx/0xeb136a1eaf5b67782c3b69ca4488d4b9e4f2965cc5fe9b453a41fcb4de7bdff3) (`0x1138a4ef2a422439cba72cc60dc868810b0dc61138f757b42b86071320c816f6`) |
| 10:20:14 | Sold the same 0.00032366 tWBTC (spread-revert close, +70 bps fee-inclusive) after the pool was restored | **LLM, Claude Code CLI** | [`0x211e…ce89`](https://testnet-explorer.hskchain.net/tx/0x211e7b85af97cb5a164a46a4d992721017edcf39ab7a4ec36164ce3c9aa6ce89) | [`0x33b8…7830`](https://testnet-explorer.hskchain.net/tx/0x33b8112554853e5120b1eb288a969be304ac10d55a2a44fb4ea9b12975837830) (`0x6d0c…f4ea0`) |

| 10:52:51 | Bought 0.00032366 tWBTC for $25.00 on Vault-BTC (spread-revert open, pool 144 bps under the CEX mid, cost 65, net +79 bps) | **LLM, OpenCode** (`engine: llm`, journal `actor.agentId = opencode:opencode/deepseek-v4.1-flash`) | [`0xcb4b…e3f8`](https://testnet-explorer.hskchain.net/tx/0xcb4b5d65e017bb8b6c3e87858ca5d0327d604cc764aee03756ca3cd6a04ee3f8) | [`0x605b…b5bb`](https://testnet-explorer.hskchain.net/tx/0x605bf1c7bfbd081acdf9b45b9de6805e7f33b965d9e42f1e511ffc8ab486b5bb) (`0x3a8177120b9ece348ffe3d1caec372576e9bd830f2e29ae69d122d20a2a4cf89`) |

### OpenCode engine (the engine under test)

After D3 landed the OpenCode provider, the same app home was switched to it in Accounts → OpenCode ("signed in",
model `opencode/deepseek-v4.1-flash`, in use). The trader runs in the daemon (`runtime: sdk`, provider `opencode`):
the daemon starts a private `opencode serve` and opencode calls Flow's MCP tools with the agent scope. Cycles ran
about 17 to 63 s. On the staged BTC gap, the scanner triggered cycle 4, and the model called `ate_quote`,
`ate_propose` and `ate_execute`. The buy above was journaled with `actor.agentId = opencode:opencode/deepseek-v4.1-flash`
and attested on EAS. This is the first live tool-calling run of the OpenCode engine through Flow's MCP.

Staged gaps (owner key, `contracts/script/RecenterTestnetPool.s.sol`):

- HSK pool `OFFSET_BPS=200` at 10:13 (first tx `0x0439cba6…3b20`), restored at 10:16 (`0xf3df9e90…59e3`).
- BTC pool `OFFSET_BPS=-150` at 10:17 (`0x631d5d75…2e64`), restored at 10:19 (`0x17e116e1…8b06`).
- BTC pool `OFFSET_BPS=-150` again at 10:51 for the OpenCode run (`0x51620d87…14c7`), restored at 10:54 (`0xa72a6b02…aaea`).

In Activity the buy shows as "Bought 0.00032366 WBTC for $25.00". Its full record shows the prices at the decision
(Supra $78,140.80, pool $76,968.68, HashKey Global $78,030.69), the AI rationale (hash on-chain), gap vs cost, all 13
vault checks passed, the trade tx, gas 215,314 and the attestation link.

## Ask, Pause, Resume

- **Ask:** "Show me a chart of the BTC pool price for the last hour". The agent (Claude Code, chat scope) called
  `ate_chart` and the app drew the 1-minute candle chart inline with **Pin**, plus a two-sentence summary that
  named the agent's buy and sell markers.
- **Pause:** Home → Pause trading → hold. `pause()` signed by the agent key on both vaults:
  [`0xdf0c…7bf9`](https://testnet-explorer.hskchain.net/tx/0xdf0ce787c9c88247a274848d7a1f13550414c90fda7480c79a2615e01c3d7bf9) (Vault-HSK),
  [`0x61a0…4530`](https://testnet-explorer.hskchain.net/tx/0x61a0120a91e08760c35aa65511d6e3c2d3dcf14a689e42a4bf75a5413ce84530) (Vault-BTC).
  `paused()` read `true` on both. Home: "Trading is paused".
- **Resume:** Home → Resume trading shows the owner-device QR (`unpause()` EIP-681 per vault). The Flow-managed owner
  service (CLOUD) is not wired into the desktop bridge yet (`window.ate.owner` is absent), so the existing QR path
  was used. Scanning was simulated by sending the same `unpause()` from the owner key with `cast`:
  [`0x8339…09ef`](https://testnet-explorer.hskchain.net/tx/0x8339e961c3fe8b7f5dd24f3867b2e64bdf3840a7ccec9bd0b992721cf28209ef),
  [`0x8767…bfb0`](https://testnet-explorer.hskchain.net/tx/0x87675f0f41d644b39573fbda1481670dc78cd4397f23f965b988af6b983dbfb0).
  `paused()` read `false` on both. The app unlocked the agent key by itself, and Home went back to "Your agent is trading".
- An earlier pause and resume in the same run: pause `0x93b1…25b6` / `0x860e…6ae2`, unpause `0xaa56…9452` / `0x46f1…c719`.

## Fixes made during the run

| Commit | Fix |
|---|---|
| `c58fd15` | Setup Start step offers "Use Claude Code on this Mac" when no API key is set. The daemon finds `claude` outside `PATH`, and `/ai/check` only checks that it is installed. Before this, a Mac with Claude Code but no key could only start the rules trader. |
| `d1899d8` | Choosing the Claude Code engine also switches the provider to Anthropic. The new subscription default made the button fail. |
| `b0d2525` | The Claude Code engine counts as a connected AI. Before this, Agent's mode switch restarted the trader on rules, and Ask said "simple answers". |
| `ea94ed5` | The kill switch locks the agent key, and nothing unlocked it after the owner's unpause. Home said "trading", and the next Pause failed with `ATE_DAEMON_LOCKED`. The app now unlocks the key once every vault is unpaused. |

| `95be9fa` | OpenCode in the app: the Accounts Test and credential paths now allow `opencode` and `subscription` (they returned "path not allowed"). An older `ai.json` that was auto-switched to opencode kept `claude-opus-5-5`, so every cycle failed with "opencode model must be provider/model". The opencode model now falls back to the recommended one. The `claude-code` engine flag only counts with the Anthropic provider. |
| `1b8dacf` | Accounts render loop: `SubscriptionSignIn` ran `onConnected` (an inline `pr.reload`) on every render. That reloaded `/engine/providers` thousands of times a second and used up the Mac's ephemeral TCP ports (16k sockets per side). Every local connection then failed, including the CDP driver, other lanes' apps and the RPC. It now runs only when the connection state changes. |

## Still open

- The Anthropic SDK path needs an Anthropic API key to be proven here. The OpenCode provider (also `runtime: sdk`) and the
  Claude Code CLI path both traded.
- Right after the daemon started, the first OpenCode cycle twice failed in about 1 s with "offline: Cannot reach the model
  provider". Both times the TCP ports were used up (see `1b8dacf`), so this is probably not an OpenCode bug. Later cycles were fine.
- The first LLM cycle's summary said the vault "turned down" the HSK sell. In fact the guard's take-profit had sold
  the position a moment earlier, so the LLM's follow-up proposals found no balance and no budget.
- Concurrency on shared keys: another app home (`~/.ate-flow-e2e`) ran a rules trader with the same agent key on
  the same vaults. Its execute reverted at 10:14:04 (`0x8814…d6ea`) right after ours. The owner key was also used by
  the CLOUD owner service at the same time, which caused one "replacement transaction underpriced" on an unpause.
- A renderer rebuild while the app is open blanks the next lazily loaded view (the old chunk hash is gone). Reload
  fixes it. This only happens in a dev checkout.
