// Ask (Flow v1, simplified per docs/design/flow/SIMPLIFY.md): the front door. A calm single-column conversation with
// the in-app agent (daemon /chat → chat scope + allowlist). Tool calls collapse to one plain line with "Show details".
// Changes that take more risk, or sell right now ("go to cash"), wait in the conversation for a Touch ID confirmation
// (FLOW.md journey C: tightening that sells immediately still asks). The input sits at the end of the column.
import { useEffect, useMemo, useRef, useState } from "react";
import { MARKETS, type MarketId, type PositionsOutput } from "@ate/core";
import type { AiHealth, ChatMessage, PendingChange, Res } from "@shared/bridge";
import { aiMissing } from "@shared/bridge";
import { useApp, useNow, useRemote } from "../src/app";
import { baseDecimals, fmtUnits } from "../src/format";
import { PageHead, useNav } from "../src/shell";
import { Btn, Pill, TxLink } from "../src/ui";
import { ToolResultBlock } from "../src/charts";
import { CodeApprove, approveRiskier } from "./approveCode";
import type { ViewProps } from "./registry";

const PROMPTS = ["How am I doing?", "Show me BTC price today", "Stop trading", "Go to cash"];
const SESSION_KEY = "flow.ask.session";
const session = (): string => {
  let s = sessionStorage.getItem(SESSION_KEY);
  if (!s) {
    s = `ask_${Math.random().toString(36).slice(2, 12)}`;
    sessionStorage.setItem(SESSION_KEY, s);
  }
  return s;
};

const LINE: Record<string, string> = {
  ate_positions: "Checked your positions",
  ate_market_get: "Looked up prices",
  ate_candidates_get: "Checked trade ideas",
  ate_quote: "Got a quote",
  ate_strategy_get: "Read your settings",
  ate_strategy_set: "Changed your settings",
  ate_journal_read: "Read the activity log",
  ate_pause: "Paused both vaults",
  ate_chart: "Made a chart",
  ate_data: "Pulled the data",
};
const FIELD: Record<string, string> = { stopLossBps: "Sell-if-down", takeProfitBps: "Take profit", tradeSizeUsd: "Trade size", entrySpreadBps: "Entry gap", minNetEdgeBps: "Min edge", targetAssets: "Holds", cycleSeconds: "Checks every", maxPositionUsd: "Max position", enabled: "Trading" };
const val = (f: string, v: unknown) => (Array.isArray(v) ? (v.length ? v.map((x) => String(x).replace(/^W/, "")).join(", ") : "cash only") : f.endsWith("Bps") ? `${Number(v) / 100}%` : f.endsWith("Usd") ? `$${Number(v)}` : String(v));
const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const money = (s: string) => {
  const n = Number(s);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
};

/** Hide internal ids and helper names from agent replies (the card above already shows the change). */
const plain = (t: string) =>
  t
    .split("\n")
    .filter((l) => !/changeId|ate-approve|chg_[0-9a-f]{8}|^(portfolio|hsk-dex:)\S* \w+: /.test(l))
    .join("\n")
    .trim();

type ToolRes = { ok?: boolean; data?: unknown; error?: { code?: string; message?: string; details?: PendingChange } } | undefined;
type Block = { kind: "user"; m: ChatMessage } | { kind: "agent"; parts: ChatMessage[] };

