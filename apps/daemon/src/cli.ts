// Command implementations shared by `ate-daemon` (this package's bin) and the `ate` CLI (lane b: doctor,
// unlock, smoke; lane c's `daemon` / `mcp` commands delegate to daemonCommand / mcpCommand).

import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  AteError,
  HSKDEX,
  MARKETS,
  MARKET_IDS,
  SUPRA_PAIRS,
  deviationBps,
  e8ToUsd,
  isMarketId,
  policyVaultAbi,
  usdToE8,
  type MarketId,
  type ToolResult,
} from "@ate/core";
import { createChainClient, erc20Abi, probeRpcs } from "@ate/chain";
import { connectDaemonClient, runStdioProxy } from "@ate/mcp";
import { CexReader, MarketReader, aggregatorAbi, poolAbi, readAproCrossCheck } from "@ate/oracle";
import { HskDexAdapter } from "@ate/venues";
import { ateHome, createAgentKey, loadConfigFile, parseProfiles, readRuntime, startDaemon, DAEMON_VERSION } from "./daemon.js";

export interface Ctx {
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  if (a.includes("=")) return a.slice(a.indexOf("=") + 1);
  const n = argv[i + 1];
  return n && !n.startsWith("--") ? n : "true";
}
function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]!);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  });
  return out;
}

async function readPassphrase(ctx: Ctx, prompt = "Agent key passphrase: "): Promise<string> {
  if (ctx.env.ATE_AGENT_PASSPHRASE) return ctx.env.ATE_AGENT_PASSPHRASE;
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    throw new AteError("WalletError", "ATE_DAEMON_LOCKED", "no passphrase on stdin");
  }
  ctx.stderr.write(prompt);
  return await new Promise<string>((res) => {
    const stdin = process.stdin;
    let s = "";
    stdin.setRawMode?.(true);
    stdin.resume();
    const on = (b: Buffer) => {
      const c = b.toString("utf8");
      if (c === "\r" || c === "\n" || c === "\u0004") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.off("data", on);
        ctx.stderr.write("\n");
        res(s);
      } else if (c === "\u0003") process.exit(130);
      else if (c === "\u007f") s = s.slice(0, -1);
      else s += c;
    };
    stdin.on("data", on);
  });
}

// ------------------------------------------------------------------ daemon start

