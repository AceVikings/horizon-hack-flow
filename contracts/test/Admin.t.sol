// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {VaultFixture} from "./utils/VaultFixture.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import "../src/PolicyVaultTypes.sol";
import {TickMath} from "../src/libraries/TickMath.sol";
import {MockERC20, MockAggregator, MockPool, MockFactory, MockSwapRouter02, MockSwapRouterV1} from "./mocks/Mocks.sol";

/// @notice I5 (owner-only per function × non-owner actors), two-step ownership, pause roles, setLimits bounds,
/// epoch semantics of setLimits, constructor checks.
contract AdminTest is VaultFixture {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function _p0() internal pure override returns (int256) {
        return 8_772_098;
    }

    // ---------------------------------------------------------------- I5

    function test_I5_ownerOnly_everyFunction_everyNonOwner() public {
        address[3] memory actors = [agent, guardian, hostile];
        Limits memory l = defaultLimits();
        l.maxTradeUsd = 1e6 * 1e8; // the rogue "setLimits(maxTradeUsd = 1e6)"
        for (uint256 i; i < actors.length; i++) {
            address a = actors[i];
            bytes memory err = abi.encodeWithSelector(IPolicyVault.NotOwner.selector, a);
            vm.startPrank(a);
            vm.expectRevert(err);
            vault.withdraw(address(usdt), a, 1);
            vm.expectRevert(err);
            vault.setLimits(l);
            vm.expectRevert(err);
            vault.setAgent(a);
            vm.expectRevert(err);
            vault.setGuardian(a);
            vm.expectRevert(err);
            vault.unpause();
            vm.expectRevert(err);
            vault.transferOwnership(a);
            vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotPendingOwner.selector, a));
            vault.acceptOwnership();
            vm.stopPrank();
        }
        assertEq(vault.owner(), owner);
        assertEq(vault.limits().maxTradeUsd, 100e8);
    }

    function test_twoStepOwnership() public {
        address next = makeAddr("next");
        vm.expectEmit(true, true, false, false, address(vault));
        emit IPolicyVault.OwnershipTransferStarted(owner, next);
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.pendingOwner(), next);
        assertEq(vault.owner(), owner); // not yet
        vm.prank(hostile);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotPendingOwner.selector, hostile));
        vault.acceptOwnership();
        vm.expectEmit(true, true, false, false, address(vault));
        emit IPolicyVault.OwnershipTransferred(owner, next);
        vm.prank(next);
        vault.acceptOwnership();
        assertEq(vault.owner(), next);
        assertEq(vault.pendingOwner(), address(0));
        // the old owner lost every power
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotOwner.selector, owner));
        vault.unpause();
        // cancel a pending transfer by pointing at zero
        vm.prank(next);
        vault.transferOwnership(address(0));
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotPendingOwner.selector, address(0)));
        vault.acceptOwnership();
    }

    // ---------------------------------------------------------------- pause roles

    function test_pause_roles() public {
        address[3] memory pausers = [owner, agent, guardian];
        for (uint256 i; i < 3; i++) {
            vm.expectEmit(true, false, false, false, address(vault));
            emit IPolicyVault.Paused(pausers[i]);
            vm.prank(pausers[i]);
            vault.pause();
            assertTrue(vault.paused());
            // only owner unpauses
            if (pausers[i] != owner) {
                vm.prank(pausers[i]);
                vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotOwner.selector, pausers[i]));
                vault.unpause();
            }
            vm.expectEmit(true, false, false, false, address(vault));
            emit IPolicyVault.Unpaused(owner);
            vm.prank(owner);
            vault.unpause();
            assertFalse(vault.paused());
        }
        vm.prank(hostile);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotPauser.selector, hostile));
        vault.pause();
    }

    function test_pause_afterAgentRotation() public {
        address newAgent = makeAddr("newAgent");
        vm.prank(owner);
        vault.setAgent(newAgent);
        vm.prank(agent); // old agent lost pause and execute
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.NotPauser.selector, agent));
        vault.pause();
        assertEq(checkReason(agent, floored(buyParams(5e6, 0))), ERR_NOT_AGENT);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_owner() public {
        address to = makeAddr("cold");
        vm.expectEmit(true, true, false, true, address(vault));
        emit IPolicyVault.Withdrawn(address(usdt), to, 50e6);
        vm.prank(owner);
        vault.withdraw(address(usdt), to, 50e6);
        assertEq(usdt.balanceOf(to), 50e6);
        vm.prank(owner);
        vm.expectRevert(IPolicyVault.ZeroAddress.selector);
        vault.withdraw(address(usdt), address(0), 1);
        // works while paused (migration)
        vm.prank(guardian);
        vault.pause();
        vm.prank(owner);
        vault.withdraw(address(ptok), to, 1);
    }

    function test_setAgent_setGuardian_events() public {
        address a2 = makeAddr("a2");
        vm.expectEmit(true, true, false, false, address(vault));
        emit IPolicyVault.AgentUpdated(agent, a2);
        vm.prank(owner);
        vault.setAgent(a2);
        assertEq(vault.agent(), a2);
        vm.expectEmit(true, true, false, false, address(vault));
        emit IPolicyVault.GuardianUpdated(guardian, a2);
        vm.prank(owner);
        vault.setGuardian(a2);
        assertEq(vault.guardian(), a2);
    }

    // ---------------------------------------------------------------- setLimits bounds (§4.1)

    function _expectInvalid(Limits memory l, uint8 field) internal {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.InvalidLimits.selector, field));
        vault.setLimits(l);
    }

    function test_setLimits_bounds() public {
        Limits memory l;
        l = defaultLimits();
        l.epochDuration = 0;
        _expectInvalid(l, 4);
        l = defaultLimits();
        l.maxSlippageBps = 1001;
        _expectInvalid(l, 5);
        l = defaultLimits();
        l.maxOracleDeviationBps = 1001;
        l.maxExitDiscountBps = 2000;
        _expectInvalid(l, 6);
        l = defaultLimits();
        l.maxExitDiscountBps = 249; // < deviation
        _expectInvalid(l, 7);
        l = defaultLimits();
        l.maxExitDiscountBps = 2001;
        _expectInvalid(l, 7);
        l = defaultLimits();
        l.maxOracleAge = 299;
        _expectInvalid(l, 8);
        l = defaultLimits();
        l.maxOracleAge = 172_801;
        _expectInvalid(l, 8);
        // edges accepted
        l = defaultLimits();
        l.maxSlippageBps = 1000;
        l.maxOracleDeviationBps = 1000;
        l.maxExitDiscountBps = 1000;
        l.maxOracleAge = 300;
        vm.prank(owner);
        vault.setLimits(l);
        l.maxExitDiscountBps = 2000;
        l.maxOracleAge = 172_800;
        vm.prank(owner);
        vault.setLimits(l);
        assertEq(vault.limits().maxExitDiscountBps, 2000);
    }

    function test_setLimits_epochSemantics() public {
        exec(floored(buyParams(5e6, 0)));
        (uint256 idx,, uint256 spent,) = vault.epoch();
        assertEq(spent, 5e8);
        // same duration: spentUsd kept, emitted
        Limits memory l = defaultLimits();
        l.maxEpochUsd = 400e8;
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPolicyVault.LimitsUpdated(owner, keccak256(abi.encode(l)), idx, 5e8);
        vm.prank(owner);
        vault.setLimits(l);
        (,, spent,) = vault.epoch();
        assertEq(spent, 5e8);
        // duration change resets spentUsd (owner-intended)
        l.epochDuration = 3600;
        vm.expectEmit(true, false, false, true, address(vault));
        emit IPolicyVault.LimitsUpdated(owner, keccak256(abi.encode(l)), block.timestamp / 3600, 0);
        vm.prank(owner);
        vault.setLimits(l);
        (,, spent,) = vault.epoch();
        assertEq(spent, 0);
    }

    function test_limits_unsetBeforeSetLimits() public {
        vm.prank(owner);
        PolicyVault v = new PolicyVault(
            address(usdt), address(ptok), address(oracle), address(router), address(pool), address(factory)
        );
        (uint256 idx, uint256 start, uint256 spent, uint256 cap) = v.epoch();
        assertEq(idx + start + spent + cap, 0);
        // no agent yet → NOT_AGENT; with agent set, maxTradeUsd = 0 disallows
        (uint8 r,,,,) = v.check(agent, buyParams(5e6, 1));
        assertEq(r, ERR_NOT_AGENT);
        vm.prank(owner);
        v.setAgent(agent);
        (r,,,,) = v.check(agent, buyParams(5e6, 1));
        assertTrue(r != OK); // all-zero limits reject every trade (age 0, deviation 0, maxTradeUsd 0)
    }

    // ---------------------------------------------------------------- views / immutables

    function test_immutables() public view {
        assertEq(vault.quoteToken(), address(usdt));
        assertEq(vault.priceToken(), address(ptok));
        assertEq(vault.priceDecimals(), 18);
        assertEq(vault.oracle(), address(oracle));
        assertEq(vault.router(), address(router));
        assertEq(vault.pool(), address(pool));
        assertEq(vault.factory(), address(factory));
        assertEq(vault.owner(), owner);
    }

    // ---------------------------------------------------------------- constructor checks

    function _deploy(address q, address p, address o, address r, address pl, address f) internal returns (PolicyVault) {
        return new PolicyVault(q, p, o, r, pl, f);
    }

    function test_ctor_zeroAddress() public {
        vm.expectRevert(IPolicyVault.ZeroAddress.selector);
        _deploy(address(0), address(ptok), address(oracle), address(router), address(pool), address(factory));
    }

    function test_ctor_1_getPoolMismatch() public {
        factory.setPool(address(usdt), address(ptok), FEE, address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(1)));
        _deploy(address(usdt), address(ptok), address(oracle), address(router), address(pool), address(factory));
    }

    function test_ctor_2_poolFactoryMismatch() public {
        MockFactory other = new MockFactory();
        MockPool p2 = new MockPool(address(ptok), address(usdt), FEE, address(other));
        factory.setPool(address(usdt), address(ptok), FEE, address(p2));
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(2)));
        _deploy(address(usdt), address(ptok), address(oracle), address(router), address(p2), address(factory));
    }

    function test_ctor_3_wrongOrientation() public {
        MockPool p2 = new MockPool(address(usdt), address(ptok), FEE, address(factory)); // token0 = USDT
        factory.setPool(address(usdt), address(ptok), FEE, address(p2));
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(3)));
        _deploy(address(usdt), address(ptok), address(oracle), address(router), address(p2), address(factory));
    }

    function test_ctor_4_priceDecimals() public {
        MockERC20 t6 = new MockERC20("X", "X", 6);
        MockPool p2 = new MockPool(address(t6), address(usdt), FEE, address(factory));
        factory.setPool(address(usdt), address(t6), FEE, address(p2));
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(4)));
        _deploy(address(usdt), address(t6), address(oracle), address(router), address(p2), address(factory));
    }

    function test_ctor_5_quoteDecimals() public {
        MockERC20 q18 = new MockERC20("Q", "Q", 18);
        MockPool p2 = new MockPool(address(ptok), address(q18), FEE, address(factory));
        factory.setPool(address(q18), address(ptok), FEE, address(p2));
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(5)));
        _deploy(address(q18), address(ptok), address(oracle), address(router), address(p2), address(factory));
    }

    function test_ctor_6_routerFactory() public {
        MockSwapRouter02 r2 = new MockSwapRouter02(address(0xBEEF), pool);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(6)));
        _deploy(address(usdt), address(ptok), address(oracle), address(r2), address(pool), address(factory));
    }

    function test_ctor_7_routerV1Rejected() public {
        MockSwapRouterV1 v1 = new MockSwapRouterV1(address(factory)); // same factory(), no positionManager()
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(7)));
        _deploy(address(usdt), address(ptok), address(oracle), address(v1), address(pool), address(factory));
    }

    function test_ctor_8_oracleDecimals() public {
        MockAggregator o18 = new MockAggregator(18, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.ConstructorCheck.selector, uint8(8)));
        _deploy(address(usdt), address(ptok), address(o18), address(router), address(pool), address(factory));
    }

    function test_ctor_8dpShapeAccepted() public {
        MockERC20 wbtc = new MockERC20("WBTC", "WBTC", 8);
        MockPool p2 = new MockPool(address(wbtc), address(usdt), FEE, address(factory));
        factory.setPool(address(usdt), address(wbtc), FEE, address(p2));
        PolicyVault v = _deploy(address(usdt), address(wbtc), address(oracle), address(router), address(p2), address(factory));
        assertEq(v.priceDecimals(), 8);
    }
}

