// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Mintable ERC20 with configurable decimals (6 / 8 / 18).
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice AggregatorV3 mock with knobs for every step-6 branch.
contract MockAggregator {
    uint8 public decimals;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;
    bool public reverts;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 u) external {
        answer = a;
        updatedAt = u;
    }

    function setAnswer(int256 a) external {
        answer = a;
        updatedAt = block.timestamp;
    }

    function setRounds(uint80 r, uint80 air) external {
        roundId = r;
        answeredInRound = air;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function setDecimals(uint8 d) external {
        decimals = d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverts, "oracle down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @notice Uniswap-V3-like pool: slot0 (7 fields), observe([a,b]) from a settable mean tick, fee, tokens.
contract MockPool {
    address public token0;
    address public token1;
    uint24 public fee;
    address public factory;

    uint160 public sqrtPriceX96;
    int56 public cumDelta; // tickCumulative[now] - tickCumulative[now-300]
    int56 public cumBase = 1_000_000;
    bool public observeReverts;
    bool public slot0Reverts;

    constructor(address t0, address t1, uint24 f, address fac) {
        token0 = t0;
        token1 = t1;
        fee = f;
        factory = fac;
    }

    function setSqrtPrice(uint160 s) external {
        sqrtPriceX96 = s;
    }

    function setMeanTick(int24 t) external {
        cumDelta = int56(t) * 300;
    }

    function setCumDelta(int56 d) external {
        cumDelta = d;
    }

    function setObserveReverts(bool r) external {
        observeReverts = r;
    }

    function setSlot0Reverts(bool r) external {
        slot0Reverts = r;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        require(!slot0Reverts, "slot0");
        return (sqrtPriceX96, 0, 0, 240, 240, 0, true);
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tc, uint160[] memory spl) {
        require(!observeReverts, "OLD");
        require(secondsAgos.length == 2 && secondsAgos[0] == 300 && secondsAgos[1] == 0, "mock: [300,0] only");
        tc = new int56[](2);
        spl = new uint160[](2);
        tc[0] = cumBase;
        tc[1] = cumBase + cumDelta;
    }
}

contract MockFactory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;

    function setPool(address a, address b, uint24 f, address p) external {
        getPool[a][b][f] = p;
        getPool[b][a][f] = p;
    }
}

/// @notice SwapRouter02-like router: 7-field exactInputSingle, factory(), positionManager().
/// Swaps at the pool's spot sqrtPrice minus the fee, from its own inventory. Knobs simulate a misbehaving
/// router/pool for post-condition tests.
contract MockSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 private constant Q96 = 0x1000000000000000000000000;

    address public factory;
    MockPool public immutable mpool;

    // knobs
    uint16 public haircutBps; // extra execution loss vs spot
    bool public ignoreMinOut; // misbehaving: do not enforce amountOutMinimum
    uint256 public pullLess; // pull amountIn - pullLess
    uint256 public bonusOut; // send extra tokenOut (e.g. to blow exposure post-check)
    bool public sendElsewhere; // send output to a sink instead of recipient
    bool public refundIn; // send tokenIn back to the payer after pulling (tokenIn balance would rise)
    bytes public reenterData; // call msg.sender with this data during the swap
    address public lastRecipient;

    constructor(address f, MockPool p) {
        factory = f;
        mpool = p;
    }

    function positionManager() external pure returns (address) {
        return address(0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5);
    }

    function setHaircutBps(uint16 h) external {
        haircutBps = h;
    }

    function setIgnoreMinOut(bool b) external {
        ignoreMinOut = b;
    }

    function setPullLess(uint256 x) external {
        pullLess = x;
    }

    function setBonusOut(uint256 x) external {
        bonusOut = x;
    }

    function setSendElsewhere(bool b) external {
        sendElsewhere = b;
    }

    function setRefundIn(bool b) external {
        refundIn = b;
    }

    function setReenter(bytes calldata d) external {
        reenterData = d;
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256 out) {
        uint256 s = mpool.sqrtPriceX96();
        if (tokenIn == mpool.token1()) {
            // quote -> token0: amountIn / price
            out = Math.mulDiv(Math.mulDiv(amountIn, Q96, s), Q96, s);
        } else {
            out = Math.mulDiv(Math.mulDiv(amountIn, s, Q96), s, Q96);
        }
        out = out * (1e6 - mpool.fee()) / 1e6;
        out = out * (10_000 - haircutBps) / 10_000;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        require(p.fee == mpool.fee(), "fee");
        lastRecipient = p.recipient;
        uint256 pull = p.amountIn - pullLess;
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), pull);
        if (reenterData.length > 0) {
            (bool ok, bytes memory ret) = msg.sender.call(reenterData);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        out = quote(p.tokenIn, pull);
        if (!ignoreMinOut) require(out >= p.amountOutMinimum, "Too little received");
        out += bonusOut;
        IERC20(p.tokenOut).transfer(sendElsewhere ? address(0xdead) : p.recipient, out);
        if (refundIn) IERC20(p.tokenIn).transfer(msg.sender, pull + 1);
    }
}

/// @notice SwapRouter v1 lookalike: same factory(), but no positionManager() (constructor check 7).
contract MockSwapRouterV1 {
    address public factory;

    constructor(address f) {
        factory = f;
    }
}

/// @notice SupraSValueFeedStorage.getSvalue mock.
contract MockSupraStorage {
    struct priceFeed {
        uint256 round;
        uint256 decimals;
        uint256 time;
        uint256 price;
    }

    mapping(uint256 => priceFeed) internal feeds;

    function set(uint256 pair, uint256 round, uint256 decimals_, uint256 timeMs, uint256 price) external {
        feeds[pair] = priceFeed(round, decimals_, timeMs, price);
    }

    function getSvalue(uint256 pair) external view returns (priceFeed memory) {
        return feeds[pair];
    }
}
