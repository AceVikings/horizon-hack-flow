#!/usr/bin/env bash
# Builds the `cloud-deploy` branch: one orphan commit holding only what the Flow cloud image needs (no history),
# like `site-deploy`. Contract bytecode comes from a local `forge build` (contracts/out), slimmed to { bytecode }.
# Usage: scripts/cloud-deploy-branch.sh [--push]
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
paths=(Dockerfile .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json LICENSE apps packages agents deployments)
git archive HEAD "${paths[@]}" | tar -x -C "$tmp"
mkdir -p "$tmp/contracts/artifacts"
for c in PolicyVault SupraAggregatorAdapter; do
  node -e 'const j=require(process.argv[1]);process.stdout.write(JSON.stringify({contract:process.argv[2],bytecode:j.bytecode.object}))' \
    "$root/contracts/out/$c.sol/$c.json" "$c" > "$tmp/contracts/artifacts/$c.json"
done
cd "$tmp"
git init -q -b cloud-deploy
git add -A
git -c user.name="$(git -C "$root" config user.name)" -c user.email="$(git -C "$root" config user.email)" \
  commit -q -m "cloud-deploy: image sources at $(git -C "$root" rev-parse --short HEAD)"
echo "cloud-deploy: $(git ls-files | wc -l | tr -d ' ') files, $(du -sh . | cut -f1)"
if [[ "${1:-}" == "--push" ]]; then
  git push -q -f "$(git -C "$root" remote get-url origin)" cloud-deploy:cloud-deploy
  echo "pushed cloud-deploy"
fi