export default function Ask(_: ViewProps) {
  const { ate, toast, tick } = useApp();
  const go = useNav();
  const now = useNow(1000);
  const sid = useMemo(session, []);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [decided, setDecided] = useState<Record<string, "ok" | "no" | "busy">>({});
  const end = useRef<HTMLDivElement>(null);
  const hist = useRemote<ChatMessage[]>(() => ate.chat.history(sid), [sid]);
  const ai = useRemote<AiHealth>(() => (ate.ai ? ate.ai.health() : Promise.resolve({ ok: false, error: { code: "ATE_INTERNAL", message: "offline" } } as Res<AiHealth>)), [], { every: 30000, onEvents: false });
  const msgs = (hist.last ?? []).filter((m) => !(m.role === "agent" && !m.text.trim()));

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [msgs.length, tick]);

  const blocks: Block[] = [];
  for (const m of msgs) {
    if (m.role === "user") blocks.push({ kind: "user", m });
    else {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "agent") last.parts.push(m);
      else blocks.push({ kind: "agent", parts: [m] });
    }
  }
  const waiting = sending || (msgs.length > 0 && msgs[msgs.length - 1]!.role === "user");

  const send = async (q: string) => {
    const t = q.trim();
    if (!t || sending) return;
    setSending(true);
    setText("");
    const r = await ate.chat.send(sid, t);
    if (!r.ok) toast({ kind: "error", text: r.error.message });
    hist.reload();
    setTimeout(() => setSending(false), 1200);
  };
  const [codes, setCodes] = useState<Record<string, { code: string; expiresAt: number } | null>>({});
  const confirm = async (p: PendingChange) => {
    setDecided((d) => ({ ...d, [p.changeId]: "busy" }));
    const fail = (m: string) => {
      setDecided((d) => {
        const n = { ...d };
        delete n[p.changeId];
        return n;
      });
      toast({ kind: "error", text: m });
    };
    if (p.confirm === "sells_now") {
      // go to cash only tightens risk: a plain confirm, no Touch ID
      const r = ate.approvals ? await ate.approvals.confirm(p.changeId) : null;
      if (r?.ok) {
        setDecided((d) => ({ ...d, [p.changeId]: "ok" }));
        toast({ kind: "ok", text: "Done. The vault is selling now." });
      } else fail(r && !r.ok ? r.error.message : "offline");
      return;
    }
    const r = await approveRiskier(ate, p.changeId);
    if (r.done) {
      setDecided((d) => ({ ...d, [p.changeId]: "ok" }));
      toast({ kind: "ok", text: "Approved and applied." });
    } else if (r.code) {
      setDecided((d) => ({ ...d, [p.changeId]: "busy" }));
      setCodes((c) => ({ ...c, [p.changeId]: r.code }));
    } else fail(r.message);
  };
  const cancel = async (p: PendingChange) => {
    setDecided((d) => ({ ...d, [p.changeId]: "no" }));
    if (ate.approvals) await ate.approvals.reject(p.changeId);
  };

  const codeEntry = (p: PendingChange) =>
    codes[p.changeId] ? (
      <CodeApprove
        ate={ate}
        changeId={p.changeId}
        code={codes[p.changeId]!}
        onDone={(ok, m) => {
          setDecided((d) => ({ ...d, [p.changeId]: ok ? "ok" : "busy" }));
          if (ok) setCodes((c) => ({ ...c, [p.changeId]: null }));
          toast(ok ? { kind: "ok", text: "Approved and applied." } : { kind: "error", text: m ?? "Code rejected" });
        }}
      />
    ) : null;
  const engine = ai.last ? (aiMissing(ai.last) ? "simple answers until you connect a subscription" : ai.last.engine === "claude-code" ? `${ai.last.modelLabel} · Claude Code` : ai.last.modelLabel) : null;

  return (
    <div className="page1" style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
      <PageHead title="Ask" sub={engine ? `Ask anything about your money or tell the agent what to do. · ${engine}` : "Ask anything about your money or tell the agent what to do."} />

      <div className="msgs" style={{ flex: 1, overflow: "visible" }} aria-live="polite">
        {blocks.length === 0 && !waiting && (
          <div style={{ padding: "8px 0 4px" }}>
            <div className="sentence" style={{ fontSize: 20 }}>What would you like to know?</div>
            {ai.last && aiMissing(ai.last) && (
              <div className="sm fg2" style={{ marginTop: 8 }}>
                Answers are simple until you connect your Claude or ChatGPT subscription.{" "}
                <button className="disclose" style={{ padding: 0 }} onClick={() => go("accounts")}>
                  Connect one
                </button>
              </div>
            )}
          </div>
        )}
        {blocks.map((b, i) =>
          b.kind === "user" ? (
            <div key={b.m.id} className="mu">
              {b.m.text}
            </div>
          ) : (
            <div key={`a${i}`} className="ma" style={{ maxWidth: 720 }}>
              <div className="who">
                <i>F</i>Flow
              </div>
              {b.parts.map((p) =>
                p.role === "agent" ? (
                  <div key={p.id} style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>
                    {plain(p.text)}
                  </div>
                ) : (
                  <ToolLine key={p.id} m={p} open={!!open[p.id]} onToggle={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))} now={now} decided={decided} onConfirm={confirm} onCancel={cancel} code={codeEntry} />
                ),
              )}
            </div>
          ),
        )}
        {waiting && (
          <div className="ma" aria-busy="true">
            <div className="who">
              <i>F</i>Flow
            </div>
            <span className="fg2">Thinking…</span>
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="qps" style={{ marginTop: 18 }}>
        {PROMPTS.map((q) => (
          <Pill key={q} onClick={() => void send(q)}>
            {q}
          </Pill>
        ))}
      </div>
      <form
        className="composer"
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input aria-label="Message" placeholder="Ask Flow or tell it what to do…" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} style={{ flex: 1, border: 0, outline: "none", background: "transparent", font: "inherit", fontSize: 14 }} />
        <span className="xs fg2">⏎ send</span>
        <Btn kind="solid" size="sm" type="submit" disabled={!text.trim() || sending}>
          Send
        </Btn>
      </form>
    </div>
  );
}

