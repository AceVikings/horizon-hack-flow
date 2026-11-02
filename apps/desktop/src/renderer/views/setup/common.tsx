// Setup wizard building blocks (lane D2): wizard frame (dark step column, progress, action bar), owner-device
// handoff (QR per transaction + live landing poll), one-time-code approval dialog, small form controls.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Res } from "@shared/bridge";
import type { ApprovalPath, OwnerBridge, SetupBridge, SetupPath } from "@shared/setup-bridge";
import { useApp } from "../../src/app";
import { short } from "../../src/format";
import {Btn, Dialog, FlowMark, QR} from "../../src/ui";
import { getWithRetry } from "./retry";
import "./setup.css";

export const STEPS = ["Connect", "Set limits", "Start"] as const;

const OFF: SetupBridge = new Proxy({} as SetupBridge, {
  get: () => async () => ({ ok: false, error: { code: "ATE_DAEMON_LOCKED", message: "setup needs the desktop app (no daemon bridge in fixtures)" } }),
});
export function useSetup(): SetupBridge {
  const { ate } = useApp();
  return ate.setup ?? OFF;
}

/** Flow-managed owner signing (CLOUD lane), when this build has it. No owner key ever reaches the renderer. */
export function useOwner(): OwnerBridge | null {
  const { ate } = useApp();
  return (ate as unknown as { owner?: OwnerBridge }).owner ?? null;
}

/** Limit changes that raise risk (v1 Touch ID policy): any cap or tolerance going up, or a shorter cooldown. */
export function isLoosening(before: Record<string, string | number>, after: Record<string, string | number>): boolean {
  return Object.keys(after).some((k) => {
    if (k === "epochDuration" || k === "maxOracleAge") return false;
    const a = BigInt(after[k]!);
    const b = BigInt(before[k] ?? 0);
    return k === "cooldown" ? a < b : a > b;
  });
}

/**
 * GET a /setup route with reload + optional polling. With `retry`, each attempt has a time budget and failures are
 * retried with backoff; when every attempt fails, `failed` is true (show a "Try again" that calls reload).
 */
export function useSetupGet<T>(path: SetupPath, opts: { every?: number; query?: Record<string, string>; skip?: boolean; retry?: number; bad?(d: T): boolean } = {}): { data: T | null; res: Res<T> | null; loading: boolean; failed: boolean; reload(): void } {
  const s = useSetup();
  const [res, setRes] = useState<Res<T> | null>(null);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!opts.skip);
  const [failed, setFailed] = useState(false);
  const [n, setN] = useState(0);
  const q = JSON.stringify(opts.query ?? {});
  const badRef = useRef(opts.bad);
  badRef.current = opts.bad;
  useEffect(() => {
    if (opts.skip) return;
    let live = true;
    const once = () => s.get<T>(path, opts.query);
    const run = () =>
      void (opts.retry ? getWithRetry(once, { tries: opts.retry, bad: (d) => !!badRef.current?.(d), alive: () => live }) : once()).then((r) => {
        if (!live) return;
        setRes(r);
        if (r.ok) setData(r.data);
        setFailed(!r.ok || !!(opts.retry && badRef.current?.(r.data)));
        setLoading(false);
      });
    setLoading(true);
    setFailed(false);
    run();
    const iv = opts.every ? setInterval(run, opts.every) : null;
    return () => {
      live = false;
      if (iv) clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, q, n, opts.every, opts.skip, opts.retry, s]);
  return { data, res, loading, failed, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Plain failure line with a Try again button (no codes, no pills). */
export function RetryLine({ message = "Couldn't reach the network. Try again.", onRetry }: { message?: string; onRetry(): void }) {
  return (
    <div className="row g12 sm" role="alert" style={{ marginTop: 12 }}>
      <span>{message}</span>
      <Btn kind="solid" onClick={onRetry}>Try again</Btn>
    </div>
  );
}

export function useChainId(): number {
  const { data } = useSetupGet<{ chainId: number }>("/setup/status");
  return data?.chainId ?? 133;
}

export const netLabel = (id: number) => (id === 133 ? "Testnet 133" : `Mainnet ${id}`);
export const go = (hash: string) => (location.hash = hash.startsWith("#") ? hash : `#/${hash}`);

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <span className="row g10" style={{ alignItems: "center" }} aria-label="Flow">
      <FlowMark size={size} />
      <span className="logo" style={{ fontSize: size * 1.1 }}>
        FLOW<span className="pd">.</span>
      </span>
    </span>
  );
}

