// Lane A: `ate rogue` (SPEC §22.3) — the stolen-agent-key attacker. Thin entry; the engine is ./_rogue.ts.
import { parseArgs } from "node:util";
import type { CommandModule } from "../index.js";
import { FULL_RUN, STAGE_RUN, loadLocal, resolveMarket, runRogue, type AttackId } from "./_rogue.js";

const USAGE = `ate rogue [--stage] [--market WHSK|WBTC] [--only trade_cap,exposure,slippage,pair,withdraw,set_limits,paused]
          [--fake-token 0x…] [--gas 800000] [--wait-pause <sec>] [--dry-run] [--json]
          [--rpc <url>] [--vault 0x…] [--daemon-url http://127.0.0.1:<port>]

Needs a daemon started with --allow-rogue and its rogue token in ATE_ROGUE_TOKEN (printed once to the
daemon's TTY). Each attack: hold candidate executes on the vault (cooldown + 30 s), wait out cooldown,
assert the expected code with check() (eth_call for owner-only selectors), then broadcast with fixed gas
through POST /rogue/tx so the revert lands on-chain (journalled profile=rogue). --stage runs the pitch
subset (a $5 buy with minAmountOut = 1 → ERR_SLIPPAGE, then withdraw → NotOwner) and aborts on any other
code or if a vault tx enters the queue between check() and broadcast. --dry-run only runs the check()s.
Exit code 0 only if every attempted attack reverted on-chain with the expected error.`;

const cmd: CommandModule = {
  name: "rogue",
  summary: "Rogue-agent script: every on-chain attack with the stolen agent key reverts (§22.3); --stage for the pitch",
  usage: USAGE,
  async run(ctx) {
    const { values } = parseArgs({
      args: ctx.argv,
      options: {
        stage: { type: "boolean", default: false },
        market: { type: "string" },
        only: { type: "string" },
        "fake-token": { type: "string" },
        gas: { type: "string", default: "800000" },
        "wait-pause": { type: "string", default: "0" },
        "dry-run": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        rpc: { type: "string" },
        vault: { type: "string" },
        "daemon-url": { type: "string" },
      },
    });
    const market = resolveMarket(values.market);
    const local = loadLocal(ctx.env, market);
    const rpcUrl = values.rpc ?? ctx.env.ATE_RPC_URL ?? local.rpcUrl;
    const vault = (values.vault ?? local.vault) as `0x${string}` | null;
    const daemonUrl = values["daemon-url"] ?? local.daemonUrl;
    const token = ctx.env.ATE_ROGUE_TOKEN ?? "";
    const missing = [!rpcUrl && "RPC (--rpc or config.json)", !vault && "vault (--vault or config.json)", !values["dry-run"] && !daemonUrl && "daemon (--daemon-url or runtime.json)", !values["dry-run"] && !token && "ATE_ROGUE_TOKEN"].filter(Boolean);
    if (missing.length) {
      ctx.stderr.write(`ate rogue: missing ${missing.join(", ")}\n${USAGE}\n`);
      return 2;
    }
    let attacks: AttackId[] = values.stage ? STAGE_RUN : FULL_RUN;
    if (values.only) {
      const want = values.only.split(",").map((s) => s.trim()) as AttackId[];
      const bad = want.filter((a) => !FULL_RUN.includes(a));
      if (bad.length) {
        ctx.stderr.write(`ate rogue: unknown attack(s) ${bad.join(", ")}\n`);
        return 2;
      }
      attacks = want;
    }
    const results = await runRogue({
      market,
      attacks,
      stage: values.stage,
      daemonUrl: daemonUrl ?? "",
      rogueToken: token,
      rpcUrl: rpcUrl!,
      vault: vault!,
      gas: BigInt(values.gas),
      ...(values["fake-token"] ? { fakeToken: values["fake-token"] as `0x${string}` } : {}),
      waitPauseSec: Number(values["wait-pause"]),
      dryRun: values["dry-run"],
      log: (s) => ctx.stderr.write(`${s}\n`),
    });
    if (values.json) ctx.stdout.write(JSON.stringify(results, null, 2) + "\n");
    else {
      ctx.stdout.write("attack       expected               result     tx / note\n");
      for (const r of results) ctx.stdout.write(`${r.attack.padEnd(12)} ${r.expected.padEnd(22)} ${r.status.padEnd(10)} ${r.txHash ?? ""}${r.decoded ? ` ${r.decoded}` : ""}${r.note ? ` ${r.note}` : ""}\n`);
    }
    const bad = results.filter((r) => r.status === "unexpected" || r.status === "aborted");
    const okStatus = values["dry-run"] ? "dry-run" : "reverted";
    if (values.stage) return results.length === attacks.length && results.every((r) => r.status === okStatus) ? 0 : 1;
    return bad.length ? 1 : 0;
  },
};

export default cmd;
