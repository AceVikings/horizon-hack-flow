// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {Limits} from "../src/PolicyVaultTypes.sol";
import {ISupraSValueFeed, SupraAggregatorAdapter} from "../src/oracles/SupraAggregatorAdapter.sol";
import {TestToken} from "../src/testnet/TestToken.sol";
import {DeployConfig} from "./DeployConfig.sol";

interface INonfungiblePositionManagerLike {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IPoolAdminLike {
    function liquidity() external view returns (uint128);
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface IFactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address);
}

interface ISchemaRegistryLike {
    struct SchemaRecord {
        bytes32 uid;
        address resolver;
        bool revocable;
        string schema;
    }

    function register(string calldata schema, address resolver, bool revocable) external returns (bytes32);
    function getSchema(bytes32 uid) external view returns (SchemaRecord memory);
}

/// @notice HashKey Chain TESTNET (133) deployment of ATE, end to end:
///   1. test tokens tUSDT (6 dp), tWBTC (8 dp), tWHSK (18 dp) via CREATE2 with mined salts so that
///      priceToken < tUSDT (the vault requires token0 = priceToken, token1 = USDT); idempotent (reuses code);
///   2. HSKSwap fee-3000 pools tWHSK/tUSDT and tWBTC/tUSDT initialised at the live Supra testnet price,
///      observation cardinality 64, full-range liquidity (~$440k / ~$100k, like mainnet);
///   3. per market a SupraAggregatorAdapter (testnet storage, pairs 517 / 0) and a PolicyVault (same bytecode and
///      constructor checks as 177), §19 default limits (env-overridable like Deploy.s.sol), agent + guardian;
///   4. the §13 EAS schema (registered once), vault seeds (~$150 tUSDT + ~$50 of price token each);
///   5. deployments/133.json (or $DEPLOYMENTS_OUT).
///
///   forge script script/DeployTestnet.s.sol:DeployTestnet --rpc-url https://testnet.hsk.xyz \
///     --private-key $(jq -r .[0].private_key ~/.ate/testnet/deployer.json) --broadcast --slow
///
/// Env (all optional): AGENT, GUARDIAN (default: deployer); DEPLOYMENTS_OUT (default ../deployments/133.json);
/// DEPLOY_LABEL (default "testnet"); HSK_POOL_USD (default 440000), BTC_POOL_USD (100000); SEED_USDT (150),
/// SEED_PRICE_USD (50); the Deploy.s.sol limit overrides (MAX_TRADE_USD, …, COOLDOWN).
contract DeployTestnet is Script {
    uint256 internal constant CHAIN_ID = 133;
    string internal constant RPC = "https://testnet.hsk.xyz";
    string internal constant EXPLORER = "https://testnet-explorer.hskchain.net";

    // HSKSwap testnet (V3; router.factory() and router.positionManager() verified on-chain)
    address internal constant FACTORY = 0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0;
    address internal constant SWAP_ROUTER02 = 0xa6914E66690c6794244B5f66a09eAEbf66254237;
    address internal constant QUOTER_V2 = 0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC;
    address internal constant NPM = 0x73dEc6bfa6751509b08480bd97f54b874E3b20e8;
    address internal constant WETH9 = 0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6; // real WHSK (not used: scarce)
    // Supra testnet (S-Value storage + pull verifier) and OP-stack predeploys
    address internal constant SUPRA_STORAGE = 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917;
    address internal constant SUPRA_PULL = 0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702;
    address internal constant EAS = 0x4200000000000000000000000000000000000021;
    address internal constant SCHEMA_REGISTRY = 0x4200000000000000000000000000000000000020;
    address internal constant MULTICALL3 = 0xcA11bde05977b3631167028862bE2a173976CA11;

    /// @dev §13 verbatim (packages/journal/src/attest/schema.ts); field order is part of the UID.
    string internal constant EAS_SCHEMA =
        "bytes32 proposalId,bytes32 rationaleHash,bytes32 txHash,uint256 notionalUsd,bool exitPath,string engine,string origin";

    uint24 internal constant FEE = 3000;
    int24 internal constant TICK_LOWER = -887_220; // full range, tick spacing 60
    int24 internal constant TICK_UPPER = 887_220;
    uint16 internal constant CARDINALITY = 64;

    struct Market {
        string id;
        string key;
        TestToken priceToken;
        uint256 supraPair;
        string supraDescription;
        uint256 poolUsd;
        // outputs
        address pool;
        uint160 sqrtPriceX96;
        uint256 supraPrice; // 18 dp (feed decimals)
        uint256 supraDecimals;
        SupraAggregatorAdapter adapter;
        PolicyVault vault;
    }

    address internal deployer;
    TestToken internal usdt;
    TestToken internal wbtc;
    TestToken internal whsk;
    bytes32 internal schemaUid;

    function run() external {
        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
        if (block.chainid != CHAIN_ID) console2.log("WARNING: chainid is not 133:", block.chainid);
        address agent = vm.envOr("AGENT", deployer);
        address guardian = vm.envOr("GUARDIAN", deployer);
        Limits memory l = _limitsFromEnv();

        // 1. tokens: tUSDT high address, price tokens low address -> token0 = priceToken, token1 = tUSDT
        usdt = _token("Test Tether USD (ATE testnet)", "tUSDT", 6, 1_000e6, true);
        whsk = _token("Test Wrapped HSK (ATE testnet)", "tWHSK", 18, 10_000e18, false);
        wbtc = _token("Test Wrapped BTC (ATE testnet)", "tWBTC", 8, 1e6, false);
        require(address(whsk) < address(usdt) && address(wbtc) < address(usdt), "token order");

        Market memory mh = Market({
            id: "hsk-dex:WHSK/USDT:3000",
            key: "hsk",
            priceToken: whsk,
            supraPair: DeployConfig.SUPRA_PAIR_HSK_USD,
            supraDescription: "HSK/USD (Supra testnet pair 517)",
            poolUsd: vm.envOr("HSK_POOL_USD", uint256(440_000)),
            pool: address(0),
            sqrtPriceX96: 0,
            supraPrice: 0,
            supraDecimals: 0,
            adapter: SupraAggregatorAdapter(address(0)),
            vault: PolicyVault(address(0))
        });
        Market memory mb = Market({
            id: "hsk-dex:WBTC/USDT:3000",
            key: "btc",
            priceToken: wbtc,
            supraPair: DeployConfig.SUPRA_PAIR_BTC_USD,
            supraDescription: "BTC/USD (Supra testnet pair 0)",
            poolUsd: vm.envOr("BTC_POOL_USD", uint256(100_000)),
            pool: address(0),
            sqrtPriceX96: 0,
            supraPrice: 0,
            supraDecimals: 0,
            adapter: SupraAggregatorAdapter(address(0)),
            vault: PolicyVault(address(0))
        });

        // 2. pools + liquidity, 3. adapters + vaults
        _pool(mh);
        _pool(mb);
        _vault(mh, l, agent, guardian);
        _vault(mb, l, agent, guardian);

        // 4. EAS schema (once per chain) + seeds
        _schema();
        _seed(mh);
        _seed(mb);
        vm.stopBroadcast();

        _writeJson(mh, mb, l, agent, guardian);
    }

    // ------------------------------------------------------------------ tokens

    function _token(string memory name, string memory sym, uint8 dec, uint256 faucetAmt, bool high)
        internal
        returns (TestToken t)
    {
        bytes memory init =
            abi.encodePacked(type(TestToken).creationCode, abi.encode(name, sym, dec, faucetAmt, deployer));
        bytes32 h = keccak256(init);
        bytes32 salt;
        address a;
        for (uint256 i = 0; i < 4096; i++) {
            salt = keccak256(abi.encode("ate-testnet-133", sym, i));
            a = vm.computeCreate2Address(salt, h);
            uint8 top = uint8(uint160(a) >> 152);
            if (high ? top >= 0xC0 : top < 0x40) break;
            if (i == 4095) revert("no salt");
        }
        if (a.code.length == 0) {
            t = new TestToken{salt: salt}(name, sym, dec, faucetAmt, deployer);
            require(address(t) == a, "create2 mismatch");
        } else {
            t = TestToken(a);
        }
        console2.log(sym, a);
    }

    // ------------------------------------------------------------------ pools

    function _pool(Market memory m) internal {
        ISupraSValueFeed.priceFeed memory f = ISupraSValueFeed(SUPRA_STORAGE).getSvalue(m.supraPair);
        require(f.decimals > 0 && f.price > 0, "supra pair unpopulated");
        m.supraPrice = f.price;
        m.supraDecimals = f.decimals;
        uint8 d = m.priceToken.decimals();
        // raw price token1/token0 = P * 10^6 / (10^sd * 10^d); sqrtPriceX96 = sqrt(raw * 2^192)
        uint256 ratioX192 = Math.mulDiv(f.price * 1e6, 1 << 192, 10 ** (f.decimals + d));
        m.sqrtPriceX96 = uint160(Math.sqrt(ratioX192));

        m.pool = IFactoryLike(FACTORY).getPool(address(m.priceToken), address(usdt), FEE);
        if (m.pool == address(0)) {
            m.pool = INonfungiblePositionManagerLike(NPM).createAndInitializePoolIfNecessary(
                address(m.priceToken), address(usdt), FEE, m.sqrtPriceX96
            );
            IPoolAdminLike(m.pool).increaseObservationCardinalityNext(CARDINALITY);
        }
        if (IPoolAdminLike(m.pool).liquidity() == 0) {
            uint256 side = m.poolUsd / 2;
            uint256 amtQ = side * 1e6;
            uint256 amtP = Math.mulDiv(side * 10 ** d, 10 ** f.decimals, f.price);
            usdt.mint(deployer, amtQ);
            m.priceToken.mint(deployer, amtP);
            usdt.approve(NPM, amtQ);
            m.priceToken.approve(NPM, amtP);
            (uint256 id, uint128 liq, uint256 a0, uint256 a1) = INonfungiblePositionManagerLike(NPM).mint(
                INonfungiblePositionManagerLike.MintParams({
                    token0: address(m.priceToken),
                    token1: address(usdt),
                    fee: FEE,
                    tickLower: TICK_LOWER,
                    tickUpper: TICK_UPPER,
                    amount0Desired: amtP,
                    amount1Desired: amtQ,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: deployer,
                    deadline: block.timestamp + 3600
                })
            );
            console2.log("  LP tokenId", id, "liquidity", uint256(liq));
            console2.log("  LP amounts", a0, a1);
        }
        console2.log("pool", m.id, m.pool);
    }

    // ------------------------------------------------------------------ vaults

    function _vault(Market memory m, Limits memory l, address agent, address guardian) internal {
        m.adapter = new SupraAggregatorAdapter(SUPRA_STORAGE, m.supraPair, m.supraDescription);
        (, int256 ans,, uint256 upd,) = m.adapter.latestRoundData();
        require(ans > 0 && upd > 0, "adapter reads zero");
        m.vault = new PolicyVault(address(usdt), address(m.priceToken), address(m.adapter), SWAP_ROUTER02, m.pool, FACTORY);
        m.vault.setLimits(l);
        if (agent != address(0)) m.vault.setAgent(agent);
        if (guardian != address(0)) m.vault.setGuardian(guardian);
        console2.log("market", m.id);
        console2.log("  adapter", address(m.adapter));
        console2.log("  vault", address(m.vault));
    }

    function _schema() internal {
        schemaUid = keccak256(abi.encodePacked(EAS_SCHEMA, address(0), false));
        if (ISchemaRegistryLike(SCHEMA_REGISTRY).getSchema(schemaUid).uid == bytes32(0)) {
            bytes32 u = ISchemaRegistryLike(SCHEMA_REGISTRY).register(EAS_SCHEMA, address(0), false);
            require(u == schemaUid, "schema uid");
        }
        console2.log("EAS schema");
        console2.logBytes32(schemaUid);
    }

    function _seed(Market memory m) internal {
        uint8 d = m.priceToken.decimals();
        usdt.mint(address(m.vault), vm.envOr("SEED_USDT", uint256(150)) * 1e6);
        m.priceToken.mint(
            address(m.vault),
            Math.mulDiv(vm.envOr("SEED_PRICE_USD", uint256(50)) * 10 ** d, 10 ** m.supraDecimals, m.supraPrice)
        );
    }

    function _limitsFromEnv() internal view returns (Limits memory l) {
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

    // ------------------------------------------------------------------ deployments/133.json

    function _writeJson(Market memory mh, Market memory mb, Limits memory l, address agent, address guardian)
        internal
    {
        string memory out = vm.envOr("DEPLOYMENTS_OUT", string("../deployments/133.json"));
        string memory r = "root";
        vm.serializeUint(r, "chainId", CHAIN_ID);
        vm.serializeString(r, "network", "hashkey-testnet");
        vm.serializeString(r, "label", vm.envOr("DEPLOY_LABEL", string("testnet")));
        string[] memory rpcs = new string[](1);
        rpcs[0] = RPC;
        vm.serializeString(r, "rpcUrls", rpcs);
        vm.serializeString(r, "explorer", EXPLORER);
        vm.serializeAddress(r, "owner", deployer);
        vm.serializeAddress(r, "agent", agent);
        vm.serializeAddress(r, "guardian", guardian);
        vm.serializeUint(r, "deployedBlock", block.number);
        vm.serializeUint(r, "deployedAt", block.timestamp);
        vm.serializeUint(r, "candidateTtlSec", 180);
        vm.serializeString(r, "tokens", _tokensJson());
        vm.serializeString(r, "hskdex", _hskdexJson());
        vm.serializeString(r, "supra", _supraJson());
        vm.serializeString(r, "eas", _easJson());
        vm.serializeString(r, "limits", _limitsJson(l));
        string memory mk = "markets";
        vm.serializeString(mk, mh.id, _marketJson(mh));
        string memory markets = vm.serializeString(mk, mb.id, _marketJson(mb));
        string memory root = vm.serializeString(r, "markets", markets);
        vm.writeJson(root, out);
        console2.log("wrote", out);
    }

    function _tokensJson() internal returns (string memory) {
        string memory t = "tokens";
        vm.serializeString(t, "USDT", _tokenJson("tok_usdt", usdt));
        vm.serializeString(t, "WHSK", _tokenJson("tok_whsk", whsk));
        return vm.serializeString(t, "WBTC", _tokenJson("tok_wbtc", wbtc));
    }

    function _hskdexJson() internal returns (string memory) {
        string memory h = "hskdex";
        vm.serializeAddress(h, "factory", FACTORY);
        vm.serializeAddress(h, "router", SWAP_ROUTER02);
        vm.serializeAddress(h, "quoter", QUOTER_V2);
        vm.serializeAddress(h, "positionManager", NPM);
        vm.serializeAddress(h, "weth9", WETH9);
        vm.serializeString(h, "routerKind", "swaprouter02");
        return vm.serializeAddress(h, "multicall3", MULTICALL3);
    }

    function _supraJson() internal returns (string memory) {
        string memory s = "supra";
        vm.serializeAddress(s, "storage", SUPRA_STORAGE);
        vm.serializeAddress(s, "pull", SUPRA_PULL);
        vm.serializeString(s, "proofUrl", "https://rpc-testnet-dora-2.supra.com/get_proof");
        return vm.serializeString(s, "chainType", "evm");
    }

    function _easJson() internal returns (string memory) {
        string memory e = "eas";
        vm.serializeAddress(e, "address", EAS);
        vm.serializeAddress(e, "schemaRegistry", SCHEMA_REGISTRY);
        vm.serializeString(e, "schema", EAS_SCHEMA);
        return vm.serializeBytes32(e, "schemaUid", schemaUid);
    }

    function _limitsJson(Limits memory l) internal returns (string memory) {
        string memory li = "limits";
        vm.serializeUint(li, "maxTradeUsd", l.maxTradeUsd);
        vm.serializeUint(li, "maxEpochUsd", l.maxEpochUsd);
        vm.serializeUint(li, "maxExposureUsd", l.maxExposureUsd);
        vm.serializeUint(li, "epochDuration", l.epochDuration);
        vm.serializeUint(li, "maxSlippageBps", l.maxSlippageBps);
        vm.serializeUint(li, "maxOracleDeviationBps", l.maxOracleDeviationBps);
        vm.serializeUint(li, "maxExitDiscountBps", l.maxExitDiscountBps);
        vm.serializeUint(li, "maxOracleAge", l.maxOracleAge);
        return vm.serializeUint(li, "cooldown", l.cooldown);
    }

    function _tokenJson(string memory k, TestToken tk) internal returns (string memory) {
        vm.serializeAddress(k, "address", address(tk));
        vm.serializeString(k, "symbol", tk.symbol());
        vm.serializeUint(k, "decimals", tk.decimals());
        return vm.serializeUint(k, "faucetAmount", tk.faucetAmount());
    }

    function _marketJson(Market memory m) internal returns (string memory) {
        string memory k = string.concat("m_", m.key);
        vm.serializeAddress(k, "vault", address(m.vault));
        vm.serializeAddress(k, "adapter", address(m.adapter));
        vm.serializeAddress(k, "pool", m.pool);
        vm.serializeAddress(k, "priceToken", address(m.priceToken));
        vm.serializeAddress(k, "quoteToken", address(usdt));
        vm.serializeUint(k, "priceDecimals", m.priceToken.decimals());
        vm.serializeUint(k, "fee", FEE);
        vm.serializeUint(k, "supraPair", m.supraPair);
        vm.serializeUint(k, "initPriceSupra18", m.supraPrice);
        vm.serializeUint(k, "initSqrtPriceX96", m.sqrtPriceX96);
        vm.serializeUint(k, "poolUsd", m.poolUsd);
        vm.serializeBytes(
            k, "adapterConstructorArgs", abi.encode(SUPRA_STORAGE, m.supraPair, m.supraDescription)
        );
        return vm.serializeBytes(
            k,
            "vaultConstructorArgs",
            abi.encode(address(usdt), address(m.priceToken), address(m.adapter), SWAP_ROUTER02, m.pool, FACTORY)
        );
    }
}
