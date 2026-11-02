// Lane B: `ate unlock` — implementation lives in @ate/daemon (shared with the ate-daemon bin).
import { unlockCmd } from "@ate/daemon";
import type { CommandModule } from "../index.js";

const cmd: CommandModule = {
  name: "unlock",
  summary: "Unlock the running daemon's agent key (passphrase from TTY, stdin or ATE_AGENT_PASSPHRASE)",
  usage: "ate unlock",
  run: (ctx) => unlockCmd(ctx),
};
export default cmd;
