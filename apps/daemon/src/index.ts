// @ate/daemon — public surface for the CLI (lane b commands; lane c's `daemon`/`mcp` delegate here),
// Lane E's approval routes (Routes/TokenRegistry/AteService.applyPendingChange) and tests.
export * from "./daemon.js";
export * from "./service.js";
export * from "./http.js";
export * from "./txqueue.js";
export * from "./positions.js";
export * from "./strategy-stub.js";
export * from "./rogue.js";
export * from "./engine.js";
export { daemonStart, mcpServe, unlockCmd, keygenCmd, doctorCmd, smokeCmd, type Ctx } from "./cli.js";
import { daemonStart, mcpServe } from "./cli.js";

/** CommandModule-shaped entries for lane c's reserved `ate daemon` / `ate mcp` (registry §3.3). */
export const daemonCommand = {
  name: "daemon",
  summary: "Run the ATE daemon (ate daemon start [--allow-rogue] [--approval-fallback=armed] [--profile WHSK=demo])",
  run: (ctx: { argv: string[]; env: NodeJS.ProcessEnv; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }) =>
    ctx.argv[0] === "start" ? daemonStart({ ...ctx, argv: ctx.argv.slice(1) }) : (ctx.stderr.write("usage: ate daemon start\n"), 2),
};
export const mcpCommand = {
  name: "mcp",
  summary: "MCP stdio proxy to the running daemon (ate mcp serve); never loads keys",
  run: (ctx: { argv: string[]; env: NodeJS.ProcessEnv; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream }) =>
    ctx.argv[0] === "serve" ? mcpServe({ ...ctx, argv: ctx.argv.slice(1) }) : (ctx.stderr.write("usage: ate mcp serve\n"), 2),
};
