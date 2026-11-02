// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PolicyVault} from "../../src/PolicyVault.sol";
import "../../src/PolicyVaultTypes.sol";
import {TickMath} from "../../src/libraries/TickMath.sol";
import {MockERC20, MockAggregator, MockPool, MockSwapRouter02} from "../mocks/Mocks.sol";

/// @notice Fuzz handler with 6 actors: agent, guardian, owner, hostile EOA, pool manipulator, oracle mover.
/// Assertions are recorded as ghost flags (the invariant profile runs with fail_on_revert = false, so a
/// revert inside a handler would be swallowed); the invariant_ functions assert the flags are clear.
contract VaultHandler is Test {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    PolicyVault public vault;
    MockERC20 public usdt;
    MockERC20 public ptok;
    MockAggregator public oracle;
    MockPool public pool;
    MockSwapRouter02 public router;

    address public agent;
    address public guardian;
    address public owner;
    address public hostile = address(0xBAD);
    address public manipulator = address(0x1111);
    address public oracleMover = address(0x2222);

    uint256 public immutable UNIT;
    uint256 public immutable SCALE;
    int256 public immutable P0;

    // ghost flags (one per invariant) + counters
    mapping(bytes32 => bool) public violated;
    bytes32[] public violationNames;
    uint256 public okExecutes;
    uint256 public exitExecutes;
    uint256 public buyExecutes;
    uint256 public rejectedExecutes;
    uint256 public pausedRejects;
    mapping(uint8 => uint256) public reasonCount;

    constructor(
        PolicyVault v,
        MockERC20 q,
        MockERC20 p,
        MockAggregator o,
        MockPool pl,
        MockSwapRouter02 r,
        address agent_,
        address guardian_,
        address owner_,
        int256 p0
    ) {
        vault = v;
        usdt = q;
        ptok = p;
        oracle = o;
        pool = pl;
        router = r;
        agent = agent_;
        guardian = guardian_;
        owner = owner_;
        UNIT = 10 ** p.decimals();
        SCALE = UNIT * 100;
        P0 = p0;
    }

    function _flag(bytes32 name) internal {
        if (!violated[name]) {
            violated[name] = true;
            violationNames.push(name);
        }
    }

    function violationCount() external view returns (uint256) {
        return violationNames.length;
    }

    /// @dev I3: outside execute/withdraw, vault balances never decrease.
    modifier noDecrease() {
        uint256 q = usdt.balanceOf(address(vault));
        uint256 p = ptok.balanceOf(address(vault));
        _;
        if (usdt.balanceOf(address(vault)) < q || ptok.balanceOf(address(vault)) < p) _flag("I3");
    }

    // ------------------------------------------------------------------ price helpers

    function _priceFromSqrt(uint256 s) internal view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(s, s, Q96), SCALE, Q96);
    }

    function _sqrtForPrice(uint256 p8) internal view returns (uint160) {
        return uint160(Math.sqrt(Math.mulDiv(p8, 1 << 192, SCALE)));
    }

    function _tickForPrice(uint256 p8) internal view returns (int24) {
        uint160 target = _sqrtForPrice(p8);
        int24 lo = TickMath.MIN_TICK;
        int24 hi = TickMath.MAX_TICK;
        while (lo < hi) {
            int24 mid = int24((int256(lo) + int256(hi) + 1) / 2);
            if (TickMath.getSqrtPriceAtTick(mid) <= target) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /// @dev independent TWAP recomputation from the mock (floor toward -inf)
    function _twap() internal view returns (uint256) {
        int256 d = pool.cumDelta();
        int256 m = d / 300;
        if (d < 0 && d % 300 != 0) m--;
        return _priceFromSqrt(TickMath.getSqrtPriceAtTick(int24(m)));
    }

    function _oracleAnswer() internal view returns (uint256) {
        int256 a = oracle.answer();
        return a > 0 ? uint256(a) : uint256(P0);
    }

    // ------------------------------------------------------------------ agent

    struct Snap {
        uint8 r;
        uint256 notional;
        uint256 P;
        uint256 floor;
        bool exitPath;
        bool wasPaused;
        uint256 qBefore;
        uint256 pBefore;
        uint256 T;
        Limits l;
    }

    function agentTrade(bool buy, uint256 usdSeed, uint256 minOutSeed) external {
        // usually respect the cooldown, sometimes hammer it
        if (minOutSeed % 4 != 0) vm.warp(block.timestamp + 61);
        uint256 P = _oracleAnswer();
        uint256 usd8 = bound(usdSeed, 1e8, usdSeed % 5 == 0 ? 160e8 : 60e8);
        SwapParams memory p;
        p.tokenIn = buy ? address(usdt) : address(ptok);
        p.amountIn = buy ? usd8 / 100 : Math.mulDiv(usd8, UNIT, P);
        if (!buy && usdSeed % 7 != 0) {
            uint256 bal = ptok.balanceOf(address(vault));
            if (p.amountIn > bal) p.amountIn = bal / 2 + 1;
        }
        p.deadline = block.timestamp + 60;
        p.proposalId = keccak256(abi.encode(usdSeed, minOutSeed));

        Snap memory s;
        (,,, s.floor,) = vault.check(agent, p);
        // minOut: mostly the floor (+ up to 1%), sometimes below it (slippage attack), sometimes 1
        uint256 mode = minOutSeed % 10;
        if (s.floor == 0) p.minAmountOut = mode == 0 ? 0 : 1;
        else if (mode == 0) p.minAmountOut = 1;
        else if (mode == 1) p.minAmountOut = s.floor - 1;
        else p.minAmountOut = s.floor + bound(minOutSeed >> 8, 0, s.floor / 100);

        (s.r, s.notional, s.P, s.floor, s.exitPath) = vault.check(agent, p);
        reasonCount[s.r]++;
        s.wasPaused = vault.paused();
        s.qBefore = usdt.balanceOf(address(vault));
        s.pBefore = ptok.balanceOf(address(vault));
        s.T = _twap();
        s.l = vault.limits();

        vm.prank(agent);
        try vault.execute(p, keccak256("r")) returns (uint256 out) {
            _afterSuccess(p, s, out, buy);
        } catch {
            rejectedExecutes++;
            if (s.wasPaused) pausedRejects++;
        }
    }

    function _afterSuccess(SwapParams memory p, Snap memory s, uint256 out, bool buy) internal {
        okExecutes++;
        if (s.wasPaused) _flag("I6");
        if (s.r != OK) _flag("I10-check-not-ok-but-executed");

        uint256 qAfter = usdt.balanceOf(address(vault));
        uint256 pAfter = ptok.balanceOf(address(vault));
        uint256 inDelta;
        uint256 outDelta;
        if (buy) {
            buyExecutes++;
            if (qAfter > s.qBefore || pAfter < s.pBefore) {
                _flag("I3");
                return;
            }
            inDelta = s.qBefore - qAfter;
            outDelta = pAfter - s.pBefore;
        } else {
            if (pAfter > s.pBefore || qAfter < s.qBefore) {
                _flag("I3");
                return;
            }
            inDelta = s.pBefore - pAfter;
            outDelta = qAfter - s.qBefore;
        }
        // I3: tokenIn decreases by <= amountIn
        if (inDelta > p.amountIn) _flag("I3");
        // I4: tokenOut increases by >= minAmountOut >= minOutFloor
        if (outDelta != out || outDelta < p.minAmountOut || p.minAmountOut < s.floor) _flag("I4");
        // I7
        if (s.notional > s.l.maxTradeUsd) _flag("I7");
        // I1
        (,, uint256 spent, uint256 cap) = vault.epoch();
        if (spent > cap) _flag("I1");
        // I12
        if (buy && Math.mulDiv(pAfter, s.P, UNIT, Math.Rounding.Ceil) > s.l.maxExposureUsd) _flag("I12");
        // I11 (normal path): loss at oracle <= notional * (slippage + fee) / 1e4 (+1 unit)
        if (!s.exitPath) {
            uint256 valueOut = buy ? Math.mulDiv(outDelta, s.P, UNIT) : outDelta * 100;
            uint256 loss = s.notional > valueOut ? s.notional - valueOut : 0;
            uint256 maxLoss =
                Math.mulDiv(s.notional, uint256(s.l.maxSlippageBps) + pool.fee() / 100, 10_000, Math.Rounding.Ceil) + 1;
            if (loss > maxLoss) _flag("I11");
        } else {
            // I13
            exitExecutes++;
            if (buy) _flag("I13-buy");
            if (s.T < Math.mulDiv(s.P, 10_000 - s.l.maxExitDiscountBps, 10_000, Math.Rounding.Ceil)) _flag("I13-twap");
            if (pAfter > s.pBefore) _flag("I13-holdings");
            uint256 pFloor = Math.min(s.P, s.T);
            uint256 expected = Math.mulDiv(p.amountIn, pFloor, SCALE, Math.Rounding.Ceil);
            uint256 floorAtMin = Math.mulDiv(
                expected, (1e6 - uint256(pool.fee())) * (10_000 - uint256(s.l.maxSlippageBps)), 1e10, Math.Rounding.Ceil
            );
            if (outDelta < p.minAmountOut || p.minAmountOut < floorAtMin) _flag("I13-floor");
        }
    }

    function agentPause() external noDecrease {
        vm.prank(agent);
        vault.pause();
    }

    // ------------------------------------------------------------------ non-agent actors

    /// @dev I2: execute from anyone but the agent reverts (use a currently-valid trade so only the caller is wrong)
    function strangerExecute(uint256 who, uint256 usdSeed) external noDecrease {
        address[5] memory others = [guardian, owner, hostile, manipulator, oracleMover];
        address caller = others[who % 5];
        SwapParams memory p = SwapParams({
            tokenIn: address(usdt),
            amountIn: bound(usdSeed, 1e6, 100e6),
            minAmountOut: 1,
            deadline: block.timestamp + 60,
            proposalId: bytes32(0)
        });
        (,,, uint256 floor,) = vault.check(agent, p);
        if (floor > 0) p.minAmountOut = floor;
        vm.prank(caller);
        try vault.execute(p, bytes32(0)) {
            _flag("I2");
        } catch {}
    }

    /// @dev I5 under fuzz: hostile owner calls never succeed
    function hostileAdmin(uint256 which) external noDecrease {
        vm.startPrank(hostile);
        bool ok;
        uint256 w = which % 5;
        if (w == 0) {
            try vault.withdraw(address(usdt), hostile, 1) {
                ok = true;
            } catch {}
        } else if (w == 1) {
            Limits memory l = vault.limits();
            l.maxTradeUsd = type(uint128).max;
            try vault.setLimits(l) {
                ok = true;
            } catch {}
        } else if (w == 2) {
            try vault.setAgent(hostile) {
                ok = true;
            } catch {}
        } else if (w == 3) {
            try vault.unpause() {
                ok = true;
            } catch {}
        } else {
            try vault.transferOwnership(hostile) {
                ok = true;
            } catch {}
        }
        vm.stopPrank();
        if (ok) _flag("I5");
    }

    function guardianPause() external noDecrease {
        vm.prank(guardian);
        vault.pause();
    }

    function ownerUnpause() external noDecrease {
        vm.prank(owner);
        vault.unpause();
    }

    function ownerWithdraw(bool quote, uint256 amtSeed) external {
        MockERC20 t = quote ? usdt : ptok;
        uint256 bal = t.balanceOf(address(vault));
        if (bal == 0) return;
        uint256 amt = bound(amtSeed, 1, bal / 4 + 1);
        uint256 other = (quote ? ptok : usdt).balanceOf(address(vault));
        vm.prank(owner);
        vault.withdraw(address(t), owner, amt);
        if (t.balanceOf(address(vault)) != bal - amt) _flag("I3");
        if ((quote ? ptok : usdt).balanceOf(address(vault)) != other) _flag("I3");
    }

    function ownerDeposit(bool quote, uint256 usdSeed) external noDecrease {
        uint256 usd8 = bound(usdSeed, 1e8, 200e8);
        if (quote) usdt.mint(address(vault), usd8 / 100);
        else ptok.mint(address(vault), Math.mulDiv(usd8, UNIT, _oracleAnswer()));
    }

    function ownerSetLimits(uint256 seed) external noDecrease {
        Limits memory l = vault.limits();
        uint256 w = seed % 6;
        if (w == 0) l.maxTradeUsd = uint128(bound(seed >> 8, 0, 200e8));
        else if (w == 1) l.maxEpochUsd = uint128(bound(seed >> 8, 50e8, 500e8));
        else if (w == 2) l.maxExposureUsd = uint128(bound(seed >> 8, 50e8, 300e8));
        else if (w == 3) l.maxSlippageBps = uint16(bound(seed >> 8, 50, 1000));
        else if (w == 4) l.cooldown = uint32(bound(seed >> 8, 0, 300));
        else l.epochDuration = uint32(bound(seed >> 8, 3600, 86_400));
        vm.prank(owner);
        vault.setLimits(l);
    }

    // ------------------------------------------------------------------ pool manipulator

    function manipulatePool(int256 spotBps, int256 twapBps, uint256 flags) external noDecrease {
        uint256 P = _oracleAnswer();
        // mostly inside the 250 bps band, sometimes far outside (exit path / deviation)
        int256 range = flags % 4 == 0 ? int256(900) : int256(300);
        spotBps = bound(spotBps, -range, range);
        twapBps = bound(twapBps, -range, range);
        vm.startPrank(manipulator);
        pool.setSqrtPrice(_sqrtForPrice(uint256(int256(P) * (10_000 + spotBps) / 10_000)));
        pool.setMeanTick(_tickForPrice(uint256(int256(P) * (10_000 + twapBps) / 10_000)));
        pool.setObserveReverts(flags % 13 == 0);
        router.setHaircutBps(uint16(bound(flags >> 8, 0, 400)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ oracle mover

    function moveOracle(int256 bps, uint256 mode) external noDecrease {
        bps = bound(bps, -200, 200);
        int256 next = _clampAnswer(int256(_oracleAnswer()) * (10_000 + bps) / 10_000);
        uint256 m = mode % 20;
        vm.startPrank(oracleMover);
        if (m == 0) oracle.setReverts(true);
        else oracle.setReverts(false);
        if (m == 1) oracle.set(next, block.timestamp > 100_000 ? block.timestamp - 100_000 : 1); // stale
        else if (m == 2) oracle.set(0, block.timestamp); // invalid
        else oracle.setAnswer(next);
        vm.stopPrank();
    }

    function _clampAnswer(int256 a) internal view returns (int256) {
        if (a < P0 / 2) return P0 / 2;
        if (a > P0 * 2) return P0 * 2;
        return a;
    }

    function warp(uint256 secs) external noDecrease {
        vm.warp(block.timestamp + (secs % 25 == 0 ? 2 days : bound(secs, 1, 7200)));
    }
}
