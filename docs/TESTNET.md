# ATE on HashKey Chain TESTNET (chain 133)

This is a full ATE stack on testnet: test tokens, HSKSwap V3 pools priced from Supra, a Supra adapter and a
PolicyVault per market, and the §13 EAS schema. The vault bytecode and constructor checks match mainnet 177.
Every address is in [`deployments/133.json`](../deployments/133.json), which the daemon reads.

- RPC: `https://testnet.hsk.xyz`
- Explorer: <https://testnet-explorer.hskchain.net> (Blockscout). `testnet-explorer.hsk.xyz` does not resolve.
- HSK gas faucet: 1 HSK per 24 h. A full deploy costs about 0.024 HSK at 1 gwei; a $5 smoke plus its attestation costs about 0.0003 HSK.

## Addresses (deployed at block 35205638)

| What | Address |
|---|---|
| owner (deployer) | `0xFF7Df888C4DE9df4c044Fd0C7144AAfd1937569e` |
| agent | `0xC11CbceE5fDf41aa7175319691aA204eFb164f8a` |
| guardian | `0x8aAcC0D83C22644f76185EF0c082112D80Cdb66B` |
| tUSDT (6 dp) | `0xD57a8171b83E154145f47DcE512786173a9A36ca` |
| tWHSK (18 dp, stands in for WHSK) | `0x198c3EC5530463290e2F16988Bf6B8006F4C6995` |
| tWBTC (8 dp) | `0x2C7A171A58AE1690Cf1e01e296aB0CF9Dfc04aA2` |
| Vault-HSK (`hsk-dex:WHSK/USDT:3000`) | `0xF80A74F4D9C17Db8a2a0F32558a9FC3A63e2Bcd2` |
| HSK adapter (Supra pair 517) | `0xeCC8Fe21c7C0D39988856b6B67860bAe55A8c9A2` |
| tWHSK/tUSDT pool (fee 3000, ~$440k full range) | `0x840fa6e439F52cEa60dABec8BBB820DE80dDb542` |
| Vault-BTC (`hsk-dex:WBTC/USDT:3000`) | `0x6Da0c6EF7328d3aD6b0b8781770D941D065a6693` |
| BTC adapter (Supra pair 0) | `0x9bbb840B9e1086177507D958E40668f3cEF99372` |
| tWBTC/tUSDT pool (fee 3000, ~$100k full range) | `0x9d6A06ae873aD5d34ef13Ac8afE3BA80d1A5eF07` |
| EAS schema UID | `0x1c0c01e337924a140372f0043e9a9a3125e0e276b6dae78382676b3d0e53a04f` |
| HSKSwap factory / SwapRouter02 / QuoterV2 / NPM | `0x2dC2…f3A0` / `0xa691…4237` / `0x7382…a1cC` / `0x73dE…20e8` |
| Supra storage / pull | `0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917` / `0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702` |

The limits are the §19 defaults: $100 per trade, $250 per epoch, $150 exposure, 250 bps slippage and deviation,
500 bps exit discount, `maxOracleAge` 90000 s, 60 s cooldown. Each vault was seeded with ~$150 tUSDT and ~$50 of
its price token. The tokens and adapters are verified on Blockscout. The vaults are verified on Sourcify (exact
match), because their standard-JSON payload hits a 413 on the explorer gateway.

## Test tokens

Anyone can call `faucet()` on a token once per hour per address. Each call mints 1,000 tUSDT, 10,000 tWHSK or
0.01 tWBTC. The owner can also `mint(to, amount)`.

```sh
cast send 0xD57a8171b83E154145f47DcE512786173a9A36ca "faucet()" --rpc-url https://testnet.hsk.xyz --account <you>
```

## Deploy (again)

```sh
cd contracts
AGENT=0x… GUARDIAN=0x… forge script script/DeployTestnet.s.sol:DeployTestnet \
  --rpc-url https://testnet.hsk.xyz --private-key "$(jq -r '.[0].private_key' ~/.ate/testnet/deployer.json)" --broadcast --slow
```

The tokens use CREATE2 with mined salts, so `token0` is the price token and `token1` is tUSDT, as the vault
requires. A rerun reuses existing tokens, pools and liquidity. It deploys fresh adapters and vaults and rewrites
`deployments/133.json` (set `DEPLOYMENTS_OUT` to write elsewhere).

## Run the daemon and the trader on 133

