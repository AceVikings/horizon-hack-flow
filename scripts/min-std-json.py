#!/usr/bin/env python3
"""Shrink a forge standard-JSON input below Blockscout's ~100 KB request limit by stripping comments.

Usage (from contracts/):
  forge verify-contract <addr> src/PolicyVault.sol:PolicyVault --show-standard-json-input > /tmp/full.json
  python3 ../scripts/min-std-json.py /tmp/full.json /tmp/min.json
  curl -X POST $EXPLORER/api/v2/smart-contracts/<addr>/verification/via/standard-input \
    -F compiler_version=v0.8.24+commit.e11b9ed9 -F contract_name=PolicyVault -F license_type=mit \
    -F autodetect_constructor_args=false -F constructor_args=<hex, no 0x> -F 'files[0]=@/tmp/min.json'
Bytecode is unchanged; only the CBOR metadata hash differs, so Blockscout reports a partial match.
"""
import json, re, sys


def strip(src):
    out, i, n, quote = [], 0, len(src), None
    while i < n:
        c = src[i]
        if quote:
            out.append(c)
            if c == "\\":
                out.append(src[i + 1]); i += 2; continue
            if c == quote:
                quote = None
            i += 1; continue
        if c in "\"'":
            quote = c; out.append(c); i += 1; continue
        if src.startswith("//", i):
            j = src.find("\n", i); j = n if j < 0 else j
            if "SPDX-License-Identifier" in src[i:j]:
                out.append(src[i:j])
            i = j; continue
        if src.startswith("/*", i):
            i = src.find("*/", i + 2) + 2; continue
        out.append(c); i += 1
    return re.sub(r"\n\s*\n+", "\n", re.sub(r"[ \t]+\n", "\n", "".join(out)))


d = json.load(open(sys.argv[1]))
for v in d["sources"].values():
    v["content"] = strip(v["content"])
json.dump(d, open(sys.argv[2], "w"), separators=(",", ":"))
