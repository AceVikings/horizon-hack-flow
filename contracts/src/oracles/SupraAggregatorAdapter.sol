// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

/// @notice Supra S-Value storage (push feed storage, also written by SupraOraclePull.verifyOracleProof*).
/// Chain 177 proxy: 0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57 (impl SupraSValueFeedStorage, no read access control).
interface ISupraSValueFeed {
    struct priceFeed {
        uint256 round; // ms timestamp-like round id (64-bit packed)
        uint256 decimals; // feed decimals (0 = pair never populated)
        uint256 time; // update time in MILLISECONDS
        uint256 price; // price in `decimals` dp (96-bit packed)
    }

    function getSvalue(uint256 pairIndex) external view returns (priceFeed memory);
}

/// @title SupraAggregatorAdapter
/// @notice Read-only AggregatorV3-shaped view over one Supra pair, so PolicyVault (whose `oracle` is an immutable
/// AggregatorV3-like address) can price against Supra without any allow-listing. Stateless and permissionless:
/// it holds no funds, has no owner and cannot be repointed (storage and pair are immutable).
/// - `decimals()` = 8; the Supra price is rescaled from the feed's decimals to 8 dp, rounding DOWN.
/// - `updatedAt` = `startedAt` = Supra `time / 1000` (ms → s), clamped to `block.timestamp` (Supra accepts
///   proofs up to 3 s in the future; without the clamp the vault would see a transient ORACLE_INVALID).
/// - `roundId` = `answeredInRound` = `uint80(round)`.
/// - An unpopulated pair (decimals == 0 or price == 0) returns all zeros, which PolicyVault §4.2 step 6 maps to
///   ERR_ORACLE_INVALID (answer <= 0, updatedAt == 0).
contract SupraAggregatorAdapter {
    ISupraSValueFeed public immutable supraStorage;
    uint256 public immutable pairIndex;
    string public description;

    uint8 public constant decimals = 8;
    uint256 public constant version = 1;

    constructor(address storage_, uint256 pairIndex_, string memory description_) {
        require(storage_ != address(0), "storage=0");
        supraStorage = ISupraSValueFeed(storage_);
        pairIndex = pairIndex_;
        description = description_;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        ISupraSValueFeed.priceFeed memory f = supraStorage.getSvalue(pairIndex);
        if (f.decimals == 0 || f.price == 0 || f.decimals > 36) return (0, 0, 0, 0, 0);
        uint256 p8 = f.decimals >= 8 ? f.price / 10 ** (f.decimals - 8) : f.price * 10 ** (8 - f.decimals);
        if (p8 > uint256(type(int256).max)) return (0, 0, 0, 0, 0);
        roundId = uint80(f.round);
        answer = int256(p8);
        updatedAt = f.time / 1000;
        if (updatedAt > block.timestamp) updatedAt = block.timestamp;
        startedAt = updatedAt;
        answeredInRound = roundId;
    }
}
