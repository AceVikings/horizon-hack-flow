// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {VaultFixture} from "./utils/VaultFixture.sol";
import "../src/PolicyVaultTypes.sol";
import {MockERC20} from "./mocks/Mocks.sol";

/// @notice Reason codes 1–15 in both directions, check()/execute() parity, exit path, post-conditions,
/// epochs, rounding. Runs for both priceToken shapes via the concrete contracts at the bottom.
abstract contract PolicyVaultUnitBase is VaultFixture {
    bytes32 internal constant RH = keccak256("rationale");

    // =============================================================== OK path + parity (I10)

    function test_ok_buy_parity() public {
        SwapParams memory p = floored(buyParams(5e6, 0));
        (uint8 r, uint256 notional, uint256 P, uint256 floor, bool exitPath) = vault.check(agent, p);
        assertEq(r, OK);
        assertEq(notional, 5e8);
        assertEq(P, uint256(P0));
        assertEq(floor, refFloor(true, 5e6, uint256(P0), 250));
        assertFalse(exitPath);
        // floor - 1 is rejected with the same floor (execute reports the same minOutFloor)
        SwapParams memory q = buyParams(5e6, floor - 1);
        assertParity(agent, q, ERR_SLIPPAGE, abi.encodeWithSelector(IPolicyVault.Slippage.selector, floor - 1, floor));

        uint256 balBefore = ptok.balanceOf(address(vault));
        vm.expectEmit(true, true, true, false, address(vault));
        emit IPolicyVault.TradeExecuted(agent, address(usdt), address(ptok), 5e6, 0, 5e8, P, p.proposalId, RH, false);
        uint256 out = exec(p);
        assertGe(out, floor);
        assertEq(ptok.balanceOf(address(vault)) - balBefore, out);
        assertEq(router.lastRecipient(), address(vault));
        assertEq(usdt.allowance(address(vault), address(router)), 0);
        (, , uint256 spent,) = vault.epoch();
        assertEq(spent, 5e8);
        assertEq(vault.lastTradeAt(), block.timestamp);
    }

    function test_ok_sell_parity() public {
        uint256 amt = amountForUsd(5e8, uint256(P0));
        SwapParams memory p = floored(sellParams(amt, 0));
        (uint8 r, uint256 notional,, uint256 floor, bool exitPath) = vault.check(agent, p);
        assertEq(r, OK);
        assertEq(notional, Math.mulDiv(amt, uint256(P0), UNIT, Math.Rounding.Ceil));
        assertEq(floor, refFloor(false, amt, uint256(P0), 250));
        assertFalse(exitPath);
        assertParity(
            agent,
            sellParams(amt, floor - 1),
            ERR_SLIPPAGE,
            abi.encodeWithSelector(IPolicyVault.Slippage.selector, floor - 1, floor)
        );
        uint256 out = exec(p);
        assertGe(out, floor);
        assertEq(ptok.allowance(address(vault), address(router)), 0);
    }

    function test_gas_execute() public {
        SwapParams memory p = floored(buyParams(5e6, 0));
        vm.prank(agent);
        uint256 g = gasleft();
        vault.execute(p, RH);
        g -= gasleft();
        emit log_named_uint("execute buy gas (mock)", g);
        vm.warp(block.timestamp + 61);
        SwapParams memory s = floored(sellParams(amountForUsd(5e8, uint256(P0)), 0));
        vm.prank(agent);
        g = gasleft();
        vault.execute(s, RH);
        g -= gasleft();
        emit log_named_uint("execute sell gas (mock)", g);
    }

    // =============================================================== 1 PAUSED

    function test_r1_paused_both() public {
        vm.prank(guardian);
        vault.pause();
        assertParity(agent, floored(buyParams(5e6, 0)), ERR_PAUSED, abi.encodeWithSelector(IPolicyVault.VaultPaused.selector));
        assertParity(agent, sellParams(1e6, 1), ERR_PAUSED, abi.encodeWithSelector(IPolicyVault.VaultPaused.selector));
        // paused beats not-agent (order)
        assertParity(hostile, sellParams(0, 0), ERR_PAUSED, abi.encodeWithSelector(IPolicyVault.VaultPaused.selector));
        vm.prank(owner);
        vault.unpause();
        exec(floored(buyParams(5e6, 0)));
    }

    // =============================================================== 2 NOT_AGENT

    function test_r2_notAgent_both() public {
        address[3] memory others = [owner, guardian, hostile];
        for (uint256 i; i < 3; i++) {
            bytes memory err = abi.encodeWithSelector(IPolicyVault.NotAgent.selector, others[i]);
            assertParity(others[i], floored(buyParams(5e6, 0)), ERR_NOT_AGENT, err);
            assertParity(others[i], floored(sellParams(amountForUsd(5e8, uint256(P0)), 0)), ERR_NOT_AGENT, err);
        }
    }

    // =============================================================== 3 ZERO_AMOUNT

    function test_r3_zeroAmount_both() public {
        bytes memory err = abi.encodeWithSelector(IPolicyVault.ZeroAmount.selector);
        assertParity(agent, buyParams(0, 0), ERR_ZERO_AMOUNT, err);
        assertParity(agent, sellParams(0, 0), ERR_ZERO_AMOUNT, err);
    }

    // =============================================================== 4 DEADLINE

    function test_r4_deadline_both() public {
        SwapParams memory b = floored(buyParams(5e6, 0));
        SwapParams memory s = floored(sellParams(amountForUsd(5e8, uint256(P0)), 0));
        b.deadline = block.timestamp - 1;
        s.deadline = block.timestamp - 1;
        bytes memory err = abi.encodeWithSelector(IPolicyVault.DeadlineExpired.selector, block.timestamp - 1, block.timestamp);
        assertParity(agent, b, ERR_DEADLINE, err);
        assertParity(agent, s, ERR_DEADLINE, err);
        // deadline == now is still valid
        b.deadline = block.timestamp;
        assertEq(checkReason(agent, b), OK);
    }

    // =============================================================== 5 PAIR_NOT_ALLOWED

    function test_r5_pairNotAllowed() public {
        MockERC20 fake = new MockERC20("Fake", "FAKE", 18);
        fake.mint(address(vault), 1e24);
        SwapParams memory p = buyParams(5e6, 1);
        p.tokenIn = address(fake);
        assertParity(agent, p, ERR_PAIR_NOT_ALLOWED, abi.encodeWithSelector(IPolicyVault.PairNotAllowed.selector, address(fake)));
    }

    // =============================================================== 6 ORACLE_INVALID

    function _assertOracleInvalidBoth(int256 a, uint256 u) internal {
        bytes memory err = abi.encodeWithSelector(IPolicyVault.OracleInvalid.selector, a, u);
        assertParity(agent, buyParams(5e6, 1e30), ERR_ORACLE_INVALID, err);
        assertParity(agent, sellParams(amountForUsd(5e8, uint256(P0)), 1e30), ERR_ORACLE_INVALID, err);
    }

    function test_r6_oracleInvalid_revert() public {
        oracle.setReverts(true);
        _assertOracleInvalidBoth(0, 0);
    }

    function test_r6_oracleInvalid_zeroAnswer() public {
        oracle.set(0, block.timestamp);
        _assertOracleInvalidBoth(0, block.timestamp);
    }

    function test_r6_oracleInvalid_negativeAnswer() public {
        oracle.set(-1, block.timestamp);
        _assertOracleInvalidBoth(-1, block.timestamp);
    }

    function test_r6_oracleInvalid_zeroUpdatedAt() public {
        oracle.set(P0, 0);
        _assertOracleInvalidBoth(P0, 0);
    }

    function test_r6_oracleInvalid_futureUpdatedAt() public {
        oracle.set(P0, block.timestamp + 1);
        _assertOracleInvalidBoth(P0, block.timestamp + 1);
    }

    function test_r6_oracleInvalid_answeredInRound() public {
        oracle.setRounds(5, 4);
        _assertOracleInvalidBoth(P0, block.timestamp);
    }

    // =============================================================== 7 ORACLE_STALE

    function test_r7_oracleStale_both() public {
        uint256 u = block.timestamp;
        vm.warp(u + 90_000); // exactly maxOracleAge: still fresh
        assertEq(checkReason(agent, floored(buyParams(5e6, 0))), OK);
        vm.warp(u + 90_001);
        bytes memory err = abi.encodeWithSelector(IPolicyVault.OracleStale.selector, u, uint32(90_000));
        assertParity(agent, buyParams(5e6, 1), ERR_ORACLE_STALE, err);
        assertParity(agent, sellParams(1e6, 1), ERR_ORACLE_STALE, err);
    }

    // =============================================================== 8 ORACLE_DEVIATION

    function test_r8_deviation_buy_spot() public {
        uint256 P = uint256(P0);
        setSpot(moved(P, 300));
        (, uint256 S) = vault.spot();
        (, uint256 T) = vault.twap();
        assertParity(
            agent,
            buyParams(5e6, 1),
            ERR_ORACLE_DEVIATION,
            abi.encodeWithSelector(IPolicyVault.OracleDeviation.selector, S, T, P, uint16(250))
        );
    }

    function test_r8_deviation_buy_twap() public {
        uint256 P = uint256(P0);
        setTwap(moved(P, -300));
        (, uint256 S) = vault.spot();
        (, uint256 T) = vault.twap();
        assertParity(
            agent,
            buyParams(5e6, 1),
            ERR_ORACLE_DEVIATION,
            abi.encodeWithSelector(IPolicyVault.OracleDeviation.selector, S, T, P, uint16(250))
        );
    }

    function test_r8_deviation_observeReverts_both() public {
        uint256 P = uint256(P0);
        pool.setObserveReverts(true);
        (, uint256 S) = vault.spot();
        bytes memory err = abi.encodeWithSelector(IPolicyVault.OracleDeviation.selector, S, 0, P, uint16(250));
        assertParity(agent, buyParams(5e6, 1), ERR_ORACLE_DEVIATION, err);
        // a sell cannot take the exit path without a TWAP
        assertParity(agent, sellParams(amountForUsd(5e8, P), 1), ERR_ORACLE_DEVIATION, err);
    }

    function test_r8_deviation_boundary() public {
        // exactly at the bound passes; one bps beyond fails (deviation rounds up)
        uint256 P = uint256(P0);
        (, uint256 T) = vault.twap();
        uint256 sAt = vault.priceFromSqrt(sqrtForPrice(moved(P, 249)));
        assertLe(vault.devBps(sAt, P), 250);
        setSpot(moved(P, 249));
        assertEq(checkReason(agent, floored(buyParams(5e6, 0))), OK);
        setSpot(moved(P, 251));
        (, uint256 S) = vault.spot();
        assertGt(vault.devBps(S, P), 250);
        assertParity(
            agent,
            buyParams(5e6, 1),
            ERR_ORACLE_DEVIATION,
            abi.encodeWithSelector(IPolicyVault.OracleDeviation.selector, S, T, P, uint16(250))
        );
    }

    // =============================================================== 9 TRADE_CAP

    function test_r9_tradeCap_both() public {
        assertParity(agent, buyParams(5000e6, 1), ERR_TRADE_CAP, abi.encodeWithSelector(IPolicyVault.TradeCap.selector, 5000e8, 100e8));
        // exactly the cap is fine
        usdt.mint(address(vault), 1000e6);
        assertEq(checkReason(agent, buyParams(100e6, 0)), ERR_SLIPPAGE); // passed steps 8–10
        uint256 amt = amountForUsd(150e8, uint256(P0));
        uint256 notional = Math.mulDiv(amt, uint256(P0), UNIT, Math.Rounding.Ceil);
        assertParity(agent, sellParams(amt, 1), ERR_TRADE_CAP, abi.encodeWithSelector(IPolicyVault.TradeCap.selector, notional, 100e8));
        // saturated notional for absurd sizes
        uint256 huge = uint256(type(uint128).max) + 1;
        assertParity(
            agent, sellParams(huge, 1), ERR_TRADE_CAP, abi.encodeWithSelector(IPolicyVault.TradeCap.selector, type(uint256).max, 100e8)
        );
    }

    function test_r9_tradeCap_zeroDisallows() public {
        Limits memory l = defaultLimits();
        l.maxTradeUsd = 0;
        vm.prank(owner);
        vault.setLimits(l);
        assertParity(agent, buyParams(1, 1), ERR_TRADE_CAP, abi.encodeWithSelector(IPolicyVault.TradeCap.selector, 100, 0));
    }

    // =============================================================== 10 EPOCH_CAP

    function _spend(uint256 usd8Each, uint256 n) internal {
        usdt.mint(address(vault), 1000e6);
        Limits memory l = defaultLimits();
        l.maxExposureUsd = type(uint128).max;
        vm.prank(owner);
        vault.setLimits(l);
        for (uint256 i; i < n; i++) {
            exec(floored(buyParams(usd8Each / 100, 0)));
            vm.warp(block.timestamp + 61);
            oracle.setAnswer(P0);
        }
    }

    function test_r10_epochCap_both() public {
        // align to the start of an epoch so the warps stay inside it
        vm.warp((block.timestamp / 86_400 + 1) * 86_400 + 10);
        oracle.setAnswer(P0);
        _spend(100e8, 2); // spent 200
        (, , uint256 spent,) = vault.epoch();
        assertEq(spent, 200e8);
        assertParity(
            agent,
            buyParams(60e6, 1),
            ERR_EPOCH_CAP,
            abi.encodeWithSelector(IPolicyVault.EpochCap.selector, 200e8, 60e8, 250e8)
        );
        uint256 amt = amountForUsd(60e8, uint256(P0));
        uint256 notional = Math.mulDiv(amt, uint256(P0), UNIT, Math.Rounding.Ceil);
        assertParity(
            agent, sellParams(amt, 1), ERR_EPOCH_CAP, abi.encodeWithSelector(IPolicyVault.EpochCap.selector, 200e8, notional, 250e8)
        );
        // exactly the remaining 50 is allowed
        assertEq(checkReason(agent, floored(buyParams(50e6, 0))), OK);
        // rollover resets
        vm.warp((block.timestamp / 86_400 + 1) * 86_400);
        oracle.setAnswer(P0);
        (uint256 idx, uint256 start, uint256 spent2, uint256 cap) = vault.epoch();
        assertEq(idx, block.timestamp / 86_400);
        assertEq(start, idx * 86_400);
        assertEq(spent2, 0);
        assertEq(cap, 250e8);
        assertEq(checkReason(agent, floored(buyParams(60e6, 0))), OK);
    }

    // =============================================================== 11 COOLDOWN

    function test_r11_cooldown_both() public {
        exec(floored(buyParams(5e6, 0)));
        uint256 t = block.timestamp;
        bytes memory err = abi.encodeWithSelector(IPolicyVault.Cooldown.selector, t, uint32(60));
        assertParity(agent, buyParams(5e6, 1), ERR_COOLDOWN, err);
        assertParity(agent, sellParams(amountForUsd(5e8, uint256(P0)), 1), ERR_COOLDOWN, err);
        vm.warp(t + 59);
        assertEq(checkReason(agent, floored(buyParams(5e6, 0))), ERR_COOLDOWN);
        vm.warp(t + 60);
        assertEq(checkReason(agent, floored(buyParams(5e6, 0))), OK);
    }

    // =============================================================== 12 SLIPPAGE

    function test_r12_slippage_both() public {
        uint256 fb = refFloor(true, 5e6, uint256(P0), 250);
        assertParity(agent, buyParams(5e6, 1), ERR_SLIPPAGE, abi.encodeWithSelector(IPolicyVault.Slippage.selector, 1, fb));
        uint256 amt = amountForUsd(5e8, uint256(P0));
        uint256 fs = refFloor(false, amt, uint256(P0), 250);
        assertParity(agent, sellParams(amt, 1), ERR_SLIPPAGE, abi.encodeWithSelector(IPolicyVault.Slippage.selector, 1, fs));
    }

    // =============================================================== 13 BALANCE

    function test_r13_balance_both() public {
        // buy $100 with only $200 → fine; drain first
        vm.prank(owner);
        vault.withdraw(address(usdt), owner, 196e6);
        SwapParams memory b = floored(buyParams(5e6, 0));
        assertParity(
            agent, b, ERR_BALANCE, abi.encodeWithSelector(IPolicyVault.InsufficientBalance.selector, address(usdt), 4e6, 5e6)
        );
        uint256 bal = ptok.balanceOf(address(vault));
        SwapParams memory s = floored(sellParams(bal + 1, 0));
        assertParity(
            agent, s, ERR_BALANCE, abi.encodeWithSelector(IPolicyVault.InsufficientBalance.selector, address(ptok), bal, bal + 1)
        );
    }

    // =============================================================== 14 EXPOSURE

    function test_r14_exposure_buy_precheck() public {
        // holdings ~$60; a $95 buy adds 95/0.975 = 97.44 → > 150
        usdt.mint(address(vault), 1000e6);
        uint256 cur = vault.exposureUsd();
        uint256 added = Math.mulDiv(95e8, 10_000, 9_750, Math.Rounding.Ceil);
        assertGt(cur + added, 150e8);
        assertParity(
            agent,
            floored(buyParams(95e6, 0)),
            ERR_EXPOSURE,
            abi.encodeWithSelector(IPolicyVault.Exposure.selector, cur, added, 150e8)
        );
        // a smaller one passes
        assertEq(checkReason(agent, floored(buyParams(80e6, 0))), OK);
    }

    function test_r14_exposure_postcheck() public {
        // pre-check passes, a misbehaving router over-delivers → post-swap Exposure(post, 0, cap)
        router.setBonusOut(amountForUsd(100e8, uint256(P0)));
        SwapParams memory p = floored(buyParams(5e6, 0));
        assertEq(checkReason(agent, p), OK);
        vm.prank(agent);
        vm.expectPartialRevert(IPolicyVault.Exposure.selector);
        vault.execute(p, RH);
    }

    function test_r14_sellsNeverBlockedByExposure() public {
        ptok.mint(address(vault), amountForUsd(500e8, uint256(P0))); // holdings ~$560 > cap
        assertGt(vault.exposureUsd(), 150e8);
        SwapParams memory s = floored(sellParams(amountForUsd(50e8, uint256(P0)), 0));
        assertEq(checkReason(agent, s), OK);
        exec(s);
    }

    // =============================================================== 15 EXIT_PRICE + exit path (7b)

    function test_r15_exitPrice() public {
        uint256 P = uint256(P0);
        setPoolPrice(moved(P, -600)); // TWAP 6% below oracle > 5% exit discount
        (, uint256 T) = vault.twap();
        uint256 amt = amountForUsd(5e8, P);
        assertParity(
            agent, sellParams(amt, 1), ERR_EXIT_PRICE, abi.encodeWithSelector(IPolicyVault.ExitPrice.selector, T, P, uint16(500))
        );
        // the same market blocks a buy with DEVIATION (buys never take 7b)
        assertEq(checkReason(agent, buyParams(5e6, 1)), ERR_ORACLE_DEVIATION);
    }

    struct CheckRes {
        uint8 r;
        uint256 notional;
        uint256 P;
        uint256 floor;
        bool exitPath;
    }

    function _check(SwapParams memory s) internal view returns (CheckRes memory c) {
        (c.r, c.notional, c.P, c.floor, c.exitPath) = vault.check(agent, s);
    }

    function test_exit_twapBelowOracle_floorAtTwap() public {
        uint256 P = uint256(P0);
        setPoolPrice(moved(P, -400)); // T < P, within 500 bps discount
        (, uint256 T) = vault.twap();
        assertLt(T, P);
        SwapParams memory s = sellParams(amountForUsd(5e8, P), 0);
        CheckRes memory c = _check(s);
        assertEq(c.r, ERR_SLIPPAGE);
        assertTrue(c.exitPath);
        assertEq(c.P, P);
        assertEq(c.floor, refFloor(false, s.amountIn, T, 250)); // Pfloor = min(P, T) = T
        assertEq(c.notional, Math.mulDiv(s.amountIn, P, UNIT, Math.Rounding.Ceil)); // Pcap = max = P
        s.minAmountOut = c.floor;
        uint256 pBefore = ptok.balanceOf(address(vault));
        vm.expectEmit(true, true, true, false, address(vault));
        emit IPolicyVault.TradeExecuted(
            agent, address(ptok), address(usdt), s.amountIn, 0, c.notional, P, s.proposalId, RH, true
        );
        assertGe(exec(s), c.floor);
        assertLt(ptok.balanceOf(address(vault)), pBefore); // I13 holdings do not increase
        // buy in the same market is blocked
        vm.warp(block.timestamp + 61);
        oracle.setAnswer(P0);
        assertEq(checkReason(agent, floored(buyParams(5e6, 0))), ERR_ORACLE_DEVIATION);
    }

    function test_exit_twapAboveOracle_floorAtOracle() public {
        uint256 P = uint256(P0);
        setPoolPrice(moved(P, 400)); // T > P (oracle lagging a rally)
        (, uint256 T) = vault.twap();
        assertGt(T, P);
        uint256 amt = amountForUsd(5e8, P);
        SwapParams memory s = sellParams(amt, 0);
        (uint8 r, uint256 notional,, uint256 floor, bool exitPath) = vault.check(agent, s);
        assertEq(r, ERR_SLIPPAGE);
        assertTrue(exitPath);
        assertEq(floor, refFloor(false, amt, P, 250)); // Pfloor = P
        assertEq(notional, Math.mulDiv(amt, T, UNIT, Math.Rounding.Ceil)); // Pcap = T
        s.minAmountOut = floor;
        assertGe(exec(s), floor);
    }

    function test_exit_spotOnlyDeviation_sellTakesExit() public {
        uint256 P = uint256(P0);
        setSpot(moved(P, 300)); // spot 3% above (beyond the bound), TWAP still at P
        SwapParams memory s = floored(sellParams(amountForUsd(5e8, P), 0));
        (uint8 r,,,, bool exitPath) = vault.check(agent, s);
        assertEq(r, OK);
        assertTrue(exitPath);
        exec(s);
    }

    function test_exit_boundary() public {
        uint256 P = uint256(P0);
        uint256 threshold = Math.mulDiv(P, 9_500, 10_000, Math.Rounding.Ceil);
        // find a tick whose TWAP sits at/just above the threshold, and one just below
        int24 t = tickForPrice(threshold);
        if (twapPriceAtTick(t) < threshold) t += 1;
        setSpot(moved(P, -500));
        pool.setMeanTick(t);
        assertTrue(_exitPathOf(sellParams(amountForUsd(5e8, P), 0)));
        pool.setMeanTick(t - 1);
        assertEq(checkReason(agent, sellParams(amountForUsd(5e8, P), 0)), ERR_EXIT_PRICE);
    }

    function _exitPathOf(SwapParams memory s) internal view returns (bool e) {
        (,,,, e) = vault.check(agent, s);
    }

    // =============================================================== post-conditions (step 16)

    function test_post_tokenInRefund_reverts() public {
        router.setRefundIn(true);
        SwapParams memory p = floored(buyParams(5e6, 0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.PostCondition.selector, uint8(1)));
        vault.execute(p, RH);
    }

    function test_post_outputDiverted_reverts() public {
        router.setSendElsewhere(true);
        router.setIgnoreMinOut(true);
        SwapParams memory p = floored(buyParams(5e6, 0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.PostCondition.selector, uint8(2)));
        vault.execute(p, RH);
    }

    function test_post_underDelivery_reverts() public {
        router.setHaircutBps(500); // 5% worse than spot: below the 2.5% floor
        router.setIgnoreMinOut(true);
        SwapParams memory p = floored(sellParams(amountForUsd(5e8, uint256(P0)), 0));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.PostCondition.selector, uint8(2)));
        vault.execute(p, RH);
    }

    function test_post_pullLess_ok_measuredDelta() public {
        SwapParams memory p = floored(sellParams(amountForUsd(5e8, uint256(P0)), 0));
        uint256 less = p.amountIn / 1000;
        router.setPullLess(less); // SwapRouter02 paying WETH9 from its own balance: tokenIn decreases by less
        uint256 before = ptok.balanceOf(address(vault));
        exec(p);
        assertEq(before - ptok.balanceOf(address(vault)), p.amountIn - less);
    }

    function test_reentrancy_blocked() public {
        SwapParams memory p = floored(buyParams(5e6, 0));
        router.setReenter(abi.encodeCall(IPolicyVault.execute, (p, RH)));
        vm.prank(agent);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.execute(p, RH);
    }

    // =============================================================== rounding

    function test_rounding_devBpsUp() public view {
        uint256 P = uint256(P0);
        assertEq(vault.devBps(P, P), 0);
        assertEq(vault.devBps(P + 1, P), 1);
        assertEq(vault.devBps(P - 1, P), 1);
        assertEq(vault.devBps(P * 2, P), 10_000);
    }

    function test_rounding_notionalAndFloorUp() public view {
        // 1 wei sell: notional ceil(P/1e18) = 1 for WHSK; floors demand >= 1
        (uint8 r, uint256 notional,, uint256 floor,) = vault.check(agent, sellParams(1, 0));
        assertEq(notional, Math.mulDiv(1, uint256(P0), UNIT, Math.Rounding.Ceil));
        assertGe(notional, 1);
        assertGe(floor, 1);
        assertEq(r, ERR_SLIPPAGE);
        (,,, uint256 fb,) = vault.check(agent, buyParams(1, 0));
        assertEq(fb, refFloor(true, 1, uint256(P0), 250));
        assertGe(fb, 1);
    }

    function test_rounding_twapMeanTickTowardNegInf() public {
        pool.setCumDelta(-301);
        (bool ok, uint256 T) = vault.twap();
        assertTrue(ok);
        assertEq(T, twapPriceAtTick(-2));
        pool.setCumDelta(-300);
        (, T) = vault.twap();
        assertEq(T, twapPriceAtTick(-1));
        pool.setCumDelta(-599);
        (, T) = vault.twap();
        assertEq(T, twapPriceAtTick(-2));
        pool.setCumDelta(301);
        (, T) = vault.twap();
        assertEq(T, twapPriceAtTick(1));
        pool.setCumDelta(599);
        (, T) = vault.twap();
        assertEq(T, twapPriceAtTick(1));
    }

    function test_exposureUsd_formulaRoundingAndReverts() public {
        uint256 bal = ptok.balanceOf(address(vault));
        assertEq(vault.exposureUsd(), Math.mulDiv(bal, uint256(P0), UNIT, Math.Rounding.Ceil));
        vm.prank(owner);
        vault.withdraw(address(ptok), owner, bal);
        assertEq(vault.exposureUsd(), 0);
        ptok.mint(address(vault), 1);
        assertEq(vault.exposureUsd(), Math.mulDiv(1, uint256(P0), UNIT, Math.Rounding.Ceil)); // rounds up
        assertGe(vault.exposureUsd(), 1);
        oracle.setReverts(true);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.OracleInvalid.selector, int256(0), uint256(0)));
        vault.exposureUsd();
        oracle.setReverts(false);
        uint256 u = block.timestamp;
        vm.warp(u + 90_001);
        vm.expectRevert(abi.encodeWithSelector(IPolicyVault.OracleStale.selector, u, uint32(90_000)));
        vault.exposureUsd();
    }

    function test_poolPrice_matchesOracleShape() public view {
        (bool ok, uint256 S) = vault.spot();
        assertTrue(ok);
        assertApproxEqRel(S, uint256(P0), 1e14); // 1 bp
    }

    // =============================================================== fuzz: parity + floor (I10, I4)

    function testFuzz_parity(uint256 usd8, bool buy, int16 spotBps, int16 twapBps, uint256 minOutSeed) public {
        usd8 = bound(usd8, 1, 200e8);
        int256 sb = int256(bound(spotBps, -800, 800));
        int256 tb = int256(bound(twapBps, -800, 800));
        uint256 P = uint256(P0);
        setSpot(moved(P, sb));
        setTwap(moved(P, tb));
        usdt.mint(address(vault), 1000e6);
        SwapParams memory p = buy ? buyParams(usd8 / 100 + 1, 0) : sellParams(amountForUsd(usd8, P) + 1, 0);
        (,,, uint256 floor,) = vault.check(agent, p);
        p.minAmountOut = floor == 0 ? 0 : bound(minOutSeed, floor - floor / 50, floor + floor / 50);
        (uint8 r,,, uint256 floor2, bool ex) = vault.check(agent, p);
        assertEq(floor2, floor);
        vm.prank(agent);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(IPolicyVault.execute, (p, RH)));
        if (r == OK) {
            // I10: the mock pool executes at spot, so the router may fail its own minOut (liquidity/price),
            // but never for a policy reason.
            if (!ok) assertEq(_reasonOf(ret), 255, "OK check but execute failed for a policy reason");
            ex; // exitPath reported identically by construction (shared _evaluate)
        } else {
            assertFalse(ok, "non-OK check but execute succeeded");
            assertEq(_reasonOf(ret), r, "error != reason");
        }
    }

    function _reasonOf(bytes memory ret) internal pure returns (uint8) {
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 32))
        }
        if (sel == IPolicyVault.VaultPaused.selector) return 1;
        if (sel == IPolicyVault.NotAgent.selector) return 2;
        if (sel == IPolicyVault.ZeroAmount.selector) return 3;
        if (sel == IPolicyVault.DeadlineExpired.selector) return 4;
        if (sel == IPolicyVault.PairNotAllowed.selector) return 5;
        if (sel == IPolicyVault.OracleInvalid.selector) return 6;
        if (sel == IPolicyVault.OracleStale.selector) return 7;
        if (sel == IPolicyVault.OracleDeviation.selector) return 8;
        if (sel == IPolicyVault.TradeCap.selector) return 9;
        if (sel == IPolicyVault.EpochCap.selector) return 10;
        if (sel == IPolicyVault.Cooldown.selector) return 11;
        if (sel == IPolicyVault.Slippage.selector) return 12;
        if (sel == IPolicyVault.InsufficientBalance.selector) return 13;
        if (sel == IPolicyVault.Exposure.selector) return 14;
        if (sel == IPolicyVault.ExitPrice.selector) return 15;
        return 255;
    }
}

contract PolicyVaultUnit_WHSK18 is PolicyVaultUnitBase {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function _p0() internal pure override returns (int256) {
        return 8_772_098; // $0.08772098
    }
}

contract PolicyVaultUnit_WBTC8 is PolicyVaultUnitBase {
    function _decimals() internal pure override returns (uint8) {
        return 8;
    }

    function _p0() internal pure override returns (int256) {
        return 7_792_502_000_000; // $77,925.02
    }

    /// @dev §4.2 worked check
    function test_workedCheck_wbtc() public view {
        uint256 P = 7_792_502_000_000;
        assertEq(Math.mulDiv(25e6, 1e10, P, Math.Rounding.Ceil), 32_083);
        uint256 back = Math.mulDiv(32_083, P, 1e8, Math.Rounding.Ceil);
        assertApproxEqRel(back, 25e8, 1e15);
        // pool price: sqrtP²/2^192 ≈ 771.4461 raw USDT per raw WBTC → 77,144.61
        uint256 sq = sqrtForPrice(7_714_461_000_000);
        assertApproxEqRel(vault.priceFromSqrt(sq), 7_714_461_000_000, 1e12);
    }
}
