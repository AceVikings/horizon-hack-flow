// Ask extras (Flow v1): the chat model picker next to the composer (Ask's own model, persisted; the Agent screen keeps
// the trader's) and the "Tools (MCP)" sheet — Flow's server, the user's opencode servers and servers added in Flow,
// each enabled for Ask and for the trader separately (the trader needs Touch ID to get another server's tools).
import { useEffect, useMemo, useState } from "react";
import type { EngineProvider, EngineProviders, McpServerInfo, Res } from "@shared/bridge";
import { useApp, useRemote } from "../src/app";
import { Btn, Dialog } from "../src/ui";
import { curate } from "./setup/Opencode";

const offline = <T,>(): Promise<Res<T>> => Promise.resolve({ ok: false, error: { code: "ATE_INTERNAL" as never, message: "needs the live daemon" } });

/** Compact "Model: …" button; opens the picker (curated list per connected provider, search over all). */
export function ChatModelPicker() {
  const { ate, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const prov = useRemote<EngineProviders>(() => (ate.engine ? ate.engine.providers() : offline()), [open], { onEvents: false });
  const p = prov.last;
  const usable = (p?.providers ?? []).filter((x) => x.configured);
  const chat = p?.chat;
  const labelOf = (pid: string, mid: string) => p?.providers.find((x) => x.id === pid)?.models.find((m) => m.id === mid)?.label ?? mid;
  const current = chat ? labelOf(chat.provider, chat.model) || "best available" : "…";
  const pick = async (provider: EngineProvider["id"] | null, model?: string) => {
    if (!ate.engine) return;
    const r = await ate.engine.selectChat(provider, model);
    if (!r.ok) return toast({ kind: "error", text: r.error.message });
    toast({ kind: "ok", text: provider ? `Ask now uses ${labelOf(provider, model!)}` : "Ask follows the Agent's model" });
    setOpen(false);
    prov.reload();
  };
  // load model lists for connected providers that have none cached yet (e.g. OpenCode on first open)
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !ate.engine || !p) return;
    const missing = p.providers.filter((x) => x.configured && x.models.length === 0 && !x.health);
    if (!missing.length) return;
    setLoading(true);
    void Promise.all(missing.map((x) => ate.engine!.test(x.id))).finally(() => {
      setLoading(false);
      prov.reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, p?.providers.length]);
  const lists = useMemo(
    () =>
      usable
        .filter((x) => x.models.some((m) => m.tools !== false))
        .map((x) => {
        const tools = x.models.filter((m) => m.tools !== false);
        const ids = tools.map((m) => m.id);
        const short = x.id === "opencode" || x.id === "subscription" || x.id === "openrouter" ? curate(ids) : ids.slice(0, 6);
        return { prov: x, short: tools.filter((m) => short.includes(m.id)), all: tools };
      }),
    [usable],
  );
  const needle = q.trim().toLowerCase();
  return (
    <>
      <button type="button" className="disclose sm" onClick={() => setOpen(true)} aria-haspopup="dialog" title="Model used by Ask">
        Model: <b>{current}</b>
        {chat && !chat.own && <span className="fg2"> (same as Agent)</span>}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} eyebrow="Ask" title="Model" footer={<Btn onClick={() => setOpen(false)}>Done</Btn>} width={620}>
        <div className="sm fg2" style={{ marginBottom: 10 }}>Ask can use a different model from the trader. The trader's model is set on the Agent screen.</div>
        <label className="row g8 sm" style={{ alignItems: "center", marginBottom: 12 }}>
          <input type="radio" name="askmodel" checked={!!chat && !chat.own} onChange={() => void pick(null)} /> Same as the Agent
        </label>
        {loading && <div className="sm fg2">Loading models…</div>}
        {!loading && lists.length === 0 && <div className="sm">No model provider is connected yet. Connect one in Accounts.</div>}
        {lists.map(({ prov: x, short, all: everything }) => {
          const shown = all ? everything.filter((m) => !needle || m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle)) : short;
          return (
            <div key={x.id} style={{ marginTop: 12 }}>
              <div className="b7 sm">{x.id === "subscription" ? "Your subscriptions" : x.label}</div>
              {shown.slice(0, 60).map((m) => (
                <label key={m.id} className="row g8 sm" style={{ alignItems: "center", padding: "4px 0" }}>
                  <input type="radio" name="askmodel" checked={!!chat?.own && chat.provider === x.id && chat.model === m.id} onChange={() => void pick(x.id, m.id)} />
                  {m.label}
                  <span className="xs fg2 mono">{m.id}</span>
                </label>
              ))}
              {all && shown.length > 60 && <div className="xs fg2">…{shown.length - 60} more: refine the search</div>}
            </div>
          );
        })}
        <div className="row g10" style={{ marginTop: 14, alignItems: "center" }}>
          <button type="button" className="disclose sm" onClick={() => setAll(!all)} aria-expanded={all}>
            {all ? "Show the short list" : "Show all models"}
          </button>
          {all && <input className="inp" style={{ height: 32, maxWidth: 260 }} placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" />}
        </div>
      </Dialog>
    </>
  );
}

