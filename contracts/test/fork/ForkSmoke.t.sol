// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PolicyVault} from "../../src/PolicyVault.sol";
import "../../src/PolicyVaultTypes.sol";
import {IAggregatorV3, IUniswapV3PoolLike} from "../../src/interfaces/IExternal.sol";
import {DeployConfig} from "../../script/DeployConfig.sol";

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

/// @dev APRO's EACAggregatorProxy is read-access-controlled on 177 (SimpleReadAccessController, checkEnabled = true):
/// only EOAs (msg.sender == tx.origin) or addresses on the access list may call latestRoundData. A vault is a
/// contract, so APRO's controller owner must `addAccess(vault)` on mainnet. The smoke reproduces exactly that
/// with a prank of the controller owner (see ABI-NOTES.md "APRO read access").
interface IEACProxy {
    function accessController() external view returns (address);
}

interface IReadAccessController {
    function owner() external view returns (address);
    function addAccess(address user) external;
    function hasAccess(address user, bytes calldata data) external view returns (bool);
}

/// @notice Pre-deploy fork smoke (SPEC §4.4, §18.2, §21.4) against the REAL HSKSwap factory, both pools,
/// SwapRouter02 and both APRO feeds on an Anvil/forge fork of chain 177.
///
/// Opt-in (the public RPC rate-limits): FORK_SMOKE=true forge test --match-path test/fork/ForkSmoke.t.sol -vv
/// Env: HSK_RPC (default https://mainnet.hsk.xyz), FORK_BLOCK (default pinned below; 0 = latest).
/// Skips (does not fail) when FORK_SMOKE is unset or the RPC is unreachable.
contract ForkSmokeTest is Test {
    uint256 internal constant DEFAULT_FORK_BLOCK = 29_623_000;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal guardian = makeAddr("guardian");
    bool internal forkOk;

    function setUp() public {
        if (!vm.envOr("FORK_SMOKE", false)) return;
        string memory url = vm.envOr("HSK_RPC", string("https://mainnet.hsk.xyz"));
        uint256 blk = vm.envOr("FORK_BLOCK", DEFAULT_FORK_BLOCK);
        if (blk == 0) {
            try vm.createSelectFork(url) {
                forkOk = true;
            } catch {
                console2.log("fork RPC unreachable; skipping");
            }
        } else {
            try vm.createSelectFork(url, blk) {
                forkOk = true;
            } catch {
                console2.log("fork RPC unreachable; skipping");
            }
        }
    }

    modifier onlyFork() {
        if (!forkOk) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_vaultHsk() public onlyFork {
        _smoke(DeployConfig.hsk(), 18);
    }

    function test_fork_vaultBtc() public onlyFork {
        _smoke(DeployConfig.btc(), 8);
    }

    // ------------------------------------------------------------------------------------------------

    function _smoke(DeployConfig.Market memory m, uint8 d) internal {
        assertEq(block.chainid, 177, "not chain 177");
        console2.log("=== market", m.name, "block", block.number);
        (PolicyVault v, uint256 P, uint80 rid) = _deployAndFund(m, d);
        _buy(v, m);
        vm.warp(block.timestamp + 61);
        uint256 sellAmt = (5e8 * 10 ** d) / P;
        _sell(v, m, sellAmt);
        vm.warp(block.timestamp + 61);
        _exitSell(v, m, sellAmt, P, rid);
        // pause blocks
        vm.prank(guardian);
        v.pause();
        (uint8 r,,,,) = v.check(agent, _p(m.quoteToken, 5e6, 1));
        assertEq(r, ERR_PAUSED);
    }

    function _deployAndFund(DeployConfig.Market memory m, uint8 d)
        internal
        returns (PolicyVault v, uint256 P, uint80 rid)
    {
        uint256 upd;
        IReadAccessController ac;
        (P, rid, upd, ac) = _readApro(m);

        // observe([300, 0]) succeeds on the real pool
        uint32[] memory ago = new uint32[](2);
        ago[0] = 300;
        IUniswapV3PoolLike(m.pool).observe(ago);

        // constructor asserts against the real contracts
        vm.prank(owner);
        v = new PolicyVault(m.quoteToken, m.priceToken, m.oracle, m.router, m.pool, m.factory);
        assertEq(v.priceDecimals(), d);
        // without APRO access the vault sees ERR_ORACLE_INVALID ("No access" is caught by step 6)
        vm.prank(owner);
        v.setAgent(agent);
        (uint8 r0,,,,) = v.check(agent, _p(m.quoteToken, 5e6, 1));
        console2.log("  check() before APRO addAccess(vault):", r0);
        assertEq(r0, ERR_ORACLE_INVALID, "expected No access -> ORACLE_INVALID");
        _grantAprAccess(ac, address(v));
        Limits memory l = DeployConfig.defaultLimits();
        if (block.timestamp - upd > l.maxOracleAge) {
            console2.log("  NOTE: APRO older than 90000 s at this block; smoke uses maxOracleAge = 172800");
            l.maxOracleAge = 172_800;
        }
        vm.startPrank(owner);
        v.setLimits(l);
        v.setAgent(agent);
        v.setGuardian(guardian);
        vm.stopPrank();

        deal(m.quoteToken, address(v), 100e6);
        deal(m.priceToken, address(v), (20e8 * 10 ** d) / P); // ~$20 of priceToken

        (uint8 rCap,,,,) = v.check(agent, _p(m.quoteToken, 5000e6, 1));
        assertEq(rCap, ERR_TRADE_CAP, "5000 buy should be TRADE_CAP");
    }

    function _buy(PolicyVault v, DeployConfig.Market memory m) internal {
        SwapParams memory b = _p(m.quoteToken, 5e6, 0);
        (uint8 r, uint256 notional, uint256 oP, uint256 floor,) = v.check(agent, b);
        console2.log("  buy check reason (minOut 0)", r);
        assertEq(r, ERR_SLIPPAGE, "buy should pass steps 1-10");
        b.minAmountOut = floor;
        bool ex;
        (r,,,, ex) = v.check(agent, b);
        assertEq(r, OK, "buy check");
        assertFalse(ex);
        uint256 quoted = _quote(m.quoteToken, m.priceToken, 5e6);
        vm.prank(agent);
        uint256 g = gasleft();
        uint256 out = v.execute(b, keccak256("fork-smoke-buy"));
        g -= gasleft();
        console2.log("  buy: notional", notional, "oracle", oP);
        console2.log("  buy: out", out, "floor", floor);
        console2.log("  buy: quoterV2", quoted, "gas", g);
        assertGe(out, floor);
        assertEq(out, quoted, "quote vs fork execution");
        assertEq(IERC20(m.quoteToken).allowance(address(v), m.router), 0);
    }

    function _sell(PolicyVault v, DeployConfig.Market memory m, uint256 sellAmt) internal {
        SwapParams memory s = _p(m.priceToken, sellAmt, 0);
        (,,, uint256 floor,) = v.check(agent, s);
        s.minAmountOut = floor;
        (uint8 r,,,, bool ex) = v.check(agent, s);
        assertEq(r, OK, "sell check");
        assertFalse(ex);
        vm.prank(agent);
        uint256 g = gasleft();
        uint256 out = v.execute(s, keccak256("fork-smoke-sell"));
        g -= gasleft();
        console2.log("  sell: out", out, "floor", floor);
        console2.log("  sell: gas", g);
        assertGe(out, floor);
    }

    /// @dev forced deviation: oracle mocked 3% above the pool (fresh) -> buys blocked, sell takes 7b
    function _exitSell(PolicyVault v, DeployConfig.Market memory m, uint256 sellAmt, uint256 P, uint80 rid) internal {
        uint256 pUp = (P * 10_300) / 10_000;
        vm.mockCall(
            m.oracle,
            abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector),
            abi.encode(rid, int256(pUp), block.timestamp, block.timestamp, rid)
        );
        (uint8 r,,,,) = v.check(agent, _p(m.quoteToken, 5e6, type(uint256).max));
        assertEq(r, ERR_ORACLE_DEVIATION, "buy blocked under deviation");
        SwapParams memory s = _p(m.priceToken, sellAmt, 0);
        (,,, uint256 floor,) = v.check(agent, s);
        s.minAmountOut = floor;
        bool ex;
        (r,,,, ex) = v.check(agent, s);
        assertEq(r, OK, "exit sell check");
        assertTrue(ex, "exit path");
        vm.prank(agent);
        uint256 out = v.execute(s, keccak256("fork-smoke-exit"));
        console2.log("  exit sell (7b): out", out, "floor", floor);
        assertGe(out, floor);
        vm.clearMockedCalls();
    }

    function _readApro(DeployConfig.Market memory m)
        internal
        returns (uint256 P, uint80 rid, uint256 upd, IReadAccessController ac)
    {
        // APRO read access: whitelist this test contract (for logging); the vault is whitelisted after deploy
        ac = IReadAccessController(IEACProxy(m.oracle).accessController());
        console2.log("  APRO access controller", address(ac));
        _grantAprAccess(ac, address(this));
        // answeredInRound (decides the step-6 clause, SPEC Q7)
        (uint80 roundId, int256 ans,, uint256 u, uint80 air) = IAggregatorV3(m.oracle).latestRoundData();
        rid = roundId;
        upd = u;
        P = uint256(ans);
        console2.log("  APRO answer", P);
        console2.log("  APRO age (s)", block.timestamp - u);
        console2.log("  APRO answeredInRound == roundId", air == roundId);
    }

    function _grantAprAccess(IReadAccessController ac, address who) internal {
        vm.prank(ac.owner());
        ac.addAccess(who);
        assertTrue(ac.hasAccess(who, ""));
    }

    function _p(address tokenIn, uint256 amt, uint256 minOut) internal view returns (SwapParams memory) {
        return SwapParams({
            tokenIn: tokenIn,
            amountIn: amt,
            minAmountOut: minOut,
            deadline: block.timestamp + 60,
            proposalId: keccak256(abi.encode(tokenIn, amt))
        });
    }

    function _quote(address tin, address tout, uint256 amt) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(DeployConfig.QUOTER_V2).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({
                tokenIn: tin,
                tokenOut: tout,
                amountIn: amt,
                fee: 3000,
                sqrtPriceLimitX96: 0
            })
        );
    }
}
