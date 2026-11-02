#!/usr/bin/env bash
# HashKey Chain TESTNET (133) end to end: deployment → daemon (133 config) → `ate smoke` on both markets →
# $5,000 check() (expect ERR_TRADE_CAP = 9) → /status + journal verify.
#
#   MODE=fork apps/daemon/scripts/testnet-e2e.sh   # Anvil fork of testnet: runs DeployTestnet.s.sol first
#   MODE=live apps/daemon/scripts/testnet-e2e.sh   # real testnet: uses deployments/133.json as deployed
#
# Env: DEPLOYER_KEY_FILE / AGENT_KEY_FILE / GUARDIAN_KEY_FILE (default ~/.ate/testnet/{deployer,agent,guardian}.json,
# `cast wallet new --json` output; owner, agent and guardian are separate roles), PORT (anvil, default 8733),
# USD (smoke size, default 5). Keys are never printed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MODE="${MODE:-fork}"; PORT="${PORT:-8733}"; USD="${USD:-5}"
KEYFILE="${DEPLOYER_KEY_FILE:-$HOME/.ate/testnet/deployer.json}"
key() { jq -r 'if type=="array" then .[0].private_key else .private_key end' "$1"; }
addr() { jq -r 'if type=="array" then .[0].address else .address end' "$1"; }
PK="$(key "$KEYFILE")"
AGENT_FILE="${AGENT_KEY_FILE:-$HOME/.ate/testnet/agent.json}"; GUARDIAN_FILE="${GUARDIAN_KEY_FILE:-$HOME/.ate/testnet/guardian.json}"
AGENT_PK="$(key "$AGENT_FILE")"; export AGENT="$(addr "$AGENT_FILE")" GUARDIAN="$(addr "$GUARDIAN_FILE")"
HOME_DIR="$(mktemp -d /tmp/ate-133-$MODE.XXXX)"
DAEMON=""; ANVIL=""
trap 'kill ${DAEMON:-} ${ANVIL:-} 2>/dev/null || true' EXIT

if [ "$MODE" = fork ]; then
  RPC="http://127.0.0.1:$PORT"; DEP="$ROOT/deployments/133-fork.json"
  if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
    anvil --fork-url https://testnet.hsk.xyz --chain-id 133 --port "$PORT" --silent &
    ANVIL=$!
    for _ in $(seq 1 60); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done
  fi
  cast rpc anvil_setBalance "$AGENT" 0x16345785D8A0000 --rpc-url "$RPC" >/dev/null   # 0.1 HSK agent gas (fork only)
  (cd "$ROOT/contracts" && DEPLOYMENTS_OUT=../deployments/133-fork.json DEPLOY_LABEL=anvil-fork \
    forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url "$RPC" --private-key "$PK" --broadcast --slow 2>&1 \
    | grep -E "^  |Error|error" || true)
  # the vault's 300 s TWAP needs pool history. Wait in real time (evm_increaseTime would put the fork ahead of
  # the wall clock the daemon uses for deadlines → ERR_DEADLINE), then mine so the next block is fresh.
  echo "waiting 305 s for the 300 s pool TWAP window"; sleep 305
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
else
  RPC="https://testnet.hsk.xyz"; DEP="$ROOT/deployments/133.json"
  AT=$(jq -r .deployedAt "$DEP"); NOW=$(date +%s)
  if [ $((NOW - AT)) -lt 310 ]; then echo "waiting $((310 - NOW + AT)) s for the 300 s pool TWAP window"; sleep $((310 - NOW + AT)); fi
fi

cd "$ROOT/apps/daemon"
node scripts/testnet-config.mjs "$DEP" "$HOME_DIR/config.json" --rpc "$RPC" --scan-seconds 3600 >/dev/null
export ATE_HOME="$HOME_DIR" ATE_DEPLOYMENTS="$DEP" ATE_KEYSTORE=file
# import the agent key into the encrypted file store (not the raw-key dev path); throwaway passphrase per run
ATE_AGENT_PASSPHRASE="$(openssl rand -hex 16)"; export ATE_AGENT_PASSPHRASE
ATE_IMPORT_PRIVATE_KEY="$AGENT_PK" node dist/bin.js keygen >/dev/null
node dist/bin.js start > "$HOME_DIR/daemon.log" 2>&1 &
DAEMON=$!
for _ in $(seq 1 30); do [ -f "$HOME_DIR/runtime.json" ] && break; sleep 1; done; sleep 3
TOKEN=$(jq -r .agentToken "$HOME_DIR/runtime.json"); PORTD=$(jq -r .port "$HOME_DIR/runtime.json")

node dist/bin.js smoke --market WHSK --usd "$USD"
node dist/bin.js smoke --market WBTC --usd "$USD"
sleep 6

USDT=$(jq -r .tokens.USDT.address "$DEP")
DL=$(( $(cast block latest -f timestamp --rpc-url "$RPC") + 600 ))
for M in "hsk-dex:WHSK/USDT:3000" "hsk-dex:WBTC/USDT:3000"; do
  V=$(jq -r --arg m "$M" '.markets[$m].vault' "$DEP")
  R=$(cast call "$V" "check(address,(address,uint256,uint256,uint256,bytes32))(uint8,uint256,uint256,uint256,bool)" \
      "$AGENT" "($USDT,5000000000,0,$DL,0x$(printf '0%.0s' {1..64}))" --rpc-url "$RPC" | head -1)
  echo "check(\$5,000 buy) on $M vault $V -> reason $R (9 = ERR_TRADE_CAP)"
done

curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/status"; echo
curl -s -X POST -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/journal/verify"; echo
curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORTD/api/view/ate_journal_read?limit=12" \
  | jq -r '.data.entries[] | [.seq, .id, .kind, .engine, .verdict.code, (.verdict.message // ""), (.attestation.easUid // "")] | @tsv'
echo "--- daemon log ($HOME_DIR/daemon.log)"; tail -25 "$HOME_DIR/daemon.log"
