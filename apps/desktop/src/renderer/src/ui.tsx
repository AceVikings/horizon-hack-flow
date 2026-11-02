// Small shared components. Colour is never the only signal: every status carries an icon glyph + text.
import type { ReactNode } from "react";
import { explorer, short } from "./format";

export type Tone = "ok" | "warn" | "bad" | "info" | "mute";
const GLYPH: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✕", info: "i", mute: "·" };

export function Badge({ tone = "mute", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      <span aria-hidden="true" className="glyph">{GLYPH[tone]}</span>
      {children}
    </span>
  );
}

export function Link({ href, children, title }: { href: string; children: ReactNode; title?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={title ?? href} className="ext">
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}
export const TxLink = ({ hash }: { hash: string }) => <Link href={explorer.tx(hash)} title={hash}>{short(hash, 10, 8)}</Link>;
export const AddrLink = ({ addr, full }: { addr: string; full?: boolean }) => <Link href={explorer.address(addr)} title={addr}>{full ? addr : short(addr, 8, 6)}</Link>;

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ code, message, hint }: { code: string; message: string; hint?: string }) {
  return (
    <div className="errbox" role="alert">
      <Badge tone="bad">{code}</Badge> <span>{message}</span>
      {hint && <div className="muted hint">Hint: {hint}</div>}
    </div>
  );
}

export function Bar({ value, max, label, right }: { value: number; max: number; label: string; right: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="barrow">
      <div className="barhead"><span>{label}</span><span className="num">{right}</span></div>
      <div className="bar" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div className="fill" style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export function KV({ k, children, mono }: { k: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="k">{k}</span>
      <span className={`v num${mono ? " mono" : ""}`}>{children}</span>
    </div>
  );
}

export function PnL({ usd, bps }: { usd: string; bps?: number }) {
  const n = Number(usd);
  const tone: Tone = n > 0 ? "ok" : n < 0 ? "bad" : "mute";
  const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "■";
  const txt = `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
  return (
    <span className={`pnl ${tone} num`}>
      <span aria-hidden="true">{arrow}</span> {txt}
      {bps !== undefined && <span className="muted"> ({bps > 0 ? "+" : bps < 0 ? "−" : ""}{Math.abs(bps)} bps)</span>}
      <span className="sr"> {n > 0 ? "gain" : n < 0 ? "loss" : "flat"}</span>
    </span>
  );
}

export function Card({ title, right, children, className }: { title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || right) && (
        <header className="cardhead">
          <h3>{title}</h3>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}
