// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {VaultFixture, PolicyVaultHarness} from "./utils/VaultFixture.sol";
import "../src/PolicyVaultTypes.sol";
import {SupraAggregatorAdapter} from "../src/oracles/SupraAggregatorAdapter.sol";
import {MockSupraStorage} from "./mocks/Mocks.sol";

abstract contract SupraAdapterBase is VaultFixture {
    MockSupraStorage internal store;
    SupraAggregatorAdapter internal adapter;
    PolicyVaultHarness internal sv; // vault priced by the adapter
    uint256 internal constant PAIR = 517;

    function setUp() public override {
        super.setUp();
        store = new MockSupraStorage();
        adapter = new SupraAggregatorAdapter(address(store), PAIR, "HSK/USD (Supra 517)");
        vm.startPrank(owner);
        sv = new PolicyVaultHarness(
            address(usdt), address(ptok), address(adapter), address(router), address(pool), address(factory)
        );
        sv.setLimits(defaultLimits());
        sv.setAgent(agent);
        vm.stopPrank();
        usdt.mint(address(sv), 200e6);
        ptok.mint(address(sv), amountForUsd(20e8, uint256(P0)));
    }

    function _setSupra18(uint256 p8, uint256 ageSec) internal {
        store.set(PAIR, (block.timestamp - ageSec) * 1000, 18, (block.timestamp - ageSec) * 1000 + 999, p8 * 1e10);
    }

    function test_metadata() public view {
        assertEq(adapter.decimals(), 8);
        assertEq(adapter.version(), 1);
        assertEq(adapter.description(), "HSK/USD (Supra 517)");
        assertEq(adapter.pairIndex(), PAIR);
        assertEq(address(adapter.supraStorage()), address(store));
    }

    function test_scale18_roundsDown_msToSec() public {
        store.set(PAIR, 1_793_549_000_123, 18, 1_793_549_000_999, 78_481_975_000_000_000_999_999);
        (uint80 rid, int256 a, uint256 st, uint256 up, uint80 air) = adapter.latestRoundData();
        assertEq(rid, uint80(1_793_549_000_123));
        assertEq(air, rid);
        assertEq(a, 7_848_197_500_000); // 78,481.975 in 8 dp, remainder dropped
        assertEq(up, 1_793_549_000); // ms -> s (floor)
        assertEq(st, up);
    }

    function test_scale8_identity_and_6_up() public {
        store.set(PAIR, 5, 8, 1_793_549_000_000, 8_740_500);
        (, int256 a,,,) = adapter.latestRoundData();
        assertEq(a, 8_740_500);
        store.set(PAIR, 6, 6, 1_793_549_000_000, 87_405);
        (, a,,,) = adapter.latestRoundData();
        assertEq(a, 8_740_500);
    }

    function test_futureTimestampClamped() public {
        store.set(PAIR, 7, 18, (block.timestamp + 3) * 1000, 1e17);
        (,,, uint256 up,) = adapter.latestRoundData();
        assertEq(up, block.timestamp);
    }

    function test_unpopulated_vaultOracleInvalid() public {
        (uint80 rid, int256 a,, uint256 up,) = adapter.latestRoundData();
        assertEq(rid, 0);
        assertEq(a, 0);
        assertEq(up, 0);
        assertEq(checkReasonOn(floored2(buyParams(5e6, 1))), ERR_ORACLE_INVALID);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.OracleInvalid.selector, int256(0), uint256(0)));
        sv.execute(buyParams(5e6, 1), bytes32(0));
        // dust price that rounds to 0 at 8 dp is also invalid
        store.set(PAIR, 1, 18, block.timestamp * 1000, 9_999_999_999);
        assertEq(checkReasonOn(buyParams(5e6, 1)), ERR_ORACLE_INVALID);
    }

    function test_vault_tradesOnSupra_and_stale() public {
        _setSupra18(uint256(P0), 3600);
        SwapParams memory b = floored2(buyParams(5e6, 0));
        assertEq(checkReasonOn(b), OK);
        vm.prank(agent);
        sv.execute(b, bytes32(0));
        vm.warp(block.timestamp + 61);
        SwapParams memory s = floored2(sellParams(amountForUsd(5e8, uint256(P0)), 0));
        assertEq(checkReasonOn(s), OK);
        vm.prank(agent);
        sv.execute(s, bytes32(0));
        // stale after maxOracleAge (Supra time is the push time)
        vm.warp(block.timestamp + 90_000);
        assertEq(checkReasonOn(buyParams(5e6, 1)), ERR_ORACLE_STALE);
    }

    function checkReasonOn(SwapParams memory p) internal view returns (uint8 r) {
        (r,,,,) = sv.check(agent, p);
    }

    function floored2(SwapParams memory p) internal view returns (SwapParams memory) {
        (,,, uint256 f,) = sv.check(agent, p);
        if (f > 0) p.minAmountOut = f;
        return p;
    }
}

contract SupraAdapter_WHSK18 is SupraAdapterBase {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function _p0() internal pure override returns (int256) {
        return 8_740_500;
    }
}

contract SupraAdapter_WBTC8 is SupraAdapterBase {
    function _decimals() internal pure override returns (uint8) {
        return 8;
    }

    function _p0() internal pure override returns (int256) {
        return 7_848_197_500_000;
    }
}
