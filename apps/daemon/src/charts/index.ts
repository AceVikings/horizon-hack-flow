// Lane D4 (additive): wires ChartService to the daemon (vault chain, lazy mainnet read-only client, HashKey Global).
import type Database from "better-sqlite3";
import type { AteConfig } from "@ate/core";
import { createChainClient, type ChainClient } from "@ate/chain";
import type { Journal } from "@ate/journal";
import { CexReader } from "@ate/oracle";
import type { AteService } from "../service.js";
import { ChartService, type ChainHandle } from "./service.js";

export { ChartService } from "./service.js";
export * from "./indicators.js";
export { SwapIndex, bucketCandles, decodeSwap } from "./swaps.js";

const MAINNET_RPC = ["https://mainnet.hsk.xyz"];

export function createChartService(o: { cfg: AteConfig; db: Database.Database; journal: Journal; chain: ChainClient; service: AteService; log?: (m: string) => void }): ChartService {
  const vault: ChainHandle = { chainId: o.cfg.chain.id, rpc: o.chain.rpc, client: o.chain.client };
  let main: ChainHandle | null = o.cfg.chain.id === 177 ? vault : null;
  return new ChartService({
    db: o.db,
    journal: o.journal,
    vaultChain: vault,
    mainnet: () => {
      if (!main) {
        const c = createChainClient({ urls: process.env.ATE_MAINNET_RPC ? process.env.ATE_MAINNET_RPC.split(",") : MAINNET_RPC, chainId: 177, ...(o.log ? { log: o.log } : {}) });
        main = { chainId: 177, rpc: c.rpc, client: c.client };
      }
      return main;
    },
    cex: new CexReader({ baseUrl: o.cfg.oracle.cex.baseUrl }),
    snapshot: () => o.service.refresh(30).catch(() => null),
    strategy: () => o.service.strategy,
    vaults: () => o.service.vaults,
  });
}
