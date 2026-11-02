// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {TickMath} from "./libraries/TickMath.sol";
import {IAggregatorV3, IUniswapV3PoolLike, IUniswapV3FactoryLike, ISwapRouter02} from "./interfaces/IExternal.sol";
import "./PolicyVaultTypes.sol";

/// @title PolicyVault — ATE bounded-autonomy trading vault (SPEC v0.8.0 §4)
/// @notice One vault per market per agent. Pair, oracle, pool, router and factory are immutable; only numeric
/// limits are mutable. The agent may trade only through `execute`, inside the limits, and only via the fixed
/// pool with `recipient = address(this)`. Value leaves the vault only via owner `withdraw`.
contract PolicyVault is IPolicyVault, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant Q96 = 0x1000000000000000000000000;
    uint32 private constant TWAP_WINDOW = 300;
    uint256 private constant BPS = 10_000;

    // ---- immutables (§4.1) ----
    address public immutable quoteToken;
    address public immutable priceToken;
    address public immutable oracle;
    address public immutable router;
    address public immutable pool;
    address public immutable factory;
    uint8 public immutable priceDecimals;
    uint24 private immutable _fee; // hundredths of a bip, read once from pool.fee()
    uint256 private immutable _scale; // 10^(d+2)
    uint256 private immutable _unit; // 10^d

    // ---- roles ----
    address public owner;
    address public pendingOwner;
    address private _agent;
    address private _guardian;
    bool public paused;

    // ---- policy state ----
    Limits private _limits;
    uint256 private _epochIndex;
    uint256 private _spentUsd;
    uint256 public lastTradeAt;

    /// @dev Result of the shared step 1–13 evaluation. `ctx*` carry custom-error context.
    struct Eval {
        uint8 reason;
        bool exitPath;
        bool isBuy;
        address tokenOut;
        uint256 notionalUsd;
        uint256 oraclePrice;
        uint256 minOutFloor;
        uint256 epochIndex;
        uint256 spentUsd; // effective spent in the current index, before this trade
        uint256 ctx0;
        uint256 ctx1;
        uint256 ctx2;
        int256 answer;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @param quoteToken_ USD-stable token1 (USDT, 6 dp)
    /// @param priceToken_ token0 priced by the oracle (WHSK 18 dp / WBTC 8 dp)
    /// @param oracle_ AggregatorV3 feed, 8 dp
    /// @param router_ SwapRouter02 (7-field exactInputSingle)
    /// @param pool_ the V3 pool priceToken/quoteToken
    /// @param factory_ the V3 factory of `pool_` and `router_`
    constructor(
        address quoteToken_,
        address priceToken_,
        address oracle_,
        address router_,
        address pool_,
        address factory_
    ) {
        if (
            quoteToken_ == address(0) || priceToken_ == address(0) || oracle_ == address(0) || router_ == address(0)
                || pool_ == address(0) || factory_ == address(0)
        ) revert ZeroAddress();

        uint24 fee_ = IUniswapV3PoolLike(pool_).fee();
        if (IUniswapV3FactoryLike(factory_).getPool(quoteToken_, priceToken_, fee_) != pool_) revert ConstructorCheck(1);
        if (IUniswapV3PoolLike(pool_).factory() != factory_) revert ConstructorCheck(2);
        if (IUniswapV3PoolLike(pool_).token0() != priceToken_ || IUniswapV3PoolLike(pool_).token1() != quoteToken_) {
            revert ConstructorCheck(3);
        }
        uint8 d = IERC20Metadata(priceToken_).decimals();
        if (d != 8 && d != 18) revert ConstructorCheck(4);
        if (IERC20Metadata(quoteToken_).decimals() != 6) revert ConstructorCheck(5);
        if (ISwapRouter02(router_).factory() != factory_) revert ConstructorCheck(6);
        (bool pmOk, bytes memory pmData) =
            router_.staticcall(abi.encodeWithSelector(ISwapRouter02.positionManager.selector));
        if (!pmOk || pmData.length < 32) revert ConstructorCheck(7);
        if (IAggregatorV3(oracle_).decimals() != 8) revert ConstructorCheck(8);

        quoteToken = quoteToken_;
        priceToken = priceToken_;
        oracle = oracle_;
        router = router_;
        pool = pool_;
        factory = factory_;
        priceDecimals = d;
        _fee = fee_;
        _unit = 10 ** d;
        _scale = 10 ** (uint256(d) + 2);

        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // =========================================================================================================
    // owner
    // =========================================================================================================

    function setAgent(address agent) external onlyOwner {
        emit AgentUpdated(_agent, agent);
        _agent = agent;
    }

    function setGuardian(address guardian) external onlyOwner {
        emit GuardianUpdated(_guardian, guardian);
        _guardian = guardian;
    }

    /// @notice Reverts `InvalidLimits(field)` (1-based struct index) on out-of-bounds values (§4.1, §4.5).
    /// Does not reset `spentUsd` for the current epoch index unless `epochDuration` changes (§4.2 Epochs).
    function setLimits(Limits calldata l) external onlyOwner {
        if (l.epochDuration == 0) revert InvalidLimits(4);
        if (l.maxSlippageBps > 1000) revert InvalidLimits(5);
        if (l.maxOracleDeviationBps > 1000) revert InvalidLimits(6);
        if (l.maxExitDiscountBps < l.maxOracleDeviationBps || l.maxExitDiscountBps > 2000) revert InvalidLimits(7);
        if (l.maxOracleAge < 300 || l.maxOracleAge > 172_800) revert InvalidLimits(8);

        bool durationChanged = l.epochDuration != _limits.epochDuration;
        uint256 newIndex = block.timestamp / l.epochDuration;
        if (durationChanged || newIndex != _epochIndex) {
            // Roll to the index of the new duration. Same duration + same index keeps spentUsd.
            _spentUsd = 0;
            _epochIndex = newIndex;
        }
        _limits = l;
        emit LimitsUpdated(msg.sender, keccak256(abi.encode(l)), _epochIndex, _spentUsd);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner(msg.sender);
        address prev = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, msg.sender);
    }

    // =========================================================================================================
    // agent / guardian
    // =========================================================================================================

    /// @notice Fail-safe: owner, agent or guardian may pause; only the owner may unpause.
    function pause() external {
        if (msg.sender != owner && msg.sender != _agent && msg.sender != _guardian) revert NotPauser(msg.sender);
        paused = true;
        emit Paused(msg.sender);
    }

    /// @notice §4.2 steps 1–17. Reverts with the custom error matching `check()`'s first failing reason.
    function execute(SwapParams calldata p, bytes32 rationaleHash) external nonReentrant returns (uint256 amountOut) {
        Eval memory e = _evaluate(msg.sender, p);
        if (e.reason != OK) _revertWith(e, p);

        // 14. effects before interaction
        _epochIndex = e.epochIndex;
        _spentUsd = e.spentUsd + e.notionalUsd;
        lastTradeAt = block.timestamp;

        uint256 spent;
        (spent, amountOut) = _swapAndVerify(p, e);

        // 17.
        emit TradeExecuted(
            msg.sender,
            p.tokenIn,
            e.tokenOut,
            spent,
            amountOut,
            e.notionalUsd,
            e.oraclePrice,
            p.proposalId,
            rationaleHash,
            e.exitPath
        );
    }

    // =========================================================================================================
    // views
    // =========================================================================================================

    function check(address caller, SwapParams calldata p)
        external
        view
        returns (uint8 reason, uint256 notionalUsd, uint256 oraclePrice, uint256 minOutFloor, bool exitPath)
    {
        Eval memory e = _evaluate(caller, p);
        return (e.reason, e.notionalUsd, e.oraclePrice, e.minOutFloor, e.exitPath);
    }

    function epoch() external view returns (uint256 index, uint256 start, uint256 spentUsd, uint256 capUsd) {
        uint32 dur = _limits.epochDuration;
        index = dur == 0 ? 0 : block.timestamp / dur;
        start = index * dur;
        spentUsd = index == _epochIndex ? _spentUsd : 0;
        capUsd = _limits.maxEpochUsd;
    }

    function agent() external view returns (address) {
        return _agent;
    }

    function guardian() external view returns (address) {
        return _guardian;
    }

    function limits() external view returns (Limits memory) {
        return _limits;
    }

    /// @notice priceToken holdings valued at the oracle, 8 dp, rounded up. Reverts on a bad/stale round.
    function exposureUsd() external view returns (uint256) {
        (uint8 code, uint256 P, int256 answer, uint256 updatedAt) = _readOracle(_limits.maxOracleAge);
        if (code == ERR_ORACLE_INVALID) revert OracleInvalid(answer, updatedAt);
        if (code == ERR_ORACLE_STALE) revert OracleStale(updatedAt, _limits.maxOracleAge);
        return _valueAt(IERC20(priceToken).balanceOf(address(this)), P);
    }

    // =========================================================================================================
    // internals
    // =========================================================================================================

    /// @dev Steps 1–13 in the normative order. Shared by `check()` and `execute()` (I10 parity by construction).
    function _evaluate(address caller, SwapParams calldata p) internal view returns (Eval memory e) {
        Limits memory L = _limits;

        // 1–5
        if (paused) {
            e.reason = ERR_PAUSED;
            return e;
        }
        if (caller != _agent) {
            e.reason = ERR_NOT_AGENT;
            e.ctx0 = uint256(uint160(caller));
            return e;
        }
        if (p.amountIn == 0) {
            e.reason = ERR_ZERO_AMOUNT;
            return e;
        }
        if (block.timestamp > p.deadline) {
            e.reason = ERR_DEADLINE;
            return e;
        }
        if (p.tokenIn == quoteToken) {
            e.isBuy = true;
            e.tokenOut = priceToken;
        } else if (p.tokenIn == priceToken) {
            e.tokenOut = quoteToken;
        } else {
            e.reason = ERR_PAIR_NOT_ALLOWED;
            return e;
        }

        // 6. oracle
        {
            (uint8 code, uint256 P, int256 answer, uint256 updatedAt) = _readOracle(L.maxOracleAge);
            if (code != OK) {
                e.reason = code;
                e.answer = answer;
                e.ctx0 = updatedAt;
                return e;
            }
            e.oraclePrice = P;
        }

        // 7. deviation (spot + 300 s TWAP), 7b exit path
        uint256 pFloor = e.oraclePrice;
        uint256 pCap = e.oraclePrice;
        {
            (bool sOk, uint256 S) = _spot();
            (bool tOk, uint256 T) = _twap();
            uint256 P = e.oraclePrice;
            bool normal = sOk && tOk && _devBps(S, P) <= L.maxOracleDeviationBps
                && _devBps(T, P) <= L.maxOracleDeviationBps;
            if (!normal) {
                if (e.isBuy || !tOk) {
                    e.reason = ERR_ORACLE_DEVIATION;
                    e.ctx0 = S;
                    e.ctx1 = T;
                    return e;
                }
                if (T < Math.mulDiv(P, BPS - L.maxExitDiscountBps, BPS, Math.Rounding.Ceil)) {
                    e.reason = ERR_EXIT_PRICE;
                    e.ctx0 = T;
                    return e;
                }
                e.exitPath = true;
                pFloor = Math.min(P, T);
                pCap = Math.max(P, T);
            }
        }

        // 8. trade cap (notional at Pcap, rounded up; saturates for absurd sizes)
        if (p.amountIn > type(uint128).max) {
            e.notionalUsd = type(uint256).max;
        } else if (e.isBuy) {
            e.notionalUsd = p.amountIn * 100;
        } else {
            e.notionalUsd = Math.mulDiv(p.amountIn, pCap, _unit, Math.Rounding.Ceil);
        }
        if (e.notionalUsd > L.maxTradeUsd) {
            e.reason = ERR_TRADE_CAP;
            return e;
        }

        // 9. epoch rollover + cap
        e.epochIndex = L.epochDuration == 0 ? 0 : block.timestamp / L.epochDuration;
        e.spentUsd = e.epochIndex == _epochIndex ? _spentUsd : 0;
        if (e.spentUsd + e.notionalUsd > L.maxEpochUsd) {
            e.reason = ERR_EPOCH_CAP;
            return e;
        }

        // 10. cooldown
        if (lastTradeAt != 0 && block.timestamp < lastTradeAt + L.cooldown) {
            e.reason = ERR_COOLDOWN;
            return e;
        }

        // 11. slippage floor at Pfloor (rounds up: demands more output)
        {
            uint256 expectedOut = e.isBuy
                ? Math.mulDiv(p.amountIn, _scale, pFloor, Math.Rounding.Ceil)
                : Math.mulDiv(p.amountIn, pFloor, _scale, Math.Rounding.Ceil);
            e.minOutFloor = Math.mulDiv(
                expectedOut, (1e6 - uint256(_fee)) * (BPS - L.maxSlippageBps), 1e10, Math.Rounding.Ceil
            );
        }
        if (p.minAmountOut < e.minOutFloor) {
            e.reason = ERR_SLIPPAGE;
            return e;
        }

        // 12. balance
        {
            uint256 bal = IERC20(p.tokenIn).balanceOf(address(this));
            if (bal < p.amountIn) {
                e.reason = ERR_BALANCE;
                e.ctx0 = bal;
                return e;
            }
        }

        // 13. exposure pre-check (buys only; buys are always 7a)
        if (e.isBuy) {
            uint256 cur = _valueAt(IERC20(priceToken).balanceOf(address(this)), e.oraclePrice);
            uint256 added = Math.mulDiv(e.notionalUsd, BPS, BPS - L.maxOracleDeviationBps, Math.Rounding.Ceil);
            if (cur + added > L.maxExposureUsd) {
                e.reason = ERR_EXPOSURE;
                e.ctx0 = cur;
                e.ctx1 = added;
                return e;
            }
        }
    }

    /// @dev Steps 15–16: approve, swap with recipient = this, reset approval, verify measured deltas.
    function _swapAndVerify(SwapParams calldata p, Eval memory e) internal returns (uint256 spent, uint256 got) {
        IERC20 tin = IERC20(p.tokenIn);
        IERC20 tout = IERC20(e.tokenOut);
        uint256 inBefore = tin.balanceOf(address(this));
        uint256 outBefore = tout.balanceOf(address(this));

        // 15. swap through the fixed router/pool fee tier, proceeds to the vault
        tin.forceApprove(router, p.amountIn);
        ISwapRouter02(router).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: p.tokenIn,
                tokenOut: e.tokenOut,
                fee: _fee,
                recipient: address(this),
                amountIn: p.amountIn,
                amountOutMinimum: p.minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );
        tin.forceApprove(router, 0);

        // 16. post-conditions
        uint256 inAfter = tin.balanceOf(address(this));
        uint256 outAfter = tout.balanceOf(address(this));
        if (inAfter > inBefore || inBefore - inAfter > p.amountIn) revert PostCondition(1);
        if (outAfter < outBefore || outAfter - outBefore < p.minAmountOut) revert PostCondition(2);
        if (tin.allowance(address(this), router) != 0) revert PostCondition(3);
        if (e.isBuy) {
            uint256 post = _valueAt(IERC20(priceToken).balanceOf(address(this)), e.oraclePrice);
            if (post > _limits.maxExposureUsd) revert Exposure(post, 0, _limits.maxExposureUsd);
        }
        spent = inBefore - inAfter;
        got = outAfter - outBefore;
    }

    function _revertWith(Eval memory e, SwapParams calldata p) internal view {
        uint8 r = e.reason;
        Limits memory L = _limits;
        if (r == ERR_PAUSED) revert VaultPaused();
        if (r == ERR_NOT_AGENT) revert NotAgent(address(uint160(e.ctx0)));
        if (r == ERR_ZERO_AMOUNT) revert ZeroAmount();
        if (r == ERR_DEADLINE) revert DeadlineExpired(p.deadline, block.timestamp);
        if (r == ERR_PAIR_NOT_ALLOWED) revert PairNotAllowed(p.tokenIn);
        if (r == ERR_ORACLE_INVALID) revert OracleInvalid(e.answer, e.ctx0);
        if (r == ERR_ORACLE_STALE) revert OracleStale(e.ctx0, L.maxOracleAge);
        if (r == ERR_ORACLE_DEVIATION) revert OracleDeviation(e.ctx0, e.ctx1, e.oraclePrice, L.maxOracleDeviationBps);
        if (r == ERR_TRADE_CAP) revert TradeCap(e.notionalUsd, L.maxTradeUsd);
        if (r == ERR_EPOCH_CAP) revert EpochCap(e.spentUsd, e.notionalUsd, L.maxEpochUsd);
        if (r == ERR_COOLDOWN) revert Cooldown(lastTradeAt, L.cooldown);
        if (r == ERR_SLIPPAGE) revert Slippage(p.minAmountOut, e.minOutFloor);
        if (r == ERR_BALANCE) revert InsufficientBalance(p.tokenIn, e.ctx0, p.amountIn);
        if (r == ERR_EXPOSURE) revert Exposure(e.ctx0, e.ctx1, L.maxExposureUsd);
        revert ExitPrice(e.ctx0, e.oraclePrice, L.maxExitDiscountBps); // ERR_EXIT_PRICE
    }

    /// @dev §4.2 step 6. Returns (code, P, answer, updatedAt). `answeredInRound < roundId` is INVALID: both APRO
    /// feeds returned answeredInRound == roundId on the 2026-11-02 mainnet read (SPEC Q7).
    function _readOracle(uint32 maxAge)
        internal
        view
        returns (uint8 code, uint256 P, int256 answer, uint256 updatedAt)
    {
        try IAggregatorV3(oracle).latestRoundData() returns (
            uint80 roundId, int256 a, uint256, uint256 u, uint80 answeredInRound
        ) {
            answer = a;
            updatedAt = u;
            if (a <= 0 || u == 0 || u > block.timestamp || answeredInRound < roundId) {
                return (ERR_ORACLE_INVALID, 0, a, u);
            }
            if (block.timestamp - u > maxAge) return (ERR_ORACLE_STALE, 0, a, u);
            return (OK, uint256(a), a, u);
        } catch {
            return (ERR_ORACLE_INVALID, 0, 0, 0);
        }
    }

    /// @dev Spot from slot0's first word (sqrtPriceX96), read raw so slot0 layout variants still decode.
    function _spot() internal view returns (bool ok, uint256 price) {
        (bool success, bytes memory data) = pool.staticcall(abi.encodeWithSelector(0x3850c7bd)); // slot0()
        if (!success || data.length < 32) return (false, 0);
        uint256 sqrtP = abi.decode(data, (uint256));
        if (sqrtP == 0 || sqrtP > type(uint160).max) return (false, 0);
        return (true, _priceFromSqrt(sqrtP));
    }

    /// @dev 300 s TWAP: mean tick rounded toward -inf, then v4-core TickMath.getSqrtPriceAtTick.
    function _twap() internal view returns (bool ok, uint256 price) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = TWAP_WINDOW;
        ago[1] = 0;
        try IUniswapV3PoolLike(pool).observe(ago) returns (int56[] memory tc, uint160[] memory) {
            if (tc.length < 2) return (false, 0);
            int256 delta = int256(tc[1]) - int256(tc[0]);
            int256 mean = delta / int256(uint256(TWAP_WINDOW));
            if (delta < 0 && delta % int256(uint256(TWAP_WINDOW)) != 0) mean--;
            if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) return (false, 0);
            return (true, _priceFromSqrt(TickMath.getSqrtPriceAtTick(int24(mean))));
        } catch {
            return (false, 0);
        }
    }

    /// @dev USD (8 dp) per whole priceToken: mulDiv(mulDiv(sqrtP, sqrtP, 2^96), SCALE, 2^96).
    function _priceFromSqrt(uint256 sqrtP) internal view returns (uint256) {
        return Math.mulDiv(Math.mulDiv(sqrtP, sqrtP, Q96), _scale, Q96);
    }

    function _devBps(uint256 x, uint256 P) internal pure returns (uint256) {
        uint256 diff = x > P ? x - P : P - x;
        return Math.mulDiv(diff, BPS, P, Math.Rounding.Ceil);
    }

    function _valueAt(uint256 amount, uint256 P) internal view returns (uint256) {
        return Math.mulDiv(amount, P, _unit, Math.Rounding.Ceil);
    }
}
