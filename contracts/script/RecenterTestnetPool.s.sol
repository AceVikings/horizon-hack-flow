// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TestToken} from "../src/testnet/TestToken.sol";

interface IV3PoolLike {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

interface IAggregatorLike {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function decimals() external view returns (uint8);
}

interface ISwapRouter02Like {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

/// @notice TESTNET (chain 133) only. Nobody arbitrages the ATE test pools, so when Supra moves they drift off the
/// oracle price and normal-path vault trades revert ERR_ORACLE_DEVIATION. This swaps the pool back to the Supra
/// adapter price, using test tokens the deployer (token owner) mints for the swap. The swap stops exactly at the
/// target via sqrtPriceLimitX96; unspent input stays with the deployer.
///
/// OFFSET_BPS (signed, default 0) moves the pool to adapter * (1 + OFFSET_BPS / 10000) instead. A non-zero offset
/// stages an off-oracle pool price on purpose (a test-network condition, label it as such).
///
///   cd contracts
///   MARKET=hsk forge script script/RecenterTestnetPool.s.sol:RecenterTestnetPool \
///     --rpc-url https://testnet.hsk.xyz --private-key "$(jq -r '.[0].private_key' ~/.ate/testnet/deployer.json)" --broadcast
///
/// Env: MARKET=hsk|btc (default hsk), POOL / ADAPTER overrides, OFFSET_BPS (int, default 0).
contract RecenterTestnetPool is Script {
    address internal constant SWAP_ROUTER02 = 0xa6914E66690c6794244B5f66a09eAEbf66254237;
    // deployments/133.json
    address internal constant POOL_HSK = 0x840fa6e439F52cEa60dABec8BBB820DE80dDb542;
    address internal constant ADAPTER_HSK = 0xeCC8Fe21c7C0D39988856b6B67860bAe55A8c9A2;
    address internal constant POOL_BTC = 0x9d6A06ae873aD5d34ef13Ac8afE3BA80d1A5eF07;
    address internal constant ADAPTER_BTC = 0x9bbb840B9e1086177507D958E40668f3cEF99372;

    function run() external {
        bool btc = keccak256(bytes(vm.envOr("MARKET", string("hsk")))) == keccak256("btc");
        IV3PoolLike pool = IV3PoolLike(vm.envOr("POOL", btc ? POOL_BTC : POOL_HSK));
        IAggregatorLike adapter = IAggregatorLike(vm.envOr("ADAPTER", btc ? ADAPTER_BTC : ADAPTER_HSK));
        int256 offsetBps = vm.envOr("OFFSET_BPS", int256(0));
        require(offsetBps > -5000 && offsetBps < 5000, "OFFSET_BPS out of range");

        uint160 target = _target(pool, adapter, offsetBps);
        (uint160 cur,,,,,,) = pool.slot0();
        console2.log("pool", address(pool));
        console2.log("sqrtPriceX96 current", uint256(cur));
        console2.log("sqrtPriceX96 target ", uint256(target));
        if (cur == target) return;
        _swapTo(pool, cur > target, target);
        (uint160 after_,,,,,,) = pool.slot0();
        console2.log("sqrtPriceX96 after  ", uint256(after_));
    }

    /// @dev raw price token1/token0 = P * 10^dec1 / (10^ad * 10^dec0); sqrtPriceX96 = sqrt(raw * 2^192)
    function _target(IV3PoolLike pool, IAggregatorLike adapter, int256 offsetBps) internal view returns (uint160) {
        (, int256 answer,, uint256 updatedAt,) = adapter.latestRoundData();
        require(answer > 0, "adapter price");
        console2.log("adapter answer / updatedAt", uint256(answer), updatedAt);
        uint256 exp = uint256(adapter.decimals()) + TestToken(pool.token0()).decimals();
        uint256 ratioX192 =
            Math.mulDiv(uint256(answer) * 10 ** TestToken(pool.token1()).decimals(), 1 << 192, 10 ** exp);
        ratioX192 = Math.mulDiv(ratioX192, uint256(10_000 + offsetBps), 10_000);
        return uint160(Math.sqrt(ratioX192));
    }

    /// @dev zeroForOne sells the price token (price falls); else sells tUSDT (price rises). A full pool side of input
    /// moves a full-range pool far beyond +-50%; sqrtPriceLimitX96 stops it at the target and only the used part is
    /// pulled, the rest of the minted input stays with the sender.
    function _swapTo(IV3PoolLike pool, bool zeroForOne, uint160 target) internal {
        TestToken tin = TestToken(zeroForOne ? pool.token0() : pool.token1());
        address tout = zeroForOne ? pool.token1() : pool.token0();
        uint256 amountIn = tin.balanceOf(address(pool));
        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        tin.mint(sender, amountIn);
        tin.approve(SWAP_ROUTER02, amountIn);
        uint256 out = ISwapRouter02Like(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02Like.ExactInputSingleParams({
                tokenIn: address(tin),
                tokenOut: tout,
                fee: pool.fee(),
                recipient: sender,
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: target
            })
        );
        tin.approve(SWAP_ROUTER02, 0);
        vm.stopBroadcast();
        console2.log("swap in token / out amount", address(tin), out);
    }
}
