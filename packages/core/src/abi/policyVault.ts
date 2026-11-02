// PolicyVault ABI (§4.1 IPolicyVault, §4.3 events, custom errors) — viem-compatible `as const`.
// FROZEN 04:30 IST. Lane A implements contracts/src/PolicyVault.sol to match this ABI exactly;
// any divergence is a freeze bump (see FREEZE-NOTES.md §A).

const LIMITS_COMPONENTS = [
  { name: "maxTradeUsd", type: "uint128" },
  { name: "maxEpochUsd", type: "uint128" },
  { name: "maxExposureUsd", type: "uint128" },
  { name: "epochDuration", type: "uint32" },
  { name: "maxSlippageBps", type: "uint16" },
  { name: "maxOracleDeviationBps", type: "uint16" },
  { name: "maxExitDiscountBps", type: "uint16" },
  { name: "maxOracleAge", type: "uint32" },
  { name: "cooldown", type: "uint32" },
] as const;

const SWAP_PARAMS_COMPONENTS = [
  { name: "tokenIn", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "minAmountOut", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "proposalId", type: "bytes32" },
] as const;

const addrView = <const N extends string>(name: N) =>
  ({
    type: "function",
    name,
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  }) as const;

export const policyVaultAbi = [
  // Constructor is intentionally NOT frozen (Lane A owns deploy args; FREEZE-NOTES §A3).

  // ---- owner ----
  { type: "function", name: "setAgent", stateMutability: "nonpayable", inputs: [{ name: "agent", type: "address" }], outputs: [] },
  { type: "function", name: "setGuardian", stateMutability: "nonpayable", inputs: [{ name: "guardian", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "setLimits",
    stateMutability: "nonpayable",
    inputs: [{ name: "l", type: "tuple", internalType: "struct Limits", components: LIMITS_COMPONENTS }],
    outputs: [],
  },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "transferOwnership", stateMutability: "nonpayable", inputs: [{ name: "next", type: "address" }], outputs: [] },
  { type: "function", name: "acceptOwnership", stateMutability: "nonpayable", inputs: [], outputs: [] },

  // ---- agent / guardian ----
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "p", type: "tuple", internalType: "struct SwapParams", components: SWAP_PARAMS_COMPONENTS },
      { name: "rationaleHash", type: "bytes32" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },

  // ---- views ----
  {
    type: "function",
    name: "check",
    stateMutability: "view",
    inputs: [
      { name: "caller", type: "address" },
      { name: "p", type: "tuple", internalType: "struct SwapParams", components: SWAP_PARAMS_COMPONENTS },
    ],
    outputs: [
      { name: "reason", type: "uint8" },
      { name: "notionalUsd", type: "uint256" },
      { name: "oraclePrice", type: "uint256" },
      { name: "minOutFloor", type: "uint256" },
      { name: "exitPath", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "epoch",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "index", type: "uint256" },
      { name: "start", type: "uint256" },
      { name: "spentUsd", type: "uint256" },
      { name: "capUsd", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "limits",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "tuple", internalType: "struct Limits", components: LIMITS_COMPONENTS }],
  },
  { type: "function", name: "exposureUsd", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  addrView("agent"),
  addrView("guardian"),
  addrView("owner"),
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  addrView("quoteToken"),
  addrView("priceToken"),
  { type: "function", name: "priceDecimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  addrView("oracle"),
  addrView("router"),
  addrView("pool"),
  addrView("factory"),
  // Freeze additions (FREEZE-NOTES §A2): public getters for state the spec names (§4.2 step 10, two-step ownership).
  { type: "function", name: "lastTradeAt", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  addrView("pendingOwner"),

  // ---- events (§4.3) ----
  {
    type: "event",
    name: "TradeExecuted",
    anonymous: false,
    inputs: [
      { name: "agent", type: "address", indexed: true },
      { name: "tokenIn", type: "address", indexed: true },
      { name: "tokenOut", type: "address", indexed: true },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "notionalUsd", type: "uint256", indexed: false },
      { name: "oraclePrice", type: "uint256", indexed: false },
      { name: "proposalId", type: "bytes32", indexed: false },
      { name: "rationaleHash", type: "bytes32", indexed: false },
      { name: "exitPath", type: "bool", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LimitsUpdated",
    anonymous: false,
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "limitsHash", type: "bytes32", indexed: false },
      { name: "epochIndex", type: "uint256", indexed: false },
      { name: "spentUsd", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AgentUpdated",
    anonymous: false,
    inputs: [
      { name: "previousAgent", type: "address", indexed: true },
      { name: "newAgent", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "GuardianUpdated",
    anonymous: false,
    inputs: [
      { name: "previousGuardian", type: "address", indexed: true },
      { name: "newGuardian", type: "address", indexed: true },
    ],
  },
  { type: "event", name: "Paused", anonymous: false, inputs: [{ name: "by", type: "address", indexed: true }] },
  { type: "event", name: "Unpaused", anonymous: false, inputs: [{ name: "by", type: "address", indexed: true }] },
  {
    type: "event",
    name: "Withdrawn",
    anonymous: false,
    inputs: [
      { name: "token", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferStarted",
    anonymous: false,
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    anonymous: false,
    inputs: [
      { name: "previousOwner", type: "address", indexed: true },
      { name: "newOwner", type: "address", indexed: true },
    ],
  },

  // ---- custom errors: reason codes 1–15, mirrored 1:1 on execute() (§4.1) ----
  { type: "error", name: "VaultPaused", inputs: [] }, // 1 ERR_PAUSED (cannot be `Paused`: collides with the event)
  { type: "error", name: "NotAgent", inputs: [{ name: "caller", type: "address" }] }, // 2
  { type: "error", name: "ZeroAmount", inputs: [] }, // 3
  {
    type: "error",
    name: "DeadlineExpired", // 4
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "timestamp", type: "uint256" },
    ],
  },
  { type: "error", name: "PairNotAllowed", inputs: [{ name: "tokenIn", type: "address" }] }, // 5
  {
    type: "error",
    name: "OracleInvalid", // 6 (answer/updatedAt are 0 when latestRoundData reverted)
    inputs: [
      { name: "answer", type: "int256" },
      { name: "updatedAt", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "OracleStale", // 7
    inputs: [
      { name: "updatedAt", type: "uint256" },
      { name: "maxOracleAge", type: "uint32" },
    ],
  },
  {
    type: "error",
    name: "OracleDeviation", // 8 (twap = 0 when observe() reverted)
    inputs: [
      { name: "spot", type: "uint256" },
      { name: "twap", type: "uint256" },
      { name: "oracle", type: "uint256" },
      { name: "maxOracleDeviationBps", type: "uint16" },
    ],
  },
  {
    type: "error",
    name: "TradeCap", // 9
    inputs: [
      { name: "notionalUsd", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "EpochCap", // 10
    inputs: [
      { name: "spentUsd", type: "uint256" },
      { name: "notionalUsd", type: "uint256" },
      { name: "cap", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "Cooldown", // 11
    inputs: [
      { name: "lastTradeAt", type: "uint256" },
      { name: "cooldown", type: "uint32" },
    ],
  },
  {
    type: "error",
    name: "Slippage", // 12
    inputs: [
      { name: "minAmountOut", type: "uint256" },
      { name: "minOutFloor", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientBalance", // 13
    inputs: [
      { name: "token", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "amountIn", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "Exposure", // 14 (pre-check step 13: addedUsd = deviation-grossed notional; post-check step 16: addedUsd = 0, exposureUsd = post-swap value)
    inputs: [
      { name: "exposureUsd", type: "uint256" },
      { name: "addedUsd", type: "uint256" },
      { name: "maxExposureUsd", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "ExitPrice", // 15
    inputs: [
      { name: "twap", type: "uint256" },
      { name: "oracle", type: "uint256" },
      { name: "maxExitDiscountBps", type: "uint16" },
    ],
  },

  // ---- non-reason errors ----
  { type: "error", name: "ConstructorCheck", inputs: [{ name: "which", type: "uint8" }] },
  { type: "error", name: "NotOwner", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "NotPendingOwner", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "NotPauser", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "InvalidLimits", inputs: [{ name: "field", type: "uint8" }] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "PostCondition", inputs: [{ name: "which", type: "uint8" }] },
  // OpenZeppelin v5 errors the vault can bubble up (for decoding only).
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
] as const;

export type PolicyVaultAbi = typeof policyVaultAbi;

/** ConstructorCheck(which) codes, in assertion order (§4.1 comment block). */
export const CONSTRUCTOR_CHECK = {
  FACTORY_GET_POOL: 1, // factory.getPool(quoteToken, priceToken, fee) == pool
  POOL_FACTORY: 2, // pool.factory() == factory
  POOL_ORIENTATION: 3, // token0 == priceToken && token1 == quoteToken
  PRICE_DECIMALS: 4, // priceDecimals ∈ {8, 18}
  QUOTE_DECIMALS: 5, // quoteToken.decimals() == 6
  ROUTER_FACTORY: 6, // router.factory() == factory
  ROUTER_POSITION_MANAGER: 7, // static call router.positionManager() succeeds (SwapRouter02-only)
  ORACLE_DECIMALS: 8, // oracle.decimals() == 8
  INITIAL_LIMITS: 9, // constructor limits_ out of bounds (same rules as setLimits)
} as const;

/** InvalidLimits(field) codes = 1-based index into the Limits struct. */
export const LIMITS_FIELD = {
  maxTradeUsd: 1,
  maxEpochUsd: 2,
  maxExposureUsd: 3,
  epochDuration: 4,
  maxSlippageBps: 5,
  maxOracleDeviationBps: 6,
  maxExitDiscountBps: 7,
  maxOracleAge: 8,
  cooldown: 9,
} as const;

/** PostCondition(which) codes (§4.2 step 16). */
export const POST_CONDITION = {
  TOKEN_IN_OVERSPENT: 1,
  TOKEN_OUT_BELOW_MIN: 2,
  ALLOWANCE_NOT_ZERO: 3,
} as const;
