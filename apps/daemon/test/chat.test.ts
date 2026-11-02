// Chat turns across engines: a session that started on the in-app engine and moves to the Claude Code CLI must
// start the CLI conversation (not `--resume` one that never existed), and a failed AI turn is a plain error with
// no rules help text.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "@ate/journal";
import { RULES_HELP } from "@ate/chat";

const sdkTurn = vi.fn();
vi.mock("../src/engine-agents.js", () => ({ runSdkChatTurn: (...a: unknown[]) => sdkTurn(...a) }));
const { registerChatRoutes } = await import("../src/chat.js");

type Handler = (c: { body: unknown; auth: unknown; json: (s: number, b: unknown) => void }) => unknown;

function setup(ai: { config: { engine: string; provider: string }; available(): boolean; chosen: boolean }) {
  const db = new Database(":memory:");
  migrate(db);
  const handlers = new Map<string, Handler>();
  const events: { type: string; data: Record<string, unknown> }[] = [];
  registerChatRoutes({
    routes: { register: (r: { path: string; handler: Handler }) => handlers.set(r.path, r.handler) } as never,
    tokens: { mint: () => "chat-token", revoke: () => {} } as never,
    service: { o: { db } } as never,
    home: tmpdir(),
    emit: (e) => events.push(e as never),
    ai: ai as never,
  });
  const send = async (text: string) => {
    let res: { turnId?: string } = {};
    await handlers.get("/chat")!({ body: { sessionId: "ask_test", text }, auth: { scope: "ui" }, json: (_s, b) => (res = b as never) });
    for (let i = 0; i < 800; i++) {
      const done = events.find((e) => e.type === "chat.delta" && e.data.turnId === res.turnId && e.data.done === true);
      if (done) return done.data as { text: string; engine?: string; error?: boolean };
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("turn did not finish");
  };
  return { send };
}

const Q = "Chart the BTC pool on HSKSwap, 1h candles for 3 days with EMA 50 and RSI 14. Draw support and resistance and tell me what you find.";
let dir = "";
const prevBin = process.env.ATE_CLAUDE_BIN;

beforeEach(() => {
  sdkTurn.mockReset();
  dir = mkdtempSync(join(tmpdir(), "ate-chat-"));
  // fake `claude`: logs its args; `--resume` of a conversation it never started fails like the real CLI
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
D="${dir}"
echo "$@" >> "$D/args.log"
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id) touch "$D/s-$2"; shift;;
    --resume) [ -f "$D/s-$2" ] || { echo "No conversation found with session ID: $2" >&2; exit 1; }; shift;;
  esac
  shift
done
echo '{"type":"result","subtype":"success","is_error":false,"result":"cli analysis"}'
`,
  );
  chmodSync(bin, 0o755);
  process.env.ATE_CLAUDE_BIN = bin;
});
afterEach(() => {
  if (prevBin === undefined) delete process.env.ATE_CLAUDE_BIN;
  else process.env.ATE_CLAUDE_BIN = prevBin;
});

describe("chat follow-up turns", { timeout: 30_000 }, () => {
  it("in-app turn, then the Claude Code engine: the CLI conversation starts fresh and every turn gets an AI reply", async () => {
    const ai = { config: { engine: "sdk", provider: "anthropic" }, available: () => true, chosen: true };
    const c = setup(ai);
    sdkTurn.mockResolvedValue({ reply: "sdk analysis", engine: "llm" });
    const t1 = await c.send(Q);
    expect(t1).toMatchObject({ text: "sdk analysis", engine: "llm" });
    ai.config.engine = "claude-code";
    const t2 = await c.send(Q);
    const t3 = await c.send(Q);
    for (const t of [t2, t3]) expect(t).toMatchObject({ text: "cli analysis", engine: "llm" });
    // one fresh CLI conversation (--session-id) then a --resume of it; no stale --resume of an id the CLI never saw
    const log = readFileSync(join(dir, "args.log"), "utf8");
    const flags = [...log.matchAll(/--(session-id|resume) /g)].map((m) => m[1]);
    expect(flags).toEqual(["session-id", "resume"]);
  });

  it("Claude Code engine from the start: first turn --session-id, follow-ups --resume, all AI replies", async () => {
    const ai = { config: { engine: "claude-code", provider: "anthropic" }, available: () => true, chosen: true };
    const c = setup(ai);
    for (let i = 0; i < 3; i++) expect(await c.send(Q)).toMatchObject({ text: "cli analysis", engine: "llm" });
  });

  it("a failed AI turn is a plain error, never the rules help", async () => {
    const ai = { config: { engine: "sdk", provider: "anthropic" }, available: () => true, chosen: true };
    const c = setup(ai);
    sdkTurn.mockResolvedValueOnce({ reply: "first", engine: "llm" });
    await c.send(Q);
    sdkTurn.mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 529 }));
    const t2 = await c.send(Q);
    expect(t2.error).toBe(true);
    expect(t2.text).toMatch(/^The AI didn't answer \(.+\)\. Try again\.$/);
    expect(t2.text).not.toContain(RULES_HELP.slice(0, 20));
  });

  it("an AI engine is chosen but unreachable: a free-form question gets the error, not the rules help", async () => {
    const c = setup({ config: { engine: "sdk", provider: "subscription" }, available: () => false, chosen: true });
    const t = await c.send(Q);
    expect(t.error).toBe(true);
    expect(t.text).toContain("The AI didn't answer");
  });
});