function ToolLine({ m, open, onToggle, now, decided, onConfirm, onCancel, code }: { m: ChatMessage; open: boolean; onToggle(): void; now: number; decided: Record<string, "ok" | "no" | "busy">; onConfirm(p: PendingChange): void; onCancel(p: PendingChange): void; code(p: PendingChange): React.ReactNode }) {
  const name = m.tool?.name ?? m.text;
  const res = m.tool?.result as ToolRes;
  const pending = res?.ok === false && res.error?.code === "ATE_APPROVAL_REQUIRED" ? res.error.details : undefined;
  if (pending) {
    const d = decided[pending.changeId];
    const expired = pending.expiresAt <= now;
    const sells = pending.confirm === "sells_now";
    return (
      <section className="tc" style={{ borderColor: "var(--c)", borderWidth: 1.5 }} aria-label="Needs your OK">
        <div className="tch" style={{ background: "var(--y)" }}>
          <b>{sells ? "Sell now?" : "Take more risk?"}</b>
          <span className="grow" />
          <span className="xs">{d === "ok" ? "confirmed" : d === "no" ? "cancelled" : expired ? "expired" : `expires in ${mmss(pending.expiresAt - now)}`}</span>
        </div>
        <div className="tcb">
          {pending.diff.map((x) => (
            <div key={`${x.scope}${x.field}`} className="sm">
              {FIELD[x.field] ?? x.field}
              {x.scope !== "portfolio" ? ` (${MARKETS[x.scope as MarketId]?.asset.replace(/^W/, "") ?? x.scope})` : ""}: <s className="fg2">{val(x.field, x.before)}</s> → <b>{val(x.field, x.after)}</b>
            </div>
          ))}
          {sells && <div className="sm" style={{ marginTop: 6 }}>The vault sells it straight away. It never sells below its price floor.</div>}
          {!d && !expired && (
            <div className="row g10" style={{ marginTop: 12 }}>
              <Btn kind="pri" onClick={() => onConfirm(pending)}>
                {sells ? "Sell now" : "Approve with Touch ID"}
              </Btn>
              <Btn onClick={() => onCancel(pending)}>{sells ? "Keep it" : "Cancel"}</Btn>
            </div>
          )}
          {d === "busy" && !expired && code(pending)}
          {d === "busy" && !code(pending) && !sells && <div className="sm fg2" style={{ marginTop: 10 }}>Waiting for Touch ID…</div>}
        </div>
      </section>
    );
  }
  // charts and tables (D4) are drawn inline under the reply, with Pin → Charts
  if ((name === "ate_chart" || name === "ate_data") && res?.ok) {
    return (
      <div style={{ margin: "8px 0" }}>
        <ToolResultBlock tool={name} result={res} />
      </div>
    );
  }
  const failed = res?.ok === false;
  const line = failed ? `${LINE[name] ?? name} — couldn't: ${res?.error?.message ?? "error"}` : (LINE[name] ?? name.replace(/^ate_/, "").replace(/_/g, " "));
  return (
    <div className="xs fg2" style={{ margin: "6px 0" }}>
      <span aria-hidden="true">{failed ? "✕" : "✓"} </span>
      {line}
      {" · "}
      <button className="disclose xs" style={{ padding: 0, fontSize: 12 }} aria-expanded={open} onClick={onToggle}>
        {open ? "Hide details" : "Show details"}
      </button>
      {open && <Details name={name} args={m.tool?.args} res={res} />}
    </div>
  );
}

function Details({ name, args, res }: { name: string; args: unknown; res: ToolRes }) {
  if (name === "ate_positions" && res?.ok) {
    const d = res.data as PositionsOutput;
    return (
      <div className="tc" style={{ marginTop: 8 }}>
        <div className="tcb" style={{ padding: "6px 14px" }}>
          <table className="tbl cmp sm">
            <thead>
              <tr>
                <th>Market</th>
                <th className="r">Holding</th>
                <th className="r">Made so far</th>
                <th className="r">If sold now</th>
              </tr>
            </thead>
            <tbody>
              {d.markets.map((p) => (
                <tr key={p.market}>
                  <td className="b7">{MARKETS[p.market].label}</td>
                  <td className="r num">
                    {fmtUnits(p.qty, baseDecimals(p.market), 2)} {MARKETS[p.market].asset.replace(/^W/, "")}
                  </td>
                  <td className="r num">{money(p.realisedUsd)}</td>
                  <td className="r num">{money(p.unrealisedExitUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  const tx = (res?.data as { txHash?: string; txHashes?: string[] } | undefined)?.txHash;
  return (
    <div className="tc" style={{ marginTop: 8 }}>
      <div className="tcb" style={{ padding: "8px 14px" }}>
        {tx && (
          <div className="sm" style={{ marginBottom: 6 }}>
            Transaction <TxLink hash={tx} />
          </div>
        )}
        <pre className="mono xs" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>
          {JSON.stringify({ asked: args ?? {}, answer: res?.ok ? res.data : res?.error }, null, 1).slice(0, 3000)}
        </pre>
      </div>
    </div>
  );
}