/**
 * Setup page (SIMPLIFY.md): one centred column (~880 px), three named steps on top, Back/Continue at the end of the
 * column (no footer or bottom-pinned bar, by rule).
 * `shot` tags the screen for the screenshot runner.
 */
export function Wizard({ step, chainId, children, hint, next, nextLabel = "Continue", nextDisabled, busy, back, shot }: { step: number; chainId: number; children: ReactNode; hint?: ReactNode; next?(): void; nextLabel?: string; nextDisabled?: boolean; busy?: boolean; back?(): void; shot: string }) {
  return (
    <div className="sw" data-shot={shot}>
      <header className="sw-top">
        <Logo size={28} />
        <ol className="sw-steps" aria-label="Setup steps">
          {STEPS.map((name, i) => {
            const s = i + 1;
            const c = s < step ? "done" : s === step ? "cur" : "todo";
            return (
              <li key={name} className={c} aria-current={s === step ? "step" : undefined}>
                <button disabled={s > step} onClick={() => s < step && go(`setup/${s}`)}>
                  <span className="n" aria-hidden="true">{s < step ? "✓" : s}</span>
                  {name}
                  <span className="sr">{c === "done" ? " (done)" : c === "cur" ? " (current step)" : ""}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <span className="row g10">
          <span className="xs fg2">Saved as you go</span>
          <span className="stx"><span aria-hidden="true" className="g">●</span>{netLabel(chainId)}</span>
        </span>
      </header>
      <main className="sw-scroll">
        <div className="sw-col">
          {children}
          <div className="sw-acts">
            <Btn kind="ghost" onClick={back ?? (() => go(step > 1 ? `setup/${step - 1}` : "welcome"))}>
              Back
            </Btn>
            <span className="hint">{hint}</span>
            <span className="grow" />
            {next && (
              <Btn kind="pri" size="lg" className="hot" disabled={nextDisabled || busy} onClick={next} aria-busy={busy}>
                {busy ? "Working…" : nextLabel}
              </Btn>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/** "Show details" disclosure: technical facts stay one tap away (SIMPLIFY.md). */
export function Details({ summary = "Show details", children, open }: { summary?: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="sdet" open={open}>
      <summary>{summary}</summary>
      <div className="sdet-b">{children}</div>
    </details>
  );
}

/** A plain section: short title, one sentence, content. */
export function Section({ title, sub, right, children, done }: { title: string; sub?: ReactNode; right?: ReactNode; children?: ReactNode; done?: boolean }) {
  return (
    <section className={`ssec${done ? " done" : ""}`} aria-label={title}>
      <div className="row sb top">
        <div>
          <h2 className="ssec-t">
            {done && <span className="gl-ok" aria-hidden="true">✓</span>} {title}
          </h2>
          {sub && <p className="ssec-s">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function StepHead({ step, name, title, hl, right }: { step: number; name: string; title: ReactNode; hl: ReactNode; right?: ReactNode }) {
  return (
    <div className="row sb end">
      <div>
        <div className="stepno">
          Step {step} of 3 · {name}
        </div>
        <h1>
          {title} <span className="hl">{hl}</span>
        </h1>
      </div>
      {right && <div style={{ marginBottom: 4 }}>{right}</div>}
    </div>
  );
}

/** Status as plain text with a glyph (no pills, no badges: user rule). Extra props are accepted and ignored. */
export function StatusText({ tone = "mute", children }: { tone?: "ok" | "warn" | "bad" | "info" | "mute"; children: ReactNode; y?: boolean; glyph?: string; className?: string; lg?: boolean; title?: string }) {
  const g = { ok: "✓", warn: "!", bad: "✕", info: "i", mute: "·" }[tone];
  return (
    <span className={`stx ${tone}`}>
      <span aria-hidden="true" className="g">{g}</span>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="row g8 sm fg2" role="status">
      <span className="gl-run" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ErrLine({ error }: { error: { message: string; code?: string } | null | undefined }) {
  if (!error) return null;
  return (
    <div className="banner bad" role="alert" style={{ marginTop: 12 }}>
      <span className="ic" aria-hidden="true">!</span>
      <div>
        <div className="bt">{error.message}</div>
        {error.code && <div className="bs mono">{error.code}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- owner-device handoff

export interface HandoffTx {
  label: string;
  to: string | null;
  data: string;
  value: string;
  chainId: number;
  uri: string;
  format: "eip681" | "tx-json";
  qr: boolean;
}
export interface Handoff {
  id: string;
  kind: string;
  chainId: number;
  txs: HandoffTx[];
  predicted?: string[];
}
interface HandoffPoll {
  done: boolean;
  results: { done: boolean; detail: string; txHash?: string }[];
}

/** Build a handoff and poll the chain until every effect lands. */
export function useHandoff(onDone?: (h: Handoff, p: HandoffPoll) => void) {
  const s = useSetup();
  const [h, setH] = useState<Handoff | null>(null);
  const [poll, setPoll] = useState<HandoffPoll | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cb = useRef(onDone);
  cb.current = onDone;
  const start = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      setPoll(null);
      const r = await s.post<Handoff>("/setup/handoff", body);
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setH(r.data);
    },
    [s],
  );
  useEffect(() => {
    if (!h) return;
    let live = true;
    const tick = async () => {
      const r = await s.get<HandoffPoll>("/setup/handoff", { id: h.id });
      if (!live || !r.ok) return;
      setPoll(r.data);
      if (r.data.done) {
        live = false;
        cb.current?.(h, r.data);
      }
    };
    void tick();
    const iv = setInterval(() => live && void tick(), 4000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [h, s]);
  return { handoff: h, poll, error, busy, start, reset: () => (setH(null), setPoll(null)) };
}

/** One transaction for a wallet you scan with: QR (EIP-681 or tx JSON), what it does, and whether it has landed. */
export function TxQR({ tx, landed, detail, size = 150, dark }: { tx: HandoffTx; landed?: boolean; detail?: string; size?: number; dark?: boolean }) {
  return (
    <div className="hx row g18 top" style={{ gap: 18 }}>
      {tx.qr ? <QR data={tx.uri} size={size} label={`QR for ${tx.label}`} /> : <span className="qr xs qrbig" style={{ width: size + 20, height: size + 20 }}>contract creation: export the bundle</span>}
      <div className="col g8" style={{ gap: 8, minWidth: 0 }}>
        <div className="h4">{tx.label}</div>
        <div className="xs" style={{ color: dark ? "var(--sage)" : "var(--fg2)" }}>
          {tx.format === "eip681" ? "EIP-681 link: Safe{Wallet}, MetaMask Mobile, Ledger Live" : "Transaction JSON: paste into Safe Transaction Builder or your wallet's raw-tx screen"}
        </div>
        {tx.to && <div className="mono xs" title={tx.to}>to {short(tx.to, 8, 6)}</div>}
        <div className="row g8">
          {landed ? (
            <StatusText tone="ok">landed on chain</StatusText>
          ) : (
            <span className="row g8 xs" role="status">
              <span className="gl-run" aria-hidden="true" />
              waiting for the chain…
            </span>
          )}
          <button className="linkbtn xs" onClick={() => void navigator.clipboard?.writeText(tx.uri)}>
            Copy
          </button>
        </div>
        {detail && <div className="xs fg2 mono">{detail}</div>}
      </div>
    </div>
  );
}

/** Dialog that shows every transaction of a handoff as QR and closes itself once all have landed. */
export function HandoffDialog({ open, onClose, title, intro, body, onDone, eyebrow = "Another wallet" }: { open: boolean; onClose(): void; title: ReactNode; intro: ReactNode; body: Record<string, unknown> | null; onDone?(): void; eyebrow?: string }) {
  const ho = useHandoff(() => onDone?.());
  const key = JSON.stringify(body);
  useEffect(() => {
    if (open && body) void ho.start(body);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key]);
  const done = ho.poll?.done;
  return (
    <Dialog open={open} onClose={onClose} eyebrow={eyebrow} title={title} width={720} footer={<><span className="grow" /><Btn kind={done ? "pri" : undefined} onClick={onClose}>{done ? "Done" : "Close"}</Btn></>}>
      <p className="sm fg2" style={{ marginBottom: 14 }}>{intro}</p>
      <ErrLine error={ho.error} />
      {ho.busy && <Spinner label="Building the transactions…" />}
      <div className="col" style={{ gap: 16 }}>
        {ho.handoff?.txs.map((t, i) => (
          <TxQR key={i} tx={t} landed={ho.poll?.results[i]?.done ?? false} detail={ho.poll?.results[i]?.detail} />
        ))}
      </div>
      {done && (
        <div className="banner" style={{ marginTop: 14, background: "var(--okbg)" }} role="status">
          <span className="gl-ok" aria-hidden="true">✓</span>
          <span className="sm">Read back from the chain: every change landed.</span>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- one-time code (Touch ID unavailable)

export function CodeInput({ value, onChange, onSubmit, autoFocus }: { value: string; onChange(v: string): void; onSubmit(): void; autoFocus?: boolean }) {
  return (
    <input
      className="codein mono"
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label="8-digit one-time code"
      maxLength={8}
      value={value}
      autoFocus={autoFocus}
      data-autofocus
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 8))}
      onKeyDown={(e) => e.key === "Enter" && value.length === 8 && onSubmit()}
      placeholder="00000000"
    />
  );
}

export function CodeShow({ code }: { code: string | null | undefined }) {
  if (!code) return null;
  return (
    <div className="codeshow" aria-label={`One-time code ${code.split("").join(" ")}`}>
      {code.slice(0, 4)}
      <span aria-hidden="true"> </span>
      {code.slice(4)}
    </div>
  );
}

/**
 * Two-step approval for replacing/removing a saved key (v1 Touch ID policy): Touch ID (ate-approve) when installed; otherwise the
 * daemon's one-time code is shown here and typed back (single use, 60 s).
 */
export function useApproval() {
  const s = useSetup();
  const [pending, setPending] = useState<{ path: ApprovalPath; nonce: string; code: string | null; expiresAt: number; resolve(ok: boolean, r?: unknown): void } | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (path: ApprovalPath, body: unknown): Promise<{ ok: boolean; result?: unknown; error?: { message: string } }> => {
      setError(null);
      setBusy(true);
      const r = await s.approveStart(path, body);
      setBusy(false);
      if (!r.ok) return { ok: false, error: r.error };
      if (r.data.applied) return { ok: true, result: r.data.result };
      setTyped("");
      return new Promise((resolve) => setPending({ path, nonce: r.data.nonce, code: r.data.code ?? null, expiresAt: r.data.expiresAt, resolve: (ok, result) => resolve({ ok, result }) }));
    },
    [s],
  );
  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    const r = await s.approveFinish(pending.path, pending.nonce, typed);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    pending.resolve(true, r.data);
    setPending(null);
  };
  const dialog = (
    <Dialog
      open={!!pending}
      onClose={() => {
        pending?.resolve(false);
        setPending(null);
      }}
      eyebrow="Approve on this Mac"
      title="One-time code"
      width={560}
      dismissable={!busy}
      footer={
        <>
          <span className="grow" />
          <Btn kind="ghost" onClick={() => (pending?.resolve(false), setPending(null))}>Cancel</Btn>
          <Btn kind="pri" size="lg" disabled={typed.length !== 8 || busy} onClick={() => void submit()}>Approve</Btn>
        </>
      }
    >
      <p className="sm fg2">Touch ID approval (ate-approve) is not installed on this Mac, so the daemon issued a single-use code that only this app can read. Type it to approve. It expires in 60 s.</p>
      <CodeShow code={pending?.code} />
      <CodeInput value={typed} onChange={setTyped} onSubmit={() => void submit()} autoFocus />
      <ErrLine error={error} />
    </Dialog>
  );
  return { run, dialog, busy, error };
}

export function NumField({ value, onChange, unit, prefix, min, max, step = 1, label, width = 118, focus }: { value: number; onChange(v: number): void; unit?: string; prefix?: string; min: number; max: number; step?: number; label: string; width?: number; focus?: boolean }) {
  return (
    <label className={`inp${focus ? " focus" : ""}`} style={{ width, height: 38 }}>
      {prefix && <span className="u">{prefix}</span>}
      <input type="number" className="numin" aria-label={label} value={value} min={min} max={max} step={step} onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || 0)))} />
      {unit && <span className="u">{unit}</span>}
    </label>
  );
}

export function Slider({ value, onChange, min, max, step = 1, label }: { value: number; onChange(v: number): void; min: number; max: number; step?: number; label: string }) {
  const pc = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider grow">
      <div className="tr">
        <i style={{ width: `${pc}%` }} />
      </div>
      <span className="kn" style={{ left: `${pc}%` }} aria-hidden="true" />
      <input type="range" className="rangein" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
