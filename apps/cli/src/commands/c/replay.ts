// `ate replay --days 7` (§11.3 Replay, E11): both markets, pool Swap logs (Blockscout) + HashKey Global 1 m klines
// → docs/replay-7d.md. Needs no vault. Counterfactual, from logs, not realised P&L.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MARKET_IDS, MARKETS, type MarketId } from "@ate/core";
import { headline, runReplay } from "@ate/strategy/replay";
import type { CommandModule } from "../index.js";

const cmd: CommandModule = {
  name: "replay",
  summary: "Replay the last N days of both pools vs HashKey Global (counterfactual, E11) → docs/replay-7d.md",
  usage: [
    "ate replay [--days 7] [--market WHSK|WBTC] [--out docs/replay-7d.md] [--json out.json]",
    "           [--half-spread WHSK=5.7,WBTC=0.01] [--source rpc|blockscout] [--rpc URL] [--blockscout URL] [--delay-ms 1000]",
  ].join("\n"),
  async run(ctx) {
    const { values } = parseArgs({
      args: ctx.argv,
      options: {
        days: { type: "string", default: "7" },
        market: { type: "string" },
        out: { type: "string" },
        json: { type: "string" },
        "half-spread": { type: "string" },
        blockscout: { type: "string" },
        rpc: { type: "string" },
        source: { type: "string", default: "rpc" },
        "delay-ms": { type: "string" },
        quiet: { type: "boolean", default: false },
      },
      allowPositionals: false,
    });
    const days = Number(values.days);
    if (!(days > 0 && days <= 30)) throw new Error("--days must be in (0, 30]");
    const markets: MarketId[] = values.market
      ? MARKET_IDS.filter((m) => MARKETS[m].asset === values.market!.toUpperCase() || MARKETS[m].label === values.market!.toUpperCase() || m === values.market)
      : [...MARKET_IDS];
    if (markets.length === 0) throw new Error(`unknown market ${values.market}`);
    const halfSpreadBps: Partial<Record<MarketId, number>> = {};
    for (const kv of (values["half-spread"] ?? "").split(",").filter(Boolean)) {
      const [k, v] = kv.split("=");
      const m = MARKET_IDS.find((x) => MARKETS[x].asset === k?.toUpperCase() || MARKETS[x].label === k?.toUpperCase());
      if (m && v) halfSpreadBps[m] = Number(v);
    }
    const out = resolve(ctx.cwd, values.out ?? `docs/replay-${days}d.md`);
    const r = await runReplay({
      days,
      markets,
      halfSpreadBps,
      ...(values.blockscout ? { blockscout: values.blockscout } : {}),
      ...(values.rpc ? { rpcUrl: values.rpc } : {}),
      source: values.source === "blockscout" ? "blockscout" : "rpc",
      delayMs: values["delay-ms"] ? Number(values["delay-ms"]) : 1000,
      log: values.quiet ? undefined : (m) => ctx.stderr.write(m + "\n"),
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, r.markdown);
    if (values.json) writeFileSync(resolve(ctx.cwd, values.json), JSON.stringify(r.reports, null, 2));
    for (const rep of r.reports) ctx.stdout.write(headline(rep) + "\n");
    ctx.stdout.write(`wrote ${out}\n`);
    return 0;
  },
};

export default cmd;
