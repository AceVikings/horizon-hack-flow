export const poolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint128" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
] as const;

export const aggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

/** Supra DORA storage (SValueFeed): getSvalue(pairIndex) → (round, decimals, time ms, price). Read 10:30 IST Nov 2: pair 0 = BTC_USDT. */
export const supraAbi = [
  {
    type: "function",
    name: "getSvalue",
    stateMutability: "view",
    inputs: [{ name: "_pairIndex", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "round", type: "uint256" },
          { name: "decimals", type: "uint256" },
          { name: "time", type: "uint256" },
          { name: "price", type: "uint256" },
        ],
      },
    ],
  },
] as const;

export const multicall3Abi = [
  { type: "function", name: "getCurrentBlockTimestamp", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getBlockNumber", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
