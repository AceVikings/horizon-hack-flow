#!/usr/bin/env node
// ate-daemon start | mcp-serve | unlock | keygen | doctor | smoke
import { daemonStart, doctorCmd, keygenCmd, mcpServe, smokeCmd, unlockCmd, type Ctx } from "./cli.js";

const [cmd, ...argv] = process.argv.slice(2);
const ctx: Ctx = { argv, env: process.env, stdout: process.stdout, stderr: process.stderr };
const table: Record<string, (c: Ctx) => Promise<number>> = {
  start: daemonStart,
  "mcp-serve": mcpServe,
  mcp: (c) => mcpServe({ ...c, argv: c.argv.slice(1) }),
  unlock: unlockCmd,
  keygen: keygenCmd,
  doctor: doctorCmd,
  smoke: smokeCmd,
};
const fn = cmd ? table[cmd] : undefined;
if (!fn) {
  process.stderr.write("usage: ate-daemon start [--allow-rogue] [--approval-fallback=armed] [--profile WHSK=demo] [--port N] [--config path]\n       ate-daemon mcp serve | unlock | keygen | doctor | smoke --market WHSK --usd 5\n");
  process.exit(2);
}
try {
  process.exitCode = await fn(ctx);
} catch (e) {
  const err = e as { code?: string; message?: string; hint?: string };
  process.stderr.write(`ate-daemon ${cmd}: ${err.code ? `[${err.code}] ` : ""}${err.message ?? String(e)}\n${err.hint ? `hint: ${err.hint}\n` : ""}`);
  process.exitCode = 1;
}
