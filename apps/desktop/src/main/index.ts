import { app, BrowserWindow, ipcMain, shell, session } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DaemonEvent, MarketId } from "@ate/core";
import { MARKET_IDS } from "@ate/core";
import { EVENT_CHANNEL, IPC_METHODS, type ChatMessage, type IpcMethod, type JournalFilter, type PaymentsList, type Res, type Settings } from "../shared/bridge";
import { DaemonClient } from "./daemon";
import { approvePayment, approveStrategy, approveTrade, denyPayment, listPayments, rememberPending } from "./live";

const FIXTURES = process.env.ATE_FIXTURES === "1";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
const devUrl = process.env["ELECTRON_RENDERER_URL"];

let win: BrowserWindow | null = null;
const chatLog = new Map<string, ChatMessage[]>();
const payments: PaymentsList = { gate: "no-go", rows: [] };
let settings: Settings = { rpcUrls: [], unlockTimeoutMin: 30, daemonPort: null };

const daemon = new DaemonClient((e: DaemonEvent) => {
  handleEvent(e);
  win?.webContents.send(EVENT_CHANNEL, e);
});

function handleEvent(e: DaemonEvent): void {
  if (e.type === "chat.delta") {
    // The daemon echoes the user's turn (role "user"); main already logged it at send time.
    if ((e.data as { role?: string }).role === "user") return;
    const log = chatLog.get(e.data.sessionId) ?? [];
    const last = log[log.length - 1];
    if (last && last.role === "agent" && last.turnId === e.data.turnId) last.text += e.data.text;
    else {
      const engine = (e.data as { engine?: string }).engine;
      log.push({ id: `${e.data.turnId}:a`, role: "agent", text: e.data.text, at: e.at, turnId: e.data.turnId, ...(engine ? { engine } : {}) });
    }
    chatLog.set(e.data.sessionId, log);
  } else if (e.type === "chat.tool") {
    // name-only summary (kept for `ate chat`); the MCP layer already sent the full call with args + result
    if ((e.data as { summary?: boolean }).summary) return;
    const r = e.data.result as { error?: { code?: string; details?: unknown } } | undefined;
    if (r?.error?.code === "ATE_APPROVAL_REQUIRED") rememberPending(r.error.details);
    const log = chatLog.get(e.data.sessionId) ?? [];
    log.push({ id: `${e.data.turnId}:${log.length}`, role: "tool", text: e.data.tool, at: e.at, turnId: e.data.turnId, tool: { name: e.data.tool, args: e.data.args, result: e.data.result, decisionId: e.data.decisionId } });
    chatLog.set(e.data.sessionId, log);
  } else if (e.type === "payment.state") {
    const row = payments.rows.find((r) => r.paymentId === e.data.paymentId);
    if (row) row.state = e.data.state;
  }
}

const bad = (message: string): Res<never> => ({ ok: false, error: { code: "ATE_INTERNAL", message } });

