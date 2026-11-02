// EAS attestation schema for executed trades (SPEC §13). Lane E.
import { encodePacked, keccak256, zeroAddress, type Address, type Hex } from "viem";
import { EAS } from "@ate/core";

/** §13 verbatim. Field order is part of the schema UID — never reorder. */
export const TRADE_ATTESTATION_SCHEMA =
  "bytes32 proposalId,bytes32 rationaleHash,bytes32 txHash,uint256 notionalUsd,bool exitPath,string engine,string origin" as const;

/** No resolver; attestations are non-revocable (§13). */
export const TRADE_ATTESTATION_RESOLVER: Address = zeroAddress;
export const TRADE_ATTESTATION_REVOCABLE = false as const;

export const EAS_ADDRESS: Address = EAS.eas;
export const SCHEMA_REGISTRY_ADDRESS: Address = EAS.schemaRegistry;

/**
 * SchemaRegistry UID = keccak256(abi.encodePacked(schema, resolver, revocable)) — the same formula the
 * registry uses in `_getUID`, so the UID is known before the register tx is mined.
 */
export function schemaUid(
  schema: string = TRADE_ATTESTATION_SCHEMA,
  resolver: Address = TRADE_ATTESTATION_RESOLVER,
  revocable: boolean = TRADE_ATTESTATION_REVOCABLE,
): Hex {
  return keccak256(encodePacked(["string", "address", "bool"], [schema, resolver, revocable]));
}

export const TRADE_ATTESTATION_SCHEMA_UID: Hex = schemaUid();

/** Minimal EAS + SchemaRegistry ABIs (predeploys on OP-stack chains, incl. HashKey Chain 177). */
export const easAbi = [
  {
    type: "function",
    name: "attest",
    stateMutability: "payable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "schema", type: "bytes32" },
          {
            name: "data",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expirationTime", type: "uint64" },
              { name: "revocable", type: "bool" },
              { name: "refUID", type: "bytes32" },
              { name: "data", type: "bytes" },
              { name: "value", type: "uint256" },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getAttestation",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "schema", type: "bytes32" },
          { name: "time", type: "uint64" },
          { name: "expirationTime", type: "uint64" },
          { name: "revocationTime", type: "uint64" },
          { name: "refUID", type: "bytes32" },
          { name: "recipient", type: "address" },
          { name: "attester", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Attested",
    inputs: [
      { name: "recipient", type: "address", indexed: true },
      { name: "attester", type: "address", indexed: true },
      { name: "uid", type: "bytes32", indexed: false },
      { name: "schemaUID", type: "bytes32", indexed: true },
    ],
  },
] as const;

export const schemaRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schema", type: "string" },
      { name: "resolver", type: "address" },
      { name: "revocable", type: "bool" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getSchema",
    stateMutability: "view",
    inputs: [{ name: "uid", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "uid", type: "bytes32", indexed: true },
      { name: "registerer", type: "address", indexed: true },
      {
        name: "schema",
        type: "tuple",
        indexed: false,
        components: [
          { name: "uid", type: "bytes32" },
          { name: "resolver", type: "address" },
          { name: "revocable", type: "bool" },
          { name: "schema", type: "string" },
        ],
      },
    ],
  },
] as const;
