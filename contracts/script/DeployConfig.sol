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

    struct Market {
        string name;
        address quoteToken;
        address priceToken;
        address oracle;
        address router;
        address pool;
        address factory;
    }

    function hsk() internal pure returns (Market memory) {
        return Market("hsk-dex:WHSK/USDT:3000", USDT, WHSK, APRO_HSK_USD, SWAP_ROUTER02, POOL_WHSK_USDT, FACTORY);
    }

    function btc() internal pure returns (Market memory) {
        return Market("hsk-dex:WBTC/USDT:3000", USDT, WBTC, APRO_BTC_USD, SWAP_ROUTER02, POOL_WBTC_USDT, FACTORY);
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