```sh
node apps/daemon/scripts/testnet-config.mjs deployments/133.json ~/.ate-testnet/config.json --enable-strategy
# import the vault's agent key into the encrypted store (no raw-key dev path); passphrase from env or stdin
ATE_HOME=~/.ate-testnet ATE_KEYSTORE=file ATE_IMPORT_PRIVATE_KEY="$(jq -r '.[0].private_key' ~/.ate/testnet/agent.json)" \
  node apps/daemon/dist/bin.js keygen
ATE_HOME=~/.ate-testnet ATE_KEYSTORE=file ATE_DEPLOYMENTS=deployments/133.json \
  node apps/daemon/dist/bin.js start --allow-rogue --approval-fallback=armed --profile WHSK=demo
ATE_HOME=~/.ate-testnet node apps/daemon/dist/bin.js smoke --market WHSK --usd 5
ATE_HOME=~/.ate-testnet node apps/cli/dist/bin.js agent run --model sonnet --profile WHSK=demo --deployments deployments/133.json
ATE_HOME=~/.ate-testnet ATE_ROGUE_TOKEN=<from the daemon terminal> node apps/cli/dist/bin.js rogue --market WHSK
ATE_HOME=~/.ate-testnet node apps/cli/dist/bin.js chat --model sonnet   # session code: daemon terminal
```

The fixture config ships with the strategy disabled, so without `--enable-strategy` the guard rejects every
proposal. `ate chat` and strategy loosening need Touch ID, or the one-time code the daemon prints on its own
terminal after you type `approval-fallback enable` there.

A config with `chain.id: 133` makes the daemon switch the market, token and venue constants to the config's
addresses at load (`applyConfigNetwork`). It also signs with chain ID 133. APRO does not exist on testnet, so
the APRO cross-check is inactive and only the Supra adapter prices trades.

To run the whole flow end to end (config, daemon, smoke on both markets, a $5,000 `check()`, journal verify):

```sh
MODE=fork apps/daemon/scripts/testnet-e2e.sh   # Anvil fork of testnet: deploys first, waits 305 s for the TWAP
MODE=live apps/daemon/scripts/testnet-e2e.sh   # real testnet, against deployments/133.json
```

Live smoke on 2026-11-02:

- WHSK: `0x32db6272badcc1ef5ff998a1e7824bb20432ae3e0eac140d87bd999c2b29113f`, EAS UID `0x2583…3ba5`
- WBTC: `0x8e8fbaa132d730f678f9dab4bab0e97fea020ac159c44796f5961ce0bb4ffeb1`, EAS UID `0x8d46…5a50`
- The $5,000 `check()` returned 9 (`ERR_TRADE_CAP`) on both vaults.

## Run on 2 Nov 2026

The LLM trader, `ate rogue`, the guardian pause and `ate chat` ran against these vaults. Every link is in
[`docs/JUDGE.md`](JUDGE.md). The journal export is [`testnet-133-journal.json`](testnet-133-journal.json). The WBTC
pool (−150 bps) and the HSK pool (+200 bps) were moved off the Supra price with `OFFSET_BPS` for part of the run,
then re-centered.

## Testnet caveats

- **Nobody arbitrages the pools.** They sit at the Supra price from deploy time. When Supra moves more than 2.5%
  (`maxOracleDeviationBps`), normal-path trades revert `ERR_ORACLE_DEVIATION`. To fix it, re-center the pool.
  The script mints test tokens to the deployer and swaps exactly to the adapter price. Exit-path sells still work.

  ```sh
  cd contracts && MARKET=hsk forge script script/RecenterTestnetPool.s.sol:RecenterTestnetPool \
    --rpc-url https://testnet.hsk.xyz --private-key "$(jq -r '.[0].private_key' ~/.ate/testnet/deployer.json)" --broadcast
  ```

  `MARKET=btc` does the WBTC pool. `OFFSET_BPS=-150` moves the pool 150 bps below the adapter price instead. This
  stages a price gap on purpose; say so wherever you show a trade that used it.
- **Supra testnet updates slowly.** The pair was ~4 h old at deploy. The generated config enables pull refresh
  (testnet DORA, `refreshAgeSec` 43200), which keeps it inside `maxOracleAge` (90000 s).
- **Wait for the TWAP.** Both pools need 300 s of history after creation before `observe([300,0])` works.
  Observation cardinality is 64 next, and grows as swaps write observations.