export async function daemonStart(ctx: Ctx): Promise<number> {
  const a = ctx.argv;
  const d = await startDaemon({
    env: ctx.env,
    ...(flag(a, "config") ? { config: flag(a, "config")! } : {}),
    ...(flag(a, "port") ? { port: Number(flag(a, "port")) } : {}),
    allowRogue: flag(a, "allow-rogue") === "true",
    ...(flag(a, "approval-fallback") ? { approvalFallback: flag(a, "approval-fallback") as "armed" } : {}),
    profiles: parseProfiles(flags(a, "profile")),
    scan: flag(a, "no-scan") !== "true",
    tty: (m) => ctx.stderr.write(`${m}\n`),
  });
  const stop = async () => {
    await d.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  await new Promise(() => {});
  return 0;
}

export async function mcpServe(ctx: Ctx): Promise<number> {
  const home = ateHome(ctx.env);
  const rt = readRuntime(home);
  // ATE_MCP_TOKEN (env only, never argv): a chat token from /chat/token makes this a chat-scoped proxy (§11.5).
  const token = ctx.env.ATE_MCP_TOKEN || rt.agentToken;
  const p = await runStdioProxy({ url: `http://127.0.0.1:${rt.port}/mcp`, token, version: rt.version });
  ctx.stderr.write(`ate MCP stdio proxy → http://127.0.0.1:${rt.port}/mcp (${ctx.env.ATE_MCP_TOKEN ? "token from ATE_MCP_TOKEN" : "agent scope"})\n`);
  await new Promise<void>((res) => process.stdin.on("end", () => res()));
  await p.close();
  return 0;
}

async function daemonFetch(ctx: Ctx, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const rt = readRuntime(ateHome(ctx.env));
  const r = await fetch(`http://127.0.0.1:${rt.port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${rt.agentToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

export async function unlockCmd(ctx: Ctx): Promise<number> {
  const pass = await readPassphrase(ctx);
  const r = await daemonFetch(ctx, "/unlock", { passphrase: pass });
  if (r.status !== 200) {
    ctx.stderr.write(`unlock failed: ${JSON.stringify(r.json)}\n`);
    return 1;
  }
  ctx.stdout.write(`unlocked: ${(r.json as { address: string }).address}\n`);
  return 0;
}

export async function keygenCmd(ctx: Ctx): Promise<number> {
  const home = ateHome(ctx.env);
  const cfg = loadConfigFile(flag(ctx.argv, "config") ?? join(home, "config.json"));
  const pass = await readPassphrase(ctx, "New agent key passphrase: ");
  if (pass.length < 8) throw new AteError("WalletError", "ATE_CONFIG_INVALID", "passphrase must be ≥ 8 characters");
  const r = createAgentKey(home, cfg.agentKeyId, pass, ctx.env);
  ctx.stdout.write(`agent key ${cfg.agentKeyId} created in ${r.store}: ${r.address}\nFund it with HSK gas and run setAgent(${r.address}) on both vaults (ate-owner).\n`);
  return 0;
}

// ------------------------------------------------------------------ doctor (§19 pre-flight)

export async function doctorCmd(ctx: Ctx): Promise<number> {
  const out = (s: string) => ctx.stdout.write(`${s}\n`);
  const home = ateHome(ctx.env);
  const cfg = loadConfigFile(flag(ctx.argv, "config") ?? join(home, "config.json"));
  let bad = 0;
  const mark = (okv: boolean, s: string) => {
    if (!okv) bad++;
    out(`${okv ? "  ok  " : "  FAIL"} ${s}`);
  };
  const warn = (s: string) => out(`  warn ${s}`);
  out(`ate doctor — chain ${cfg.chain.id}`);
  const probes = await probeRpcs(cfg.chain.rpcUrls);
  for (const p of probes) mark(p.chainId === cfg.chain.id, `rpc ${p.url}: chainId=${p.chainId ?? "-"} head=${p.head ?? "-"} ${p.ms}ms${p.error ? ` (${p.error})` : ""}`);
  const heads = probes.filter((p) => p.head !== null).map((p) => p.head!);
  if (heads.length >= 2) {
    const spread = Number(heads.reduce((a, b) => (a > b ? a : b)) - heads.reduce((a, b) => (a < b ? a : b)));
    mark(spread <= 10, `≥ 2 RPC heads agree (spread ${spread} blocks)`);
  } else warn("fewer than 2 healthy RPCs (§16 requires a fallback)");

  const chain = createChainClient({ urls: cfg.chain.rpcUrls, chainId: cfg.chain.id });
  const c = chain.client;
  const vaults = Object.fromEntries(cfg.vaults.map((v) => [v.market, v.address])) as Partial<Record<MarketId, `0x${string}`>>;
  const markets = MARKET_IDS.filter((m) => cfg.venues.hskdex.markets.some((x) => x.id === m));
  const oracles: Partial<Record<MarketId, `0x${string}`>> = {};
  for (const m of markets) {
    const v = vaults[m];
    if (v) oracles[m] = (await c.readContract({ address: v, abi: policyVaultAbi, functionName: "oracle" }).catch(() => undefined)) as `0x${string}` | undefined;
  }
  const apro = await readAproCrossCheck(c, markets);
  const reader = new MarketReader({ client: c, markets, vaults, oracles, maxOracleAgeSec: cfg.oracle.apro.maxAgeSec, apro: () => apro, cex: new CexReader({ baseUrl: cfg.oracle.cex.baseUrl }), supra: { storage: cfg.supra.storage as `0x${string}`, pairs: { ...SUPRA_PAIRS, ...(cfg.supra.pairs ?? {}) }, maxAgeSec: cfg.supra.maxAgeSec, maxDisagreeBps: cfg.supra.maxDisagreeBps } });
  const read = await reader.read();
  const fac = (await c.readContract({ address: cfg.venues.hskdex.router as `0x${string}`, abi: [{ type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "factory" }).catch(() => null)) as string | null;
  mark(fac?.toLowerCase() === cfg.venues.hskdex.factory.toLowerCase(), `router factory() = ${fac}`);
  const ven = new HskDexAdapter({ client: c, vaults, agent: () => null, quoter: cfg.venues.hskdex.quoter as `0x${string}` });
  for (const m of markets) {
    const s = MARKETS[m];
    const r = read.markets[m];
    out(`\n${m}${vaults[m] ? ` vault ${vaults[m]}` : " (no vault)"}`);
    if (!r) {
      mark(false, "no read");
      continue;
    }
    const P = BigInt(r.price.oracle.price);
    out(`       enforcement oracle (${oracles[m] ? `vault.oracle() = ${oracles[m]}` : `Supra pair ${SUPRA_PAIRS[m]} direct`}): $${e8ToUsd(P)} age ${r.price.oracle.ageSec}s (${r.price.oracle.health}) round ${r.price.oracle.roundId}`);
    mark(P > 0n && r.price.oracle.ageSec < cfg.oracle.apro.maxAgeSec, `oracle age ${r.price.oracle.ageSec}s < maxOracleAge ${cfg.oracle.apro.maxAgeSec}s`);
    const a = apro[m];
    if (a) {
      const age = read.blockTimestamp - a.updatedAt;
      out(`       APRO cross-check ${s.oracle}: $${e8ToUsd(a.answer)} age ${age}s answeredInRound==roundId: ${a.answeredInRound === a.roundId}; Supra vs APRO ${P > 0n ? Number(deviationBps(P, a.answer)) : "-"} bps (gate ${r.price.supra?.active ? "active" : "inactive"}, max ${cfg.supra.maxDisagreeBps})`);
    } else warn("APRO cross-check read failed");
    const dec = (await c.readContract({ address: oracles[m] ?? s.oracle, abi: aggregatorAbi, functionName: "decimals" }).catch(() => null)) as number | null;
    if (oracles[m]) mark(dec === 8, `oracle decimals() = ${dec}`);
    out(`       pool $${e8ToUsd(BigInt(r.price.pool.price))} TWAP ${r.price.pool.twap ? `$${e8ToUsd(BigInt(r.price.pool.twap))}` : "n/a"} dev ${r.price.pool.deviationBps} / ${r.price.pool.twapDeviationBps ?? "-"} bps; CEX ${r.price.cex ? `$${e8ToUsd(BigInt(r.price.cex.mid))} (half-spread ${r.price.cex.halfSpreadBps} bps)` : "unavailable"}`);
    mark(r.price.pool.observationCardinality >= 64, `observationCardinality ${r.price.pool.observationCardinality} ≥ 64`);
    mark(r.price.pool.twap !== null, "observe([300, 0]) succeeds");
    const lim = r.vault?.limits.maxOracleDeviationBps ?? 250;
    if (r.price.pool.deviationBps > lim || (r.price.pool.twapDeviationBps ?? 0) > lim) warn(`pool vs oracle beyond ${lim} bps: normal-path buys will revert (exit path only)`);
    const [fee, t0, t1] = await Promise.all([
      c.readContract({ address: s.pool, abi: poolAbi, functionName: "fee" }).catch(() => null),
      c.readContract({ address: s.pool, abi: poolAbi, functionName: "token0" }).catch(() => null),
      c.readContract({ address: s.pool, abi: poolAbi, functionName: "token1" }).catch(() => null),
    ]);
    mark(fee === 3000 && String(t0).toLowerCase() === s.baseToken.toLowerCase() && String(t1).toLowerCase() === s.quoteToken.toLowerCase(), `pool fee ${fee}, token0 ${s.base}, token1 USDT`);
    if (r.vault) {
      const v = r.vault;
      out(`       vault paused=${v.paused} agent=${v.agent} balances ${e8ToUsd(BigInt(v.balanceQuote) * 100n)} USDT / ${v.balancePrice} ${s.base} exposure $${e8ToUsd(BigInt(v.exposureUsdE8))}`);
      const head = BigInt(v.epoch.capUsdE8) - BigInt(v.epoch.spentUsdE8);
      out(`       epoch headroom $${e8ToUsd(head > 0n ? head : 0n)} (spent $${e8ToUsd(BigInt(v.epoch.spentUsdE8))} of $${e8ToUsd(BigInt(v.epoch.capUsdE8))}), maxTrade $${e8ToUsd(BigInt(v.limits.maxTradeUsdE8))}`);
      mark(!v.paused, "vault not paused");
    }
    for (const usd of ["5", "25", "100"]) {
      try {
        const q = await ven.rawQuote(m, "buy", usdToE8(usd) / 100n);
        out(`       QuoterV2 buy $${usd}: impact ${q.impactBps} bps (incl. 30 bps fee)`);
      } catch (e) {
        warn(`QuoterV2 $${usd}: ${(e as Error).message}`);
      }
    }
  }
  // agent gas
  try {
    const rt = readRuntime(home);
    const st = (await (await fetch(`http://127.0.0.1:${rt.port}/status`, { headers: { authorization: `Bearer ${rt.agentToken}` } })).json()) as { gas: { agentHsk: string }; locked: boolean };
    mark(Number(st.gas.agentHsk) >= Number(cfg.daemon.gasAlarmHsk), `agent gas ${st.gas.agentHsk} HSK ≥ ${cfg.daemon.gasAlarmHsk} (daemon ${st.locked ? "locked" : "unlocked"})`);
  } catch {
    warn("daemon not running: agent gas not checked");
  }
  out(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
  void erc20Abi;
  void HSKDEX;
  return bad ? 1 : 0;
}

// ------------------------------------------------------------------ smoke (§19 step 6)

export async function smokeCmd(ctx: Ctx): Promise<number> {
  const out = (s: string) => ctx.stdout.write(`${s}\n`);
  const market = flag(ctx.argv, "market") ?? "hsk-dex:WHSK/USDT:3000";
  const usd = flag(ctx.argv, "usd") ?? "5";
  const m = market === "WHSK" || market === "HSK" ? "hsk-dex:WHSK/USDT:3000" : market === "WBTC" || market === "BTC" ? "hsk-dex:WBTC/USDT:3000" : market;
  if (!isMarketId(m)) throw new AteError("VenueError", "ATE_MARKET_UNKNOWN", `unknown market ${market}`);
  const s = await daemonFetch(ctx, "/smoke", { market: m, usd });
  if (s.status !== 200) throw new AteError("InternalError", "ATE_INTERNAL", `smoke candidate refused: ${JSON.stringify(s.json)}`);
  const cand = (s.json as { candidate: { candidateId: string; maxAmountIn: string } }).candidate;
  out(`smoke candidate ${cand.candidateId} (buy ${usd} USD on ${m}, engine=rules)`);
  const rt = readRuntime(ateHome(ctx.env));
  const client = await connectDaemonClient(`http://127.0.0.1:${rt.port}/mcp`, s.json && (s.json as { token: string }).token ? (s.json as { token: string }).token : rt.agentToken);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return JSON.parse(r.content[0]!.text) as ToolResult<Record<string, unknown>>;
  };
  try {
    const p = await call("ate_propose", { market: m, side: "buy", amountIn: cand.maxAmountIn, candidateId: cand.candidateId, rationale: `ate smoke: one-shot $${usd} buy proving propose → execute → TradeExecuted + EAS (labelled smoke)` });
    if (!p.ok) {
      out(`propose rejected: ${JSON.stringify(p.error)}`);
      return 1;
    }
    out(`proposal ${p.data.proposalId} journalHash ${p.data.journalHash}`);
    const e = await call("ate_execute", { proposalId: p.data.proposalId });
    if (!e.ok) {
      out(`execute failed: ${JSON.stringify(e.error)}`);
      return 1;
    }
    out(`executed tx ${e.data.txHash} block ${e.data.blockNumber} amountOut ${e.data.amountOut} notional $${e8ToUsd(BigInt(String(e.data.notionalUsdE8)))} attestation ${JSON.stringify(e.data.attestation)}`);
    let explorer = "https://hsk.blockscout.com";
    try {
      explorer = loadConfigFile(flag(ctx.argv, "config") ?? join(ateHome(ctx.env), "config.json")).chain.explorer.replace(/\/$/, "");
    } catch {
      /* default */
    }
    out(`${explorer}/tx/${e.data.txHash}`);
    return 0;
  } finally {
    await client.close();
  }
}

export const VERSION = DAEMON_VERSION;
