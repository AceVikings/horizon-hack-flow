#!/usr/bin/env bash
# Anvil-fork e2e for Lane B: deploy both vaults (Lane A's Deploy.s.sol), seed them, start the daemon with the
# agent key, run `ate-daemon smoke` (propose → execute via MCP) on both markets, then print /status + journal verify.
# Usage: apps/daemon/scripts/fork-e2e.sh   (env: FORK_BLOCK default 29623000, PORT default 8645)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${PORT:-8645}"; FORK_BLOCK="${FORK_BLOCK:-29623000}"; RPC="http://127.0.0.1:$PORT"
HOME_DIR="$(mktemp -d /tmp/ate-fork.XXXX)"
OWNER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
AGENT=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
GUARDIAN=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
USDT=0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029; WHSK=0xB210D2120d57b758EE163cFfb43e73728c471Cf1
POOL_HSK=0x4ff515761864e7838b0adb8b5b2b8b7a068905dc
anvil --fork-url "${HSK_RPC:-https://mainnet.hsk.xyz}" --fork-block-number "$FORK_BLOCK" --port "$PORT" --chain-id 177 --silent &
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null; kill ${DAEMON:-0} 2>/dev/null || true' EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
# the fork block is old: move time to now-ish so Supra/APRO ages match the pinned block (+60 s)
cd "$ROOT/contracts"
OUT=$(AGENT=$AGENT GUARDIAN=$GUARDIAN forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key $OWNER_PK --broadcast 2>&1)
VH=$(echo "$OUT" | awk '/market .*WHSK|market WHSK/{f=1} f&&/vault/{print $2; exit}')
VB=$(echo "$OUT" | awk '/market .*WBTC|market WBTC/{f=1} f&&/vault/{print $2; exit}')
echo "Vault-HSK $VH  Vault-BTC $VB"
[ -n "$VH" ] && [ -n "$VB" ] || { echo "$OUT" | tail -30; exit 1; }
# seed: USDT + WHSK from the pool (impersonated) into Vault-HSK, USDT into Vault-BTC
cast rpc anvil_impersonateAccount $POOL_HSK --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance $POOL_HSK 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
cast send $USDT "transfer(address,uint256)" $VH 120000000 --from $POOL_HSK --unlocked --rpc-url "$RPC" >/dev/null
cast send $USDT "transfer(address,uint256)" $VB 100000000 --from $POOL_HSK --unlocked --rpc-url "$RPC" >/dev/null
cast send $WHSK "transfer(address,uint256)" $VH 600000000000000000000 --from $POOL_HSK --unlocked --rpc-url "$RPC" >/dev/null
cd "$ROOT/apps/daemon"
# register the EAS schema on the fork (Lane E's builder) so attestations land
read -r SCHEMA_TO SCHEMA_DATA SCHEMA_UID < <(node --input-type=module -e 'import("@ate/journal/attest").then(m=>{const t=m.buildRegisterSchemaTx();console.log(t.to,t.data,t.expectedUid)})')
cast send "$SCHEMA_TO" "$SCHEMA_DATA" --private-key $OWNER_PK --rpc-url "$RPC" >/dev/null 2>&1 || echo "(schema already registered)"
export SCHEMA_UID
node -e '
const fs=require("fs");const [cfgPath,vh,vb,rpc]=process.argv.slice(1);
import("@ate/core/fixtures").then(({FIXTURE_CONFIG})=>{const c=structuredClone(FIXTURE_CONFIG);
c.chain.rpcUrls=[rpc];c.vaults=[{market:"hsk-dex:WHSK/USDT:3000",address:vh},{market:"hsk-dex:WBTC/USDT:3000",address:vb}];
c.strategy.portfolio.candidateTtlSec=180;c.eas.schemaUid=process.env.SCHEMA_UID;c.strategy.portfolio.scanSeconds=3600;fs.writeFileSync(cfgPath,JSON.stringify(c,null,2));});' "$HOME_DIR/config.json" "$VH" "$VB" "$RPC"
export ATE_HOME="$HOME_DIR" ATE_AGENT_PRIVATE_KEY=$AGENT_PK ATE_ALLOW_RAW_KEY=1 ATE_KEYSTORE=file
node dist/bin.js start --allow-rogue > "$HOME_DIR/daemon.log" 2>&1 &
DAEMON=$!
for i in $(seq 1 30); do [ -f "$HOME_DIR/runtime.json" ] && break; sleep 1; done; sleep 2
node dist/bin.js smoke --market WHSK --usd 5
cast rpc evm_increaseTime 61 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
node dist/bin.js smoke --market WBTC --usd 5
sleep 4
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).agentToken)' "$HOME_DIR/runtime.json")
PORTD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$HOME_DIR/runtime.json")
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/status"; echo
curl -s -X POST -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/journal/verify"; echo
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/api/view/ate_positions" | head -c 1500; echo
echo "--- daemon log"; tail -20 "$HOME_DIR/daemon.log"
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/api/view/ate_journal_read?limit=10" | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{for(const e of JSON.parse(s).data.entries)console.log(e.seq,e.id,e.kind,e.engine,e.verdict.code,e.verdict.message||\"\",e.attestation?e.attestation.easUid:\"\")})"
if [ -n "${DEBUG_ATTEST:-}" ]; then
  H=$(curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/api/view/ate_journal_read?limit=1" | grep -o 'attest tx 0x[0-9a-f]*' | head -1 | awk '{print $3}' || true)
  echo "trace $H"; cast run "$H" --rpc-url "$RPC" 2>&1 | tail -25 || true
fi