contract TickMathTest is Test {
    function test_knownValues() public pure {
        assertEq(TickMath.getSqrtPriceAtTick(0), 1 << 96);
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.MIN_TICK), TickMath.MIN_SQRT_PRICE);
        assertEq(TickMath.getSqrtPriceAtTick(TickMath.MAX_TICK), TickMath.MAX_SQRT_PRICE);
        // Uniswap v3/v4 test vectors
        assertEq(TickMath.getSqrtPriceAtTick(1), 79232123823359799118286999568);
        assertEq(TickMath.getSqrtPriceAtTick(-1), 79224201403219477170569942574);
        assertEq(TickMath.getSqrtPriceAtTick(50), 79426470787362580746886972461);
        assertEq(TickMath.getSqrtPriceAtTick(-50), 79030349367926598376800521322);
    }

    function test_reverts_outOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(TickMath.InvalidTick.selector, int24(887273)));
        this.ext(887273);
    }

    function ext(int24 t) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(t);
    }

    function testFuzz_monotonic(int24 t) public pure {
        t = int24(bound(int256(t), int256(TickMath.MIN_TICK), int256(TickMath.MAX_TICK) - 1));
        assertLt(TickMath.getSqrtPriceAtTick(t), TickMath.getSqrtPriceAtTick(t + 1));
    }
}
