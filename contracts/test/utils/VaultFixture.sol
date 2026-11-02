// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PolicyVault} from "../../src/PolicyVault.sol";
import "../../src/PolicyVaultTypes.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20, MockAggregator, MockPool, MockFactory, MockSwapRouter02} from "../mocks/Mocks.sol";

/// @notice Harness exposing internals for rounding tests. Same bytecode otherwise.
contract PolicyVaultHarness is PolicyVault {
    constructor(address q, address pt, address o, address r, address p, address f) PolicyVault(q, pt, o, r, p, f) {}

    function devBps(uint256 x, uint256 P) external pure returns (uint256) {
        return _devBps(x, P);
    }

    function priceFromSqrt(uint256 s) external view returns (uint256) {
        return _priceFromSqrt(s);
    }

    function twap() external view returns (bool, uint256) {
        return _twap();
    }

    function spot() external view returns (bool, uint256) {
        return _spot();
    }
}

/// @notice Shared fixture, parameterised by priceToken decimals (18 = WHSK shape, 8 = WBTC shape).
abstract contract VaultFixture is Test {
    uint256 internal constant Q96 = 0x1000000000000000000000000;
    uint24 internal constant FEE = 3000;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal guardian = makeAddr("guardian");
    address internal hostile = makeAddr("hostile");

    MockERC20 internal usdt;
    MockERC20 internal ptok;
    MockAggregator internal oracle;
    MockPool internal pool;
    MockFactory internal factory;
    MockSwapRouter02 internal router;
    PolicyVaultHarness internal vault;

    uint8 internal D;
    uint256 internal UNIT;
    uint256 internal SCALE;
    int256 internal P0;

    /// @dev 18 or 8
    function _decimals() internal pure virtual returns (uint8);

    /// @dev initial oracle price, 8 dp
    function _p0() internal pure virtual returns (int256);

    function setUp() public virtual {
        vm.warp(1_793_550_000);
        D = _decimals();
        UNIT = 10 ** D;
        SCALE = 10 ** (uint256(D) + 2);
        P0 = _p0();

        usdt = new MockERC20("Tether USD", "USDT", 6);
        ptok = new MockERC20(D == 18 ? "Wrapped HSK" : "Wrapped BTC", D == 18 ? "WHSK" : "WBTC", D);
        factory = new MockFactory();
        pool = new MockPool(address(ptok), address(usdt), FEE, address(factory));
        factory.setPool(address(usdt), address(ptok), FEE, address(pool));
        router = new MockSwapRouter02(address(factory), pool);
        oracle = new MockAggregator(8, P0);

        vm.prank(owner);
        vault = new PolicyVaultHarness(
            address(usdt), address(ptok), address(oracle), address(router), address(pool), address(factory)
        );
        vm.startPrank(owner);
        vault.setLimits(defaultLimits());
        vault.setAgent(agent);
        vault.setGuardian(guardian);
        vm.stopPrank();

        setPoolPrice(uint256(P0));

        // router inventory (deep liquidity)
        usdt.mint(address(router), 1e9 * 1e6);
        ptok.mint(address(router), amountForUsd(1e9 * 1e8, uint256(P0)));
        // vault seed: $200 USDT + ~$60 of priceToken
        usdt.mint(address(vault), 200e6);
        ptok.mint(address(vault), amountForUsd(60e8, uint256(P0)));
    }

    function defaultLimits() internal pure returns (Limits memory l) {
        l = Limits({
            maxTradeUsd: 100e8,
            maxEpochUsd: 250e8,
            maxExposureUsd: 150e8,
            epochDuration: 86_400,
            maxSlippageBps: 250,
            maxOracleDeviationBps: 250,
            maxExitDiscountBps: 500,
            maxOracleAge: 90_000,
            cooldown: 60
        });
    }

    // ---------------- price helpers ----------------

    function sqrtForPrice(uint256 p8) internal view returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(p8, 1 << 192, SCALE)));
    }

    function priceFromSqrt(uint256 s) internal view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(s, s, Q96), SCALE, Q96);
    }

    /// @dev largest tick whose sqrt price is <= the target sqrt price
    function tickForPrice(uint256 p8) internal view returns (int24) {
        uint160 target = sqrtForPrice(p8);
        int24 lo = TickMath.MIN_TICK;
        int24 hi = TickMath.MAX_TICK;
        while (lo < hi) {
            int24 mid = int24((int256(lo) + int256(hi) + 1) / 2);
            if (TickMath.getSqrtPriceAtTick(mid) <= target) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    function twapPriceAtTick(int24 t) internal view returns (uint256) {
        return priceFromSqrt(TickMath.getSqrtPriceAtTick(t));
    }

    function setSpot(uint256 p8) internal {
        pool.setSqrtPrice(sqrtForPrice(p8));
    }

    function setTwap(uint256 p8) internal {
        pool.setMeanTick(tickForPrice(p8));
    }

    function setPoolPrice(uint256 p8) internal {
        setSpot(p8);
        setTwap(p8);
    }

    /// @dev bps move of a price: p * (1e4 + bps) / 1e4 (bps may be negative)
    function moved(uint256 p, int256 bps) internal pure returns (uint256) {
        return uint256(int256(p) * (10_000 + bps) / 10_000);
    }

    function amountForUsd(uint256 usd8, uint256 p8) internal view returns (uint256) {
        return Math.mulDiv(usd8, UNIT, p8);
    }

    // ---------------- params ----------------

    function buyParams(uint256 usdtAmount, uint256 minOut) internal view returns (SwapParams memory) {
        return SwapParams({
            tokenIn: address(usdt),
            amountIn: usdtAmount,
            minAmountOut: minOut,
            deadline: block.timestamp + 60,
            proposalId: keccak256("proposal")
        });
    }

    function sellParams(uint256 amount, uint256 minOut) internal view returns (SwapParams memory) {
        return SwapParams({
            tokenIn: address(ptok),
            amountIn: amount,
            minAmountOut: minOut,
            deadline: block.timestamp + 60,
            proposalId: keccak256("proposal")
        });
    }

    /// @dev params with minAmountOut = the vault's floor (from check())
    function floored(SwapParams memory p) internal view returns (SwapParams memory) {
        (,,, uint256 floor,) = vault.check(agent, p);
        p.minAmountOut = floor;
        return p;
    }

    function checkReason(address caller, SwapParams memory p) internal view returns (uint8 r) {
        (r,,,,) = vault.check(caller, p);
    }

    /// @dev check() returns `code` AND execute() reverts with exactly `err` (I10 parity per reason code).
    function assertParity(address caller, SwapParams memory p, uint8 code, bytes memory err) internal {
        assertEq(checkReason(caller, p), code, "check() reason");
        vm.prank(caller);
        vm.expectRevert(err);
        vault.execute(p, keccak256("rationale"));
    }

    function exec(SwapParams memory p) internal returns (uint256 out) {
        vm.prank(agent);
        out = vault.execute(p, keccak256("rationale"));
    }

    // ---------------- reference math (spec §4.2 table) ----------------

    function refFloor(bool isBuy, uint256 amountIn, uint256 pFloor, uint16 slip) internal view returns (uint256) {
        uint256 expected = isBuy
            ? Math.mulDiv(amountIn, SCALE, pFloor, Math.Rounding.Ceil)
            : Math.mulDiv(amountIn, pFloor, SCALE, Math.Rounding.Ceil);
        return Math.mulDiv(expected, (1e6 - uint256(FEE)) * (10_000 - uint256(slip)), 1e10, Math.Rounding.Ceil);
    }
}
