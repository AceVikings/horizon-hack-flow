#!/usr/bin/env node
// Build a chain-133 (HashKey Chain TESTNET) ~/.ate/config.json from deployments/133.json.
//
//   node apps/daemon/scripts/testnet-config.mjs [deployments/133.json] [out=~/.ate-testnet/config.json] \
//     [--rpc URL]... [--agent-key-id ID] [--scan-seconds N] [--enable-strategy]
//
// Starts from the §16 fixture config (strategy, chat, payments, ui defaults) and swaps in the testnet chain,
// vaults, test-token addresses, HSKSwap testnet venue, Supra testnet storage/pull and the EAS schema UID.
// Run from apps/daemon (or anywhere `@ate/core` resolves).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { FIXTURE_CONFIG } from "@ate/core/fixtures";
import { parseConfig } from "@ate/core";

const args = process.argv.slice(2);
const pos = [];
const rpcs = [];
let agentKeyId = "ate-testnet-agent";
let scanSeconds = 20;
let enableStrategy = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--rpc") rpcs.push(args[++i]);
  else if (args[i] === "--agent-key-id") agentKeyId = args[++i];
  else if (args[i] === "--scan-seconds") scanSeconds = Number(args[++i]);
  else if (args[i] === "--enable-strategy") enableStrategy = true;
  else pos.push(args[i]);
}
const depPath = resolve(pos[0] ?? "deployments/133.json");
const out = resolve(pos[1] ?? `${homedir()}/.ate-testnet/config.json`);
const d = JSON.parse(readFileSync(depPath, "utf8"));
if (d.chainId !== 133) throw new Error(`${depPath}: chainId ${d.chainId}, expected 133`);

const ids = ["hsk-dex:WHSK/USDT:3000", "hsk-dex:WBTC/USDT:3000"];
const c = structuredClone(FIXTURE_CONFIG);
c.chain = { id: 133, rpcUrls: rpcs.length ? rpcs : d.rpcUrls, explorer: d.explorer };
c.agentKeyId = agentKeyId;
c.guardian = d.guardian;
c.vaults = ids.map((m) => ({ market: m, address: d.markets[m].vault }));
c.eas = { address: d.eas.address, schemaUid: d.eas.schemaUid };
c.venues.hskdex = {
  factory: d.hskdex.factory,
  router: d.hskdex.router,
  quoter: d.hskdex.quoter,
  routerKind: "swaprouter02",
  markets: c.venues.hskdex.markets.map((m) => ({
    ...m,
    pool: d.markets[m.id].pool,
    oracle: d.markets[m.id].adapter,
    baseToken: d.markets[m.id].priceToken,
    quoteToken: d.markets[m.id].quoteToken,
  })),
};
c.oracle.apro.maxAgeSec = d.limits.maxOracleAge; // enforcement (Supra adapter) age bound = vault maxOracleAge
c.strategy = structuredClone(c.strategy);
c.strategy.portfolio.candidateTtlSec = d.candidateTtlSec ?? 180;
c.strategy.portfolio.scanSeconds = scanSeconds;
// the §16 fixture ships the strategy disabled (the guard rejects every proposal); test tokens only, so the trader
// run on 133 may start it enabled
if (enableStrategy) c.strategy.enabled = true;
// testnet gas is ~1 gwei and the faucet gives 1 HSK/day: alarm and attest floor scaled down
c.daemon = { ...c.daemon, gasAlarmHsk: "0.01", attestFloorHsk: "0.001" };
c.supra = {
  storage: d.supra.storage,
  use: "entry-gate+crosscheck",
  maxDisagreeBps: 250,
  maxAgeSec: d.limits.maxOracleAge,
  pairs: Object.fromEntries(ids.map((m) => [m, d.markets[m].supraPair])),
  pull: { enabled: true, contract: d.supra.pull, proofUrl: d.supra.proofUrl, refreshAgeSec: 43_200 },
};
parseConfig(c); // throws ATE_CONFIG_INVALID on any schema issue
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, JSON.stringify(c, null, 2), { mode: 0o600 });
console.log(out);
