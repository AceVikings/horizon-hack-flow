// Writes packages/core/abi/PolicyVault.abi.json from src/abi/policyVault.ts for Lane A to diff against forge output.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { policyVaultAbi } from "../src/abi/policyVault.js";

writeFileSync(fileURLToPath(new URL("../abi/PolicyVault.abi.json", import.meta.url)), JSON.stringify(policyVaultAbi, null, 2) + "\n");
