// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {VaultFixture} from "../utils/VaultFixture.sol";
import {VaultHandler} from "./VaultHandler.sol";
import {PolicyVault} from "../../src/PolicyVault.sol";
import "../../src/PolicyVaultTypes.sol";

/// @notice §4.4 invariants I1–I4, I6, I9, I11–I13 (plus I2/I5/I7 handler assertions, I10 check→execute),
/// 6 actors, both priceToken shapes. Profile: [profile.default.invariant] runs = 64, depth = 32.
abstract contract PolicyVaultInvariantBase is VaultFixture {
    VaultHandler internal handler;

    function setUp() public virtual override {
        super.setUp();
        usdt.mint(address(vault), 800e6);
        handler = new VaultHandler(
            PolicyVault(address(vault)), usdt, ptok, oracle, pool, router, agent, guardian, owner, P0
        );
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](16);
        sel[0] = VaultHandler.agentTrade.selector;
        sel[1] = VaultHandler.agentTrade.selector; // weight trades x6
        sel[2] = VaultHandler.agentTrade.selector;
        sel[13] = VaultHandler.agentTrade.selector;
        sel[14] = VaultHandler.agentTrade.selector;
        sel[15] = VaultHandler.agentTrade.selector;
        sel[3] = VaultHandler.agentPause.selector;
        sel[4] = VaultHandler.strangerExecute.selector;
        sel[5] = VaultHandler.hostileAdmin.selector;
        sel[6] = VaultHandler.guardianPause.selector;
        sel[7] = VaultHandler.ownerUnpause.selector;
        sel[8] = VaultHandler.ownerWithdraw.selector;
        sel[9] = VaultHandler.ownerSetLimits.selector;
        sel[10] = VaultHandler.manipulatePool.selector;
        sel[11] = VaultHandler.moveOracle.selector;
        sel[12] = VaultHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    function _clear(bytes32 name) internal view {
        assertFalse(handler.violated(name), string(abi.encodePacked("violated: ", name)));
    }

    function invariant_I1_epochCap() public view {
        _clear("I1");
    }

    function invariant_I2_onlyAgentExecutes() public view {
        _clear("I2");
    }

    function invariant_I3_balancesOnlyViaExecuteOrWithdraw() public view {
        _clear("I3");
    }

    function invariant_I4_outputAtLeastMinAndFloor() public view {
        _clear("I4");
    }

    function invariant_I5_ownerOnlyUnderFuzz() public view {
        _clear("I5");
    }

    function invariant_I6_pausedBlocksExecute() public view {
        _clear("I6");
        if (vault.paused()) {
            (uint8 r,,,,) = vault.check(agent, buyParams(5e6, 1));
            assertEq(r, ERR_PAUSED);
        }
    }

    function invariant_I7_tradeCap() public view {
        _clear("I7");
    }

    function invariant_I9_routerAllowanceZero() public view {
        assertEq(usdt.allowance(address(vault), address(router)), 0);
        assertEq(ptok.allowance(address(vault), address(router)), 0);
    }

    function invariant_I10_noExecuteWithoutOkCheck() public view {
        _clear("I10-check-not-ok-but-executed");
    }

    function invariant_I11_normalPathLoss() public view {
        _clear("I11");
    }

    function invariant_I12_exposureAfterBuy() public view {
        _clear("I12");
    }

    function invariant_I13_exitPath() public view {
        _clear("I13-buy");
        _clear("I13-twap");
        _clear("I13-holdings");
        _clear("I13-floor");
    }
}

contract PolicyVaultInvariant_WHSK18 is PolicyVaultInvariantBase {
    function _decimals() internal pure override returns (uint8) {
        return 18;
    }

    function _p0() internal pure override returns (int256) {
        return 8_772_098;
    }
}

contract PolicyVaultInvariant_WBTC8 is PolicyVaultInvariantBase {
    function _decimals() internal pure override returns (uint8) {
        return 8;
    }

    function _p0() internal pure override returns (int256) {
        return 7_792_502_000_000;
    }
}
