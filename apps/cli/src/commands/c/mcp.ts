// `ate mcp serve` — MCP stdio proxy to the running daemon (agent scope); delegates to Lane B's @ate/daemon.
import type { CommandModule } from "../index.js";

const cmd: CommandModule = {
  name: "mcp",
  summary: "MCP stdio proxy to the running daemon (ate mcp serve); never loads keys",
  usage: "ate mcp serve",
  async run(ctx) {
    const name = "@ate/daemon";
    const mod = (await import(name)) as { mcpCommand?: CommandModule };
    if (!mod.mcpCommand) throw new Error("@ate/daemon does not export mcpCommand (is it built?)");
    return mod.mcpCommand.run(ctx);
  },
};

export default cmd;
