// `ate daemon start …` — delegates to Lane B's @ate/daemon (loaded lazily so other commands never load it).
import type { CommandModule } from "../index.js";

const cmd: CommandModule = {
  name: "daemon",
  summary: "Run the ATE daemon (ate daemon start [--allow-rogue] [--approval-fallback=armed] [--profile WHSK=demo])",
  usage: "ate daemon start [--config ~/.ate/config.json] [--port N] [--allow-rogue] [--approval-fallback=armed] [--profile WHSK=demo] [--no-scan]",
  async run(ctx) {
    const name = "@ate/daemon";
    const mod = (await import(name)) as { daemonCommand?: CommandModule };
    if (!mod.daemonCommand) throw new Error("@ate/daemon does not export daemonCommand (is it built?)");
    return mod.daemonCommand.run(ctx);
  },
};

export default cmd;
