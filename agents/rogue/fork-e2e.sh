#!/usr/bin/env bash
# Anvil-fork E2E for `ate rogue` (SPEC §22.3): deploy both vaults with the Supra adapters (contracts' Deploy.s.sol),
# seed Vault-HSK, start the daemon with --allow-rogue, run the full attack list, then the guardian pause →
# `ate rogue --only paused`, owner unpause, and finally `ate rogue --stage` (the pitch subset).
# Usage: agents/rogue/fork-e2e.sh   (env: HSK_RPC, FORK_BLOCK default latest, PORT default 8845, KEEP=1 to leave it running)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-8845}"; RPC="http://127.0.0.1:$PORT"
HOME_DIR="$(mktemp -d /tmp/ate-rogue.XXXX)"
OWNER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
AGENT_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
AGENT=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
GUARDIAN_PK=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
GUARDIAN=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
USDT=0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029; WHSK=0xB210D2120d57b758EE163cFfb43e73728c471Cf1
POOL_HSK=0x4ff515761864e7838b0adb8b5b2b8b7a068905dc
FORK_ARGS=(--fork-url "${HSK_RPC:-https://177.rpc.thirdweb.com}" --port "$PORT" --chain-id 177 --block-time 2 --silent)
[ -n "${FORK_BLOCK:-}" ] && FORK_ARGS+=(--fork-block-number "$FORK_BLOCK")
anvil "${FORK_ARGS[@]}" &
ANVIL=$!
cleanup() { [ -n "${KEEP:-}" ] && { echo "KEEP=1: anvil $ANVIL daemon ${DAEMON:-} home $HOME_DIR"; return; }; kill $ANVIL 2>/dev/null; kill ${DAEMON:-0} 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
cd "$ROOT/contracts"
OUT=$(AGENT=$AGENT GUARDIAN=$GUARDIAN forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --private-key $OWNER_PK --broadcast 2>&1)
VH=$(echo "$OUT" | awk '/market .*WHSK|market WHSK/{f=1} f&&/vault/{print $2; exit}')
VB=$(echo "$OUT" | awk '/market .*WBTC|market WBTC/{f=1} f&&/vault/{print $2; exit}')
echo "Vault-HSK $VH  Vault-BTC $VB"
[ -n "$VH" ] && [ -n "$VB" ] || { echo "$OUT" | tail -30; exit 1; }
cast rpc anvil_impersonateAccount $POOL_HSK --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance $POOL_HSK 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
cast send $USDT "transfer(address,uint256)" $VH 120000000 --from $POOL_HSK --unlocked --rpc-url "$RPC" >/dev/null
cast send $WHSK "transfer(address,uint256)" $VH "${SEED_WHSK:-900000000000000000000}" --from $POOL_HSK --unlocked --rpc-url "$RPC" >/dev/null
cd "$ROOT/apps/daemon"
node -e '
const fs=require("fs");const [cfgPath,vh,vb,rpc]=process.argv.slice(1);
import("@ate/core/fixtures").then(({FIXTURE_CONFIG})=>{const c=structuredClone(FIXTURE_CONFIG);
c.chain.rpcUrls=[rpc];c.vaults=[{market:"hsk-dex:WHSK/USDT:3000",address:vh},{market:"hsk-dex:WBTC/USDT:3000",address:vb}];
c.strategy.enabled=false;c.strategy.portfolio.candidateTtlSec=180;c.strategy.portfolio.scanSeconds=3600;fs.writeFileSync(cfgPath,JSON.stringify(c,null,2));});' "$HOME_DIR/config.json" "$VH" "$VB" "$RPC"
export ATE_HOME="$HOME_DIR" ATE_AGENT_PRIVATE_KEY=$AGENT_PK ATE_ALLOW_RAW_KEY=1 ATE_KEYSTORE=file
node dist/bin.js start --allow-rogue > "$HOME_DIR/daemon.log" 2>&1 &
DAEMON=$!
for i in $(seq 1 30); do [ -f "$HOME_DIR/runtime.json" ] && grep -q "rogue token" "$HOME_DIR/daemon.log" && break; sleep 1; done; sleep 2
export ATE_ROGUE_TOKEN=$(grep -o 'rogue token (printed once, --allow-rogue): [A-Za-z0-9_-]*' "$HOME_DIR/daemon.log" | awk '{print $NF}')
ATE="node $ROOT/apps/cli/dist/bin.js"
FAIL=0
echo "=== 1. full run (all attacks except paused)"
$ATE rogue --only trade_cap,exposure,slippage,pair,withdraw,set_limits || FAIL=1
echo "=== 2. guardian pause() (off the agent's machine), then execute-after-pause"
cast send "$VH" "pause()" --private-key $GUARDIAN_PK --rpc-url "$RPC" >/dev/null
$ATE rogue --only paused || FAIL=1
echo "=== 3. owner unpause(), then the staged pitch subset"
cast send "$VH" "unpause()" --private-key $OWNER_PK --rpc-url "$RPC" >/dev/null
$ATE rogue --stage || FAIL=1
echo "=== journal (profile=rogue)"
TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).agentToken)' "$HOME_DIR/runtime.json")
PORTD=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).port)' "$HOME_DIR/runtime.json")
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/api/view/ate_journal_read?limit=40" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const e of JSON.parse(s).data.entries.reverse())if(e.profile==='rogue')console.log(e.seq,e.id,e.kind,e.verdict.code,(e.execution&&e.execution.txHash)||'',e.execution&&e.execution.reverted?'reverted':'')})"
curl -s -X POST -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/journal/verify"; echo
echo "rogue fork e2e: $([ $FAIL = 0 ] && echo PASS || echo FAIL)"
exit $FAIL