const STATE: Record<McpServerInfo["state"], [string, string]> = { connected: ["✓", "Connected"], available: ["·", "Not checked"], error: ["✕", "Can't connect"] };
const parsePairs = (t: string): Record<string, string> =>
  Object.fromEntries(
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=") < 0 ? l.length : l.indexOf("=")).trim(), l.indexOf("=") < 0 ? "" : l.slice(l.indexOf("=") + 1).trim()]),
  );

/** "Tools (MCP)" button + sheet. */
export function McpToolsSheet() {
  const { ate, toast } = useApp();
  const [open, setOpen] = useState(false);
  const [showTools, setShowTools] = useState<Record<string, boolean>>({});
  const [code, setCode] = useState<{ nonce: string; value: string } | null>(null);
  const [form, setForm] = useState<{ name: string; type: "stdio" | "http"; command: string; url: string; secrets: string } | null>(null);
  const list = useRemote<{ servers: McpServerInfo[] }>(() => (ate.mcp ? ate.mcp.list() : offline()), [open], { onEvents: false });
  const servers = list.last?.servers ?? [];
  const done = (r: Res<unknown>, ok?: string) => {
    if (!r.ok) toast({ kind: "error", text: r.error.message });
    else if (ok) toast({ kind: "ok", text: ok });
    list.reload();
  };
  const toggle = async (s: McpServerInfo, agent: "chat" | "trader", on: boolean) => {
    if (!ate.mcp) return;
    const r = await ate.mcp.enable(s.id, agent, on);
    if (r.ok && "needsCode" in r.data) return setCode({ nonce: r.data.nonce, value: "" });
    done(r, agent === "trader" && on ? `The trader can now use ${s.name}` : undefined);
  };
  const add = async () => {
    if (!ate.mcp || !form) return;
    const secrets = parsePairs(form.secrets);
    const parts = form.command.trim().split(/\s+/);
    const r = await ate.mcp.add(form.type === "http" ? { name: form.name, type: "http", url: form.url.trim(), headers: secrets } : { name: form.name, type: "stdio", command: parts[0] ?? "", args: parts.slice(1), env: secrets });
    done(r, `Added ${form.name}`);
    if (r.ok) setForm(null);
  };
  return (
    <>
      <button type="button" className="disclose sm" onClick={() => setOpen(true)} aria-haspopup="dialog">
        Tools (MCP)
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} eyebrow="Ask and the trader" title="Tools (MCP)" footer={<Btn onClick={() => setOpen(false)}>Done</Btn>} width={720}>
        <div className="sm fg2" style={{ marginBottom: 8 }}>
          Flow's own tools are always on. Other servers are off for the trader unless you turn them on with Touch ID. Secrets stay in your keychain.
        </div>
        {servers.map((s) => (
          <div key={s.id} style={{ borderTop: "1px solid var(--line)", padding: "12px 0" }}>
            <div className="row g10" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <b className="sm">{s.name}</b>
              <span className="xs fg2">{s.source === "flow" ? "built in" : s.source === "opencode" ? "from your opencode config" : "added in Flow"} · {s.type === "builtin" ? "Flow" : s.type === "http" ? "HTTP" : "command"}</span>
              <span className={`xs b7 ${s.state === "connected" ? "ok" : s.state === "error" ? "bad" : "fg2"}`}>
                <span aria-hidden="true">{STATE[s.state][0]}</span> {STATE[s.state][1]}
                {s.state === "connected" && ` · ${s.tools.length} tools`}
              </span>
              <span className="grow" />
              <label className="row g6 xs" style={{ alignItems: "center" }}>
                <input type="checkbox" checked={s.enabled.chat} disabled={s.source === "flow"} onChange={(e) => void toggle(s, "chat", e.target.checked)} /> Ask
              </label>
              <label className="row g6 xs" style={{ alignItems: "center" }} title={s.source === "flow" ? undefined : "Turning this on asks for Touch ID"}>
                <input type="checkbox" checked={s.enabled.trader} disabled={s.source === "flow"} onChange={(e) => void toggle(s, "trader", e.target.checked)} /> Trader
              </label>
            </div>
            {s.error && <div className="xs bad" style={{ marginTop: 4 }}>{s.error}</div>}
            {s.source === "flow" && (
              <div className="xs fg2" style={{ marginTop: 4 }}>
                The same tools work in Claude Code, Codex or any MCP client: <span className="mono">ate mcp serve</span> (stdio). They run with the agent's key, so the vault checks every trade the same way.
              </div>
            )}
            <div className="row g10" style={{ marginTop: 6 }}>
              {s.source !== "flow" && (
                <button type="button" className="disclose xs" onClick={() => ate.mcp && void ate.mcp.test(s.id).then((r) => done(r))}>
                  Check connection
                </button>
              )}
              {s.tools.length > 0 && (
                <button type="button" className="disclose xs" aria-expanded={!!showTools[s.id]} onClick={() => setShowTools((x) => ({ ...x, [s.id]: !x[s.id] }))}>
                  {showTools[s.id] ? "Hide tools" : "Show tools"}
                </button>
              )}
              {s.source === "user" && (
                <button type="button" className="disclose xs" onClick={() => ate.mcp && void ate.mcp.remove(s.id).then((r) => done(r, `Removed ${s.name}`))}>
                  Remove
                </button>
              )}
            </div>
            {showTools[s.id] && (
              <div className="xs fg2" style={{ marginTop: 6, columns: 2 }}>
                {s.tools.map((t) => (
                  <div key={t.name} className="mono">
                    {t.name}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {code && (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div className="sm">Touch ID isn't set up on this Mac. Enter the one-time code shown by Flow to let the trader use this server.</div>
            <div className="row g10" style={{ marginTop: 8 }}>
              <input className="inp mono" style={{ maxWidth: 200 }} inputMode="numeric" maxLength={8} placeholder="00000000" value={code.value} onChange={(e) => setCode({ ...code, value: e.target.value.replace(/\D/g, "") })} aria-label="One-time code" />
              <Btn kind="pri" disabled={code.value.length !== 8} onClick={() => ate.mcp && void ate.mcp.confirm(code.nonce, code.value).then((r) => (done(r, "The trader can now use that server"), r.ok && setCode(null)))}>
                Approve
              </Btn>
            </div>
          </div>
        )}
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          {!form ? (
            <button type="button" className="disclose sm" onClick={() => setForm({ name: "", type: "stdio", command: "", url: "", secrets: "" })}>
              Add a server
            </button>
          ) : (
            <div className="col g8" style={{ display: "grid", gap: 8 }}>
              <input className="inp" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Server name" />
              <div className="row g10 sm">
                <label className="row g6" style={{ alignItems: "center" }}>
                  <input type="radio" name="mcptype" checked={form.type === "stdio"} onChange={() => setForm({ ...form, type: "stdio" })} /> Command on this Mac
                </label>
                <label className="row g6" style={{ alignItems: "center" }}>
                  <input type="radio" name="mcptype" checked={form.type === "http"} onChange={() => setForm({ ...form, type: "http" })} /> HTTP URL
                </label>
              </div>
              {form.type === "stdio" ? (
                <input className="inp mono" placeholder="npx -y some-mcp-server --flag" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} aria-label="Command" />
              ) : (
                <input className="inp mono" placeholder="https://example.com/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} aria-label="URL" />
              )}
              <textarea className="inp mono" style={{ height: 70, padding: 10 }} placeholder={form.type === "stdio" ? "API_KEY=… (one per line, kept in your keychain)" : "Authorization=Bearer … (one per line, kept in your keychain)"} value={form.secrets} onChange={(e) => setForm({ ...form, secrets: e.target.value })} aria-label={form.type === "stdio" ? "Environment variables" : "Headers"} />
              <div className="row g10">
                <Btn kind="pri" disabled={!form.name.trim() || (form.type === "stdio" ? !form.command.trim() : !form.url.trim())} onClick={() => void add()}>
                  Add and check
                </Btn>
                <Btn onClick={() => setForm(null)}>Cancel</Btn>
              </div>
            </div>
          )}
        </div>
      </Dialog>
    </>
  );
}
