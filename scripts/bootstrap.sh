#!/usr/bin/env bash
# One-time setup after clone: installs JS deps, Solidity libs (not committed) and the bloat guard hook.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
npx -y pnpm@9.15.0 install
mkdir -p contracts/lib
[[ -d contracts/lib/forge-std ]] || (cd contracts && forge install foundry-rs/forge-std@v1.17.0 --no-git)
[[ -d contracts/lib/openzeppelin-contracts ]] || (cd contracts && forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git)
echo "bootstrap: done"
