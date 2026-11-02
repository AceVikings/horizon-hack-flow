import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "@shared/bridge";
import { useApp, useRemote } from "../app";
import { ContextPanel, Inspector } from "../shell";
import { Badge, Empty } from "../ui";
import { clock } from "../format";

const PROMPTS = ["How am I doing today?", "Go to cash on HSK, keep the BTC", "Only trade BTC", "Be more conservative, stop out at 2%", "Why did you sell at 3am?", "Pause"];
const sid = (): string => {
  let s = sessionStorage.getItem("ate.chat.session");
  if (!s) { s = "ui-" + Math.random().toString(16).slice(2, 12); sessionStorage.setItem("ate.chat.session", s); }
  return s;
};

export default function Chat() {
  const { ate, vs, toast } = useApp();
  const session = useMemo(sid, []);
  const { res } = useRemote(() => ate.chat.history(session), [session]);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const msgs = res?.ok ? res.data : [];
  const last = msgs[msgs.length - 1];
  const waiting = pending && last?.role !== "agent";
  const toolRunning = pending && last?.role === "user";
  useEffect(() => { if (last && (last.role === "agent" || last.role === "tool")) setPending(last.role === "tool"); }, [last?.id, last?.text.length, last?.role]);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [msgs.length, last?.text.length]);
  const engine = vs?.ok ? vs.data.status.trader.engine : "llm";

  async function send(t: string) {
    const v = t.trim();
    if (!v) return;
    setText("");
    setPending(true);
    const r = await ate.chat.send(session, v);
    if (!r.ok) { setPending(false); toast({ kind: "error", text: `${r.error.code}: ${r.error.message}` }); }
  }

  return (
    <>
      <ContextPanel>
        <h2>Quick prompts</h2>
        <div className="qp">{PROMPTS.map((p) => <button key={p} className="chip wide" onClick={() => void send(p)}>{p}</button>)}</div>
        <h2>Engine</h2>
        <Badge tone={engine === "llm" ? "ok" : "warn"}>{engine === "llm" ? "LLM agent" : "LLM unavailable: rules fallback"}</Badge>
        <p className="small muted">Chat uses the allowlisted <code>chat</code> scope: market, candidates, quote, positions, strategy, journal, pause. No execute, no shell.</p>
        <p className="small muted">Loosening changes need a Touch ID signature; tightening applies at once.</p>
      </ContextPanel>

      <div className="chat">
        <div className="msgs" aria-live="polite">
          {msgs.length === 0 && <Empty title="Talk to the agent">Ask how you are doing, change the strategy in plain words, or pause everything. Try a quick prompt on the left.</Empty>}
          {msgs.map((m) => <Msg key={m.id} m={m} engine={engine} />)}
          {waiting && <div className="msg agent"><div className="bubble thinking"><span className="dots" aria-hidden="true">●●●</span> {toolRunning ? "thinking / calling tools…" : "thinking…"}</div></div>}
          <div ref={end} />
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or instruct… e.g. Go to cash on HSK, keep the BTC" aria-label="Message" />
          <button className="btn primary" type="submit" disabled={!text.trim()}>Send</button>
        </form>
      </div>

      <Inspector>
        <h2>Session</h2>
        <div className="mono small wrap">{session}</div>
        <h2>Tool calls</h2>
        {msgs.filter((m) => m.role === "tool").length === 0 ? <span className="muted">none yet</span> : msgs.filter((m) => m.role === "tool").map((m) => <div key={m.id} className="small"><span className="mono">{m.tool?.name}</span> <span className="muted">{clock(m.at)}</span>{m.tool?.decisionId && <div className="mono muted">{m.tool.decisionId}</div>}</div>)}
      </Inspector>
    </>
  );
}

function Msg({ m, engine }: { m: ChatMessage; engine: string }) {
  if (m.role === "tool" && m.tool) {
    const r = m.tool.result as any;
    const approval = r?.error?.code === "ATE_APPROVAL_REQUIRED";
    const clamped = r?.clamped === true || (Array.isArray(r?.changes) && r.changes.some((c: any) => c.clampedBy));
    return (
      <div className="msg agent">
        <div className="toolcard">
          <div className="th"><Badge tone={approval ? "warn" : "info"}>tool</Badge> <b className="mono">{m.tool.name}</b>{m.tool.decisionId && <span className="muted small"> → journal <span className="mono">{m.tool.decisionId}</span></span>}</div>
          {approval && <div className="notice warn" role="status"><Badge tone="warn">Touch ID required</Badge> This change loosens limits.<pre className="raw">{r.error.details?.renderedDiff}</pre></div>}
          {clamped && <div className="notice"><Badge tone="warn">clamped</Badge> The value was clamped to on-chain limits.</div>}
          <details><summary>args and result</summary><pre className="raw">{JSON.stringify({ args: m.tool.args, result: m.tool.result }, null, 2)}</pre></details>
        </div>
      </div>
    );
  }
  return (
    <div className={`msg ${m.role}`}>
      <div className="bubble">{m.text}</div>
      <div className="meta small muted">{m.role === "user" ? "you" : `agent · engine=${engine}`} · {clock(m.at)}</div>
    </div>
  );
}
