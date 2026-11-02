#!/usr/bin/env bash
# Blocks commits that add bloat: build output, vendored deps, secrets, local state, large files.
# Usage: scripts/check-bloat.sh            (checks staged files; used by .githooks/pre-commit)
#        scripts/check-bloat.sh --all      (checks every tracked file; used in CI)
set -euo pipefail
MAX_KB=${BLOAT_MAX_KB:-250}
if [[ "${1:-}" == "--all" ]]; then files=$(git ls-files); else files=$(git diff --cached --name-only --diff-filter=AM); fi
banned='(^|/)(node_modules|dist|out|cache|broadcast|coverage|\.turbo|\.next|\.context|\.tokensave)/|^contracts/lib/|^infra/aws/|(^|/)\.env($|\.)|\.(db|db-wal|db-shm|log|sqlite|pem|key|p12|zip|tar|gz|dmg|pdf|mp4|mov)$|(^|/)\.DS_Store$|deployer\.json$|(^|/)keystores?/|(^|/)keystore[^/]*\.json$'
fail=0
while IFS= read -r f; do
  [[ -z "$f" || ! -e "$f" ]] && continue
  if [[ "$f" =~ $banned ]]; then echo "bloat-guard: banned path: $f"; fail=1; continue; fi
  kb=$(( ($(wc -c < "$f") + 1023) / 1024 ))
  if (( kb > MAX_KB )) && [[ "$f" != "pnpm-lock.yaml" && "$f" != "SPEC.md" ]]; then echo "bloat-guard: $f is ${kb} KB (> ${MAX_KB} KB)"; fail=1; fi
done <<< "$files"
if (( fail )); then echo "bloat-guard: commit blocked. Fix the files above or adjust .gitignore."; exit 1; fi
