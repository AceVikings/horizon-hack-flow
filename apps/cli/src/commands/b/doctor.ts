// Lane B: `ate doctor` — implementation lives in @ate/daemon (shared with the ate-daemon bin).
import { doctorCmd } from "@ate/daemon";
import type { CommandModule } from "../index.js";

const cmd: CommandModule = {
  name: "doctor",
  summary: "Pre-flight checks: RPCs, chain id/heads, Supra adapter + APRO cross-check, pool TWAP/cardinality, QuoterV2 impact, vault epoch headroom, gas",
  usage: "ate doctor [--config path]",
  run: (ctx) => doctorCmd(ctx),
};
export default cmd;
