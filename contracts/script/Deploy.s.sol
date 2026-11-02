// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {Limits} from "../src/PolicyVaultTypes.sol";
import {SupraAggregatorAdapter} from "../src/oracles/SupraAggregatorAdapter.sol";
import {DeployConfig} from "./DeployConfig.sol";

/// @notice SPEC §19 steps 1, 3, 4: per market deploy a SupraAggregatorAdapter (APRO feeds are read-access-controlled
/// on 177, see ABI-NOTES.md), then the vault with oracle = adapter, from the same bytecode; setLimits (defaults,
/// env-overridable), setAgent, setGuardian. The broadcaster becomes `owner` — sign with `--ledger` or
/// `--account owner`, never `--private-key`.
///
///   AGENT=0x… GUARDIAN=0x… forge script script/Deploy.s.sol:Deploy \
///     --rpc-url hsk --ledger --sender <owner> --broadcast
///
/// Env (all optional): MARKETS = "both" | "hsk" | "btc"; AGENT; GUARDIAN; MAX_TRADE_USD, MAX_EPOCH_USD,
/// MAX_EXPOSURE_USD (8-dp USD, e.g. 60e8 for the smaller-seed fallback), EPOCH_DURATION, MAX_SLIPPAGE_BPS,
/// MAX_ORACLE_DEVIATION_BPS, MAX_EXIT_DISCOUNT_BPS, MAX_ORACLE_AGE, COOLDOWN; ORACLE_SOURCE = "supra" (default) |
/// "apro" (only once APRO has allow-listed the vault address).
contract Deploy is Script {
    function run() external returns (PolicyVault vaultHsk, PolicyVault vaultBtc) {
        string memory markets = vm.envOr("MARKETS", string("both"));
        address agent = vm.envOr("AGENT", address(0));
        address guardian = vm.envOr("GUARDIAN", address(0));
        Limits memory l = limitsFromEnv();
        bool doHsk = _eq(markets, "both") || _eq(markets, "hsk");
        bool doBtc = _eq(markets, "both") || _eq(markets, "btc");
        require(doHsk || doBtc, "MARKETS must be both|hsk|btc");
        if (block.chainid != DeployConfig.CHAIN_ID) console2.log("WARNING: chainid is not 177:", block.chainid);

        vm.startBroadcast();
        if (doHsk) vaultHsk = _deployOne(DeployConfig.hsk(), l, agent, guardian);
        if (doBtc) vaultBtc = _deployOne(DeployConfig.btc(), l, agent, guardian);
        vm.stopBroadcast();
    }

    function _deployOne(DeployConfig.Market memory m, Limits memory l, address agent, address guardian)
        internal
        returns (PolicyVault v)
    {
        address oracle = m.oracle;
        if (!_eq(vm.envOr("ORACLE_SOURCE", string("supra")), "apro")) {
            SupraAggregatorAdapter a =
                new SupraAggregatorAdapter(DeployConfig.SUPRA_STORAGE, m.supraPair, m.supraDescription);
            oracle = address(a);
            console2.log("  adapter", oracle, m.supraDescription);
            console2.log("  adapter constructor-args:");
            console2.logBytes(abi.encode(DeployConfig.SUPRA_STORAGE, m.supraPair, m.supraDescription));
        }
        v = new PolicyVault(m.quoteToken, m.priceToken, oracle, m.router, m.pool, m.factory);
        v.setLimits(l);
        if (agent != address(0)) v.setAgent(agent);
        if (guardian != address(0)) v.setGuardian(guardian);

        console2.log("market", m.name);
        console2.log("  vault", address(v));
        console2.log("  owner", v.owner());
        console2.log("  agent", v.agent());
        console2.log("  guardian", v.guardian());
        console2.log("  constructor-args (for forge verify-contract --constructor-args):");
        console2.logBytes(abi.encode(m.quoteToken, m.priceToken, oracle, m.router, m.pool, m.factory));
    }

    function limitsFromEnv() public view returns (Limits memory l) {
        l = DeployConfig.defaultLimits();
        l.maxTradeUsd = uint128(vm.envOr("MAX_TRADE_USD", uint256(l.maxTradeUsd)));
        l.maxEpochUsd = uint128(vm.envOr("MAX_EPOCH_USD", uint256(l.maxEpochUsd)));
        l.maxExposureUsd = uint128(vm.envOr("MAX_EXPOSURE_USD", uint256(l.maxExposureUsd)));
        l.epochDuration = uint32(vm.envOr("EPOCH_DURATION", uint256(l.epochDuration)));
        l.maxSlippageBps = uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(l.maxSlippageBps)));
        l.maxOracleDeviationBps = uint16(vm.envOr("MAX_ORACLE_DEVIATION_BPS", uint256(l.maxOracleDeviationBps)));
        l.maxExitDiscountBps = uint16(vm.envOr("MAX_EXIT_DISCOUNT_BPS", uint256(l.maxExitDiscountBps)));
        l.maxOracleAge = uint32(vm.envOr("MAX_ORACLE_AGE", uint256(l.maxOracleAge)));
        l.cooldown = uint32(vm.envOr("COOLDOWN", uint256(l.cooldown)));
    }

    function _eq(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