async function invoke(method: IpcMethod, arg: any, arg2?: any): Promise<unknown> {
  switch (method) {
    case "connection":
      return FIXTURES ? { mode: "fixtures" } : daemon.connection();
    case "markets.list": {
      const r = await daemon.tool("ate_market_get", {});
      return r.ok ? { ok: true, data: r.data.markets } : r;
    }
    case "markets.get": {
      if (!(MARKET_IDS as readonly string[]).includes(arg)) return bad("unknown market");
      const r = await daemon.tool("ate_market_get", { market: arg as MarketId });
      return r.ok ? (r.data.markets[0] ? { ok: true, data: r.data.markets[0] } : bad("no market")) : r;
    }
    case "quote.get":
      return daemon.tool("ate_quote", arg);
    case "trade.propose":
      return daemon.tool("ate_propose", arg);
    case "trade.execute":
      return daemon.tool("ate_execute", { proposalId: String(arg) });
    case "trade.approve":
      // confirm mode: daemon nonce + trade body → ate-approve (Touch ID) over tradePayload → /trade/approve. The
      // renderer's `digest` is not trusted: the payload is rebuilt from the daemon's step-1 response.
      return approveTrade(daemon, String(arg));
    case "vaults.status": {
      const [st, pos] = await Promise.all([daemon.status().then((d) => ({ ok: true as const, d })).catch((e: Error) => ({ ok: false as const, e })), daemon.tool("ate_positions", {})]);
      if (!st.ok) return bad(st.e.message);
      if (!pos.ok) return pos;
      return { ok: true, data: { status: st.d, positions: pos.data } };
    }
    case "vaults.pause":
      return daemon.tool("ate_pause", { rationale: "Pause-all from desktop UI" });
    case "strategy.get":
      return daemon.tool("ate_strategy_get", {});
    case "strategy.set": {
      const r = await daemon.tool("ate_strategy_set", { patch: arg, rationale: String(arg2 ?? "desktop UI").padEnd(16, ".") });
      if (!r.ok && r.error.code === "ATE_APPROVAL_REQUIRED") rememberPending(r.error.details);
      return r;
    }
    case "strategy.approve":
      return approveStrategy(daemon, String(arg), arg2 === undefined || arg2 === null ? undefined : String(arg2));
    case "journal.list": {
      const f = (arg ?? {}) as JournalFilter;
      return daemon.tool("ate_journal_read", { limit: Math.min(f.limit ?? 100, 200), ...(f.market ? { market: f.market } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.before ? { before: f.before } : {}) });
    }
    case "journal.get":
      return daemon.tool("ate_journal_read", { id: String(arg) }).then((r) => (r.ok ? (r.data.entries[0] ? { ok: true, data: r.data.entries[0] } : bad("not found")) : r));
    case "chat.send": {
      const sessionId = String(arg);
      const text = String(arg2 ?? "").slice(0, 4000);
      const log = chatLog.get(sessionId) ?? [];
      log.push({ id: `u${Date.now()}`, role: "user", text, at: Math.floor(Date.now() / 1000) });
      chatLog.set(sessionId, log);
      try {
        const r = await daemon.chat({ sessionId, text });
        return { ok: true, data: { turnId: r.turnId } };
      } catch (e) {
        return { ok: false, error: { code: "ATE_INTERNAL", message: (e as Error).message } };
      }
    }
    case "chat.history":
      return { ok: true, data: chatLog.get(String(arg)) ?? [] };
    case "payments.list":
      return listPayments(payments);
    case "payments.approve":
      return approvePayment(String(arg), String(arg2 ?? ""));
    case "payments.deny":
      return denyPayment(String(arg));
    // ---- lane D3 (additive): supervised trader, pending approvals, proof suite
    case "trader.status":
      return daemon.call("GET", "/trader");
    case "trader.start": {
      const a = (arg ?? {}) as Record<string, unknown>;
      return daemon.call("POST", "/trader/start", {
        mode: a.mode === "propose" ? "propose" : "autonomous",
        engine: a.engine === "rules" ? "rules" : "llm",
        ...(typeof a.model === "string" ? { model: a.model } : {}),
        ...(typeof a.cycleSeconds === "number" ? { cycleSeconds: a.cycleSeconds } : {}),
      });
    }
    case "trader.stop":
      return daemon.call("POST", "/trader/stop", {});
    case "approvals.list": {
      const r = await daemon.call<{ pending: unknown[] }>("GET", "/strategy/pending");
      if (!r.ok) return r;
      for (const p of r.data.pending) rememberPending(p);
      return { ok: true, data: r.data.pending };
    }
    case "approvals.reject":
      return daemon.call("POST", "/strategy/reject", { changeId: String(arg) });
    case "proof.get":
      return daemon.call("GET", "/proof");
    case "proof.run": {
      const a = (arg ?? {}) as Record<string, unknown>;
      return daemon.call("POST", "/proof/run", { ...(typeof a.market === "string" ? { market: a.market } : {}), ...(typeof a.waitPauseSec === "number" ? { waitPauseSec: a.waitPauseSec } : {}) });
    }
    case "proof.stop":
      return daemon.call("POST", "/proof/stop", {});
    case "candidates.get":
      return daemon.tool("ate_candidates_get", (MARKET_IDS as readonly string[]).includes(arg) ? { market: arg as MarketId } : {});
    case "cycle.request":
      return daemon.call("POST", "/cycle", {});
    case "settings.get":
      return { ok: true, data: { ...settings, daemonPort: daemon.connection().port ?? null } };
    case "settings.set":
      // RPC changes need a native confirmation in main (SPEC §10.2); not persisted in v0.1 minimal.
      if (arg && "rpcUrls" in arg) return bad("RPC changes require native confirmation and ate-approve (not wired in v0.1)");
      settings = { ...settings, ...(arg ?? {}), rpcUrls: settings.rpcUrls };
      return { ok: true, data: settings };
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#0b0d10",
    title: "ATE",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    show: !process.env.ATE_SCREENSHOT_DIR,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: FIXTURES ? ["--ate-fixtures"] : [],
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(hsk\.blockscout\.com|testnet-explorer\.hskchain\.net)\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  if (process.env.ATE_SCREENSHOT_DIR) win.webContents.once("did-finish-load", () => void takeScreenshots(process.env.ATE_SCREENSHOT_DIR!));
}

const VIEWS = ["decisions", "trade", "agents", "positions", "chat", "payments"];
/** Type into a React-controlled input (selector) and optionally submit via a button (selector). */
const typeJs = (input: string, value: string, submit?: string) =>
  `(()=>{const i=document.querySelector(${JSON.stringify(input)});if(!i)return;const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(value)});i.dispatchEvent(new Event('input',{bubbles:true}));${submit ? `setTimeout(()=>document.querySelector(${JSON.stringify(submit)})?.click(),80)` : ""}})()`;
const clickText = (sel: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>x.textContent.trim()===${JSON.stringify(text)})?.click()`;

async function takeScreenshots(dir: string): Promise<void> {
  const out = resolve(dir);
  const prefix = process.env.ATE_SCREENSHOT_PREFIX ?? "";
  mkdirSync(out, { recursive: true });
  const w = win!;
  const js = (s: string) => w.webContents.executeJavaScript(s);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  w.setSize(1480, 920);
  await wait(FIXTURES ? 1500 : 4000);
  for (const v of VIEWS) {
    await js(`location.hash = "#/${v}"`);
    await wait(800);
    if (v === "chat") {
      // fixtures: canned replies; live: daemon chat turns (a loosening stop-loss shows the in-UI approval card)
      const prompts = FIXTURES ? ["How am I doing today?", "Be more aggressive"] : ["How am I doing today?", "Stop out HSK at 5%"];
      for (const q of prompts) {
        await js(typeJs(".composer input", q, ".composer button"));
        await wait(FIXTURES ? 2800 : 9000);
      }
    }
    if (v === "decisions") await js(`document.querySelector('[data-testid="row"]')?.click()`);
    if (v === "trade" && !FIXTURES) {
      await js(clickText(".chip", "$5"));
      await wait(3000);
      await js(clickText(".actions .btn", "Propose"));
    }
    if (v === "agents" && !FIXTURES) {
      await js(clickText(".chip", "aggressive"));
      await wait(4000);
      await js(`document.querySelector('[aria-label="Approve loosening change"]')?.scrollIntoView({block:"center"})`);
    }
    await wait(FIXTURES ? 1800 : 3500);
    const img = await w.webContents.capturePage();
    writeFileSync(join(out, `${prefix}${v}.png`), img.toPNG());
  }
  app.quit();
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [devUrl ? CSP.replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*").replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") : CSP] } });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  for (const m of IPC_METHODS) ipcMain.handle(`ate:${m}`, (_e, a, b) => (FIXTURES && m !== "connection" ? bad("fixtures mode") : invoke(m, a, b)));
  if (!FIXTURES) await daemon.connect();
  createWindow();
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});
app.on("window-all-closed", () => {
  daemon.close();
  if (process.platform !== "darwin" || process.env.ATE_SCREENSHOT_DIR) app.quit();
});
