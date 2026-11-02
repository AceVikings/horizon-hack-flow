// Register the §13 trade-attestation schema on the EAS SchemaRegistry predeploy (chain 177, §19 step 2).
//
// This script never holds a key. It prints the deterministic schema UID, the calldata and the exact
// `cast send` command for ops-1 to sign (Ledger or keystore on the second device), and — with --rpc —
// reads `getSchema(uid)` to report whether the schema is already registered.
//
//   pnpm --filter @ate/journal attest:register-schema [--rpc https://mainnet.hsk.xyz] [--json]
import { createPublicClient, http, zeroHash } from "viem";
import {
  SCHEMA_REGISTRY_ADDRESS,
  TRADE_ATTESTATION_RESOLVER,
  TRADE_ATTESTATION_REVOCABLE,
  TRADE_ATTESTATION_SCHEMA,
  schemaRegistryAbi,
} from "./schema.js";
import { buildRegisterSchemaTx } from "./attester.js";

async function main(argv: string[]): Promise<void> {
  const rpcIdx = argv.indexOf("--rpc");
  const rpc = rpcIdx >= 0 ? argv[rpcIdx + 1] : undefined;
  const tx = buildRegisterSchemaTx();
  let registered: boolean | undefined;
  if (rpc) {
    const client = createPublicClient({ transport: http(rpc) });
    const chainId = await client.getChainId();
    if (chainId !== 177) throw new Error(`expected chain 177, RPC reports ${chainId}`);
    const rec = await client.readContract({
      address: SCHEMA_REGISTRY_ADDRESS,
      abi: schemaRegistryAbi,
      functionName: "getSchema",
      args: [tx.expectedUid],
    });
    registered = rec.uid !== zeroHash;
  }
  const cast = [
    "cast send",
    SCHEMA_REGISTRY_ADDRESS,
    `'register(string,address,bool)'`,
    `'${TRADE_ATTESTATION_SCHEMA}'`,
    TRADE_ATTESTATION_RESOLVER,
    String(TRADE_ATTESTATION_REVOCABLE),
    "--rpc-url $HSK_RPC --ledger   # or --account owner (keystore), second device only",
  ].join(" ");
  const out = {
    schema: TRADE_ATTESTATION_SCHEMA,
    schemaUid: tx.expectedUid,
    registry: SCHEMA_REGISTRY_ADDRESS,
    calldata: tx.data,
    registered,
    cast,
    pin: `deployments/177.json → "eas": { "address": "0x4200000000000000000000000000000000000021", "schemaUid": "${tx.expectedUid}" }`,
  };
  if (argv.includes("--json")) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`schema     ${out.schema}`);
  console.log(`schemaUid  ${out.schemaUid}`);
  if (registered !== undefined) console.log(`registered ${registered ? "yes (nothing to do)" : "no"}`);
  console.log(`\n${cast}\n`);
  console.log(`then pin: ${out.pin}`);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
