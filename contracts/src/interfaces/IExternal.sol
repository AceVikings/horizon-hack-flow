// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Chainlink-compatible aggregator (APRO push feeds on HashKey Chain 177).
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @notice The subset of a Uniswap-V3-style pool the vault reads. `slot0` is read with a raw staticcall
/// (first word only) so a fork with a wider `feeProtocol` field still decodes.
interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function factory() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

/// @notice SwapRouter02 (`IV3SwapRouter`): 7-field struct, NO deadline (§6.2). Selector 0x04e45aaf.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
    function factory() external view returns (address);
    function positionManager() external view returns (address);
}
