// Lane B: `ate smoke` — implementation lives in @ate/daemon (shared with the ate-daemon bin).
import { smokeCmd } from "@ate/daemon";
import type { CommandModule } from "../index.js";

const cmd: CommandModule = {
  name: "smoke",
  summary: "One-shot autonomous rules-engine smoke trade via MCP (propose → execute → TradeExecuted + EAS)",
  usage: "ate smoke --market WHSK|WBTC --usd 5",
  run: (ctx) => smokeCmd(ctx),
};
export default cmd;
