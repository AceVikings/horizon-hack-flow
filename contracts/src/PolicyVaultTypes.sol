// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Mutable numeric limits (§4.1). USD values are 8 dp.
struct Limits {
    uint128 maxTradeUsd; // 8 dp; 0 = disallow
    uint128 maxEpochUsd; // 8 dp
    uint128 maxExposureUsd; // 8 dp; cap on priceToken holdings valued at oracle, enforced at every buy
    uint32 epochDuration; // seconds, > 0
    uint16 maxSlippageBps; // vs oracle-derived expected output, <= 1000
    uint16 maxOracleDeviationBps; // |pool - oracle| bound for spot AND 5-min TWAP, <= 1000
    uint16 maxExitDiscountBps; // exit path only (§4.2 step 7b); maxOracleDeviationBps <= x <= 2000
    uint32 maxOracleAge; // seconds, 300 <= x <= 172800
    uint32 cooldown; // seconds between executions
}

struct SwapParams {
    address tokenIn; // must be quoteToken or priceToken
    uint256 amountIn; // tokenIn smallest units
    uint256 minAmountOut; // tokenOut smallest units
    uint256 deadline; // enforced by the vault (SwapRouter02 has no deadline field)
    bytes32 proposalId; // = hash of the proposal's journal record (§13)
}

// Reason codes returned by check(); mirrored 1:1 by custom errors on execute().
uint8 constant OK = 0;
uint8 constant ERR_PAUSED = 1;
uint8 constant ERR_NOT_AGENT = 2;
uint8 constant ERR_ZERO_AMOUNT = 3;
uint8 constant ERR_DEADLINE = 4;
uint8 constant ERR_PAIR_NOT_ALLOWED = 5;
uint8 constant ERR_ORACLE_INVALID = 6;
uint8 constant ERR_ORACLE_STALE = 7;
uint8 constant ERR_ORACLE_DEVIATION = 8;
uint8 constant ERR_TRADE_CAP = 9;
uint8 constant ERR_EPOCH_CAP = 10;
uint8 constant ERR_COOLDOWN = 11;
uint8 constant ERR_SLIPPAGE = 12;
uint8 constant ERR_BALANCE = 13;
uint8 constant ERR_EXPOSURE = 14;
uint8 constant ERR_EXIT_PRICE = 15; // deviation failed and the exit path (step 7b) is not available

interface IPolicyVault {
    // ---- events (§4.3) ----
    event TradeExecuted(
        address indexed agent,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 notionalUsd,
        uint256 oraclePrice,
        bytes32 proposalId,
        bytes32 rationaleHash,
        bool exitPath
    );
    event LimitsUpdated(address indexed owner, bytes32 limitsHash, uint256 epochIndex, uint256 spentUsd);
    event AgentUpdated(address indexed previousAgent, address indexed newAgent);
    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---- reason-code errors 1..15 (execute) ----
    error VaultPaused(); // 1 (`Paused` collides with the event)
    error NotAgent(address caller); // 2
    error ZeroAmount(); // 3
    error DeadlineExpired(uint256 deadline, uint256 timestamp); // 4
    error PairNotAllowed(address tokenIn); // 5
    error OracleInvalid(int256 answer, uint256 updatedAt); // 6 (0,0 when latestRoundData reverted)
    error OracleStale(uint256 updatedAt, uint32 maxOracleAge); // 7
    error OracleDeviation(uint256 spot, uint256 twap, uint256 oracle, uint16 maxOracleDeviationBps); // 8
    error TradeCap(uint256 notionalUsd, uint256 cap); // 9
    error EpochCap(uint256 spentUsd, uint256 notionalUsd, uint256 cap); // 10
    error Cooldown(uint256 lastTradeAt, uint32 cooldown); // 11
    error Slippage(uint256 minAmountOut, uint256 minOutFloor); // 12
    error InsufficientBalance(address token, uint256 balance, uint256 amountIn); // 13
    error Exposure(uint256 exposureUsd, uint256 addedUsd, uint256 maxExposureUsd); // 14
    error ExitPrice(uint256 twap, uint256 oracle, uint16 maxExitDiscountBps); // 15

    // ---- non-reason errors ----
    error ConstructorCheck(uint8 which);
    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error NotPauser(address caller);
    error InvalidLimits(uint8 field);
    error ZeroAddress();
    error PostCondition(uint8 which);

    // ---- owner ----
    function setAgent(address agent) external;
    function setGuardian(address guardian) external;
    function setLimits(Limits calldata l) external;
    function unpause() external;
    function withdraw(address token, address to, uint256 amount) external;
    function transferOwnership(address next) external;
    function acceptOwnership() external;

    // ---- agent / guardian ----
    function pause() external;
    function execute(SwapParams calldata p, bytes32 rationaleHash) external returns (uint256 amountOut);

    // ---- views ----
    function check(address caller, SwapParams calldata p)
        external
        view
        returns (uint8 reason, uint256 notionalUsd, uint256 oraclePrice, uint256 minOutFloor, bool exitPath);
    function epoch() external view returns (uint256 index, uint256 start, uint256 spentUsd, uint256 capUsd);
    function limits() external view returns (Limits memory);
    function exposureUsd() external view returns (uint256);
    function agent() external view returns (address);
    function guardian() external view returns (address);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function paused() external view returns (bool);
    function lastTradeAt() external view returns (uint256);
    function quoteToken() external view returns (address);
    function priceToken() external view returns (address);
    function priceDecimals() external view returns (uint8);
    function oracle() external view returns (address);
    function router() external view returns (address);
    function pool() external view returns (address);
    function factory() external view returns (address);
}
