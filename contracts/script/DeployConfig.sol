// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Limits} from "../src/PolicyVaultTypes.sol";

/// @notice HashKey Chain mainnet (177) addresses, SPEC §0.2 (re-verified 2026-11-02), and §19 step 3 defaults.
library DeployConfig {
    uint256 internal constant CHAIN_ID = 177;

    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029; // 6 dp
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1; // 18 dp
    address internal constant WBTC = 0x6119CA49a79f5825C8B345F8d7aC36B272565b14; // 8 dp
    address internal constant APRO_HSK_USD = 0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b;
    address internal constant APRO_BTC_USD = 0x204ED500ab56A2E19B051561258E3A45c850360F;
    address internal constant FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742; // HSKSwap V3
    address internal constant SWAP_ROUTER02 = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3; // 7-field, no deadline
    address internal constant POOL_WHSK_USDT = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC; // fee 3000
    address internal constant POOL_WBTC_USDT = 0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A; // fee 3000
    address internal constant QUOTER_V2 = 0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD;
    // Supra (no read access control): S-Value storage proxy (push + pull write here) and pull verifier proxy
    address internal constant SUPRA_STORAGE = 0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57;
    address internal constant SUPRA_PULL = 0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD;
    uint256 internal constant SUPRA_PAIR_BTC_USD = 0;
    uint256 internal constant SUPRA_PAIR_HSK_USD = 517;

    struct Market {
        string name;
        address quoteToken;
        address priceToken;
        address oracle; // APRO feed (display / doctor cross-check; vault oracle only if APRO grants access)
        address router;
        address pool;
        address factory;
        uint256 supraPair; // vault oracle = SupraAggregatorAdapter(SUPRA_STORAGE, supraPair)
        string supraDescription;
    }

    function hsk() internal pure returns (Market memory) {
        return Market(
            "hsk-dex:WHSK/USDT:3000", USDT, WHSK, APRO_HSK_USD, SWAP_ROUTER02, POOL_WHSK_USDT, FACTORY, SUPRA_PAIR_HSK_USD, "HSK/USD (Supra pair 517)"
        );
    }

    function btc() internal pure returns (Market memory) {
        return Market(
            "hsk-dex:WBTC/USDT:3000", USDT, WBTC, APRO_BTC_USD, SWAP_ROUTER02, POOL_WBTC_USDT, FACTORY, SUPRA_PAIR_BTC_USD, "BTC/USD (Supra pair 0)"
        );
    }

    /// @notice §19 step 3 defaults (identical for both vaults).
    function defaultLimits() internal pure returns (Limits memory) {
        return Limits({
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
}
