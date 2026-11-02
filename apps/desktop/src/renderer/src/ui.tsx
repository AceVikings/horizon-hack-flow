// Shared components for every lane (Flow v1 board classes, styles.css). APIs here are STABLE: add props, never
// rename. Colour is never the only signal: every status carries a glyph and text. Signable values are never
// abbreviated (format.ts). Focus is always visible; motion respects prefers-reduced-motion (styles.css).
import { useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { explorer, short } from "./format";
import { qrMatrix } from "./qr";

export type Tone = "ok" | "warn" | "bad" | "info" | "mute";
const GLYPH: Record<Tone, string> = { ok: "✓", warn: "!", bad: "✕", info: "i", mute: "·" };

/** Status badge (`.bd`). `glyph` overrides the tone's default glyph ("" hides it, e.g. for "AI"/"you" chips). */
export function Badge({ tone = "mute", children, title, glyph, lg, y, className }: { tone?: Tone; children: ReactNode; title?: string; glyph?: string; lg?: boolean; y?: boolean; className?: string }) {
  const g = glyph ?? GLYPH[tone];
  return (
    <span className={`bd ${y ? "y" : tone === "mute" ? "" : tone}${lg ? " lgx" : ""}${className ? " " + className : ""}`} title={title}>
      {g && <span aria-hidden="true" className="gl">{g}</span>}
      {children}
    </span>
  );
}

/** Dot + text status pill used in page heads ("Trader running · autonomous"). */
export function StatPill({ tone = "ok", children, title }: { tone?: "ok" | "warn" | "bad"; children: ReactNode; title?: string }) {
  return (
    <span className={`stat-pill ${tone === "ok" ? "" : tone}`} title={title} role="status">
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
export function NetPill({ label }: { label: string }) {
  return (
    <span className="net">
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

type BtnKind = "pri" | "solid" | "ghost" | "danger";
export function Btn({ kind, size, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; size?: "sm" | "lg" | "xl" }) {
  return (
    <button type="button" {...rest} className={`btn${kind ? " " + kind : ""}${size ? " " + size : ""}${className ? " " + className : ""}`}>
      {children}
    </button>
  );
}

/** External link (opens in the system browser via main's window-open handler). */
export function Link({ href, children, title, mono, className }: { href: string; children: ReactNode; title?: string; mono?: boolean; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" title={title ?? href} className={`ext${mono ? " mono" : ""}${className ? " " + className : ""}`}>
      {children}
    </a>
  );
}
export const TxLink = ({ hash, full, a = 6, b = 4 }: { hash: string; full?: boolean; a?: number; b?: number }) => (
  <Link href={explorer.tx(hash)} title={hash} mono>
    {full ? hash : short(hash, a, b)}
  </Link>
);
export const AddrLink = ({ addr, full, a = 6, b = 4 }: { addr: string; full?: boolean; a?: number; b?: number }) => (
  <Link href={explorer.address(addr)} title={addr} mono>
    {full ? addr : short(addr, a, b)}
  </Link>
);

/** Eyebrow label with the yellow dot (`.eb`). */
export const Eyebrow = ({ children, style, nodot }: { children: ReactNode; style?: CSSProperties; nodot?: boolean }) => (
  <div className={`eb${nodot ? " nodot" : ""}`} style={style}>
    {children}
  </div>
);

/** Card. `title` renders the board's card head (`.ch` + `.h4`); `dark` = charcoal card; `soft` = surface grey. */
export function Card({
  title,
  right,
  children,
  className,
  dark,
  soft,
  tight,
  style,
  headStyle,
  label,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  dark?: boolean;
  soft?: boolean;
  tight?: boolean;
  style?: CSSProperties;
  headStyle?: CSSProperties;
  label?: string;
}) {
  return (
    <section className={`card${dark ? " dk" : ""}${soft ? " soft" : ""}${tight ? " tight" : ""}${className ? " " + className : ""}`} style={style} aria-label={label ?? (typeof title === "string" ? title : undefined)}>
      {(title || right) && (
        <header className="ch" style={headStyle}>
          {typeof title === "string" ? <h2 className="h4">{title}</h2> : title}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

/** Big numeral stat: label, display-face value, optional sub line. `size` = big (40) | huge (72) | giant (104). */
export function Stat({ label, value, sub, tone, size = "big", style, valueStyle }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "ok" | "bad" | "y"; size?: "big" | "huge" | "giant"; style?: CSSProperties; valueStyle?: CSSProperties }) {
  return (
    <div style={style}>
      <div className="lbl">{label}</div>
      <div className={`${size} mt8 num${tone === "ok" ? " ok" : tone === "bad" ? " bad" : ""}`} style={{ ...(tone === "y" ? { color: "var(--y)" } : {}), ...valueStyle }}>
        {value}
      </div>
      {sub && <div className="xs mt4 fg2">{sub}</div>}
    </div>
  );
}

/** Dark hero strip of stats separated by hairlines (Positions, Markets price triple). */
export function StatStrip({ children, cols }: { children: ReactNode[]; cols?: number }) {
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${cols ?? children.length},minmax(0,1fr))`, gap: 0 }}>
      {children.map((c, i) => (
        <div key={i} style={i ? { borderLeft: "1px solid rgba(183,198,194,.16)", paddingLeft: 22 } : undefined}>
          {c}
        </div>
      ))}
    </div>
  );
}

/** Meter (`.bar`): value of max, with an accessible label and text equivalent. */
export function Meter({ value, max, label, size, tick, className, style }: { value: number; max: number; label: string; size?: "thick" | "xl"; tick?: number; className?: string; style?: CSSProperties }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={`bar${size ? " " + size : ""}${className ? " " + className : ""}`} style={style} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${pct.toFixed(1)}%`}>
      {pct > 0 && <i style={{ width: `${pct}%` }} />}
      {tick !== undefined && max > 0 && <span className="tick" style={{ left: `${Math.min(100, (tick / max) * 100)}%` }} />}
    </div>
  );
}

/** Legacy bar row (label + right text + meter). */
export function Bar({ value, max, label, right }: { value: number; max: number; label: string; right: ReactNode }) {
  return (
    <div>
      <div className="row sb sm">
        <span className="fg2">{label}</span>
        <span className="num">{right}</span>
      </div>
      <Meter value={value} max={max} label={label} style={{ marginTop: 6 }} />
    </div>
  );
}

export function KV({ k, children, mono, className, vClass }: { k: ReactNode; children: ReactNode; mono?: boolean; className?: string; vClass?: string }) {
  return (
    <div className={`kv${className ? " " + className : ""}`}>
      <span className="k">{k}</span>
      <span className={`v num${mono ? " mono" : ""}${vClass ? " " + vClass : ""}`}>{children}</span>
    </div>
  );
}

/** Check-list row (`.chk`): glyph circle, text, right aside. */
export function Check({ state, children, aside, style }: { state: "ok" | "bad" | "warn" | "run" | "q"; children: ReactNode; aside?: ReactNode; style?: CSSProperties }) {
  const g = { ok: "✓", bad: "✕", warn: "!", run: "", q: "·" }[state];
  const sr = { ok: "passed", bad: "failed", warn: "warning", run: "running", q: "pending" }[state];
  return (
    <div className="chk" style={style}>
      <span className={`gl-${state}`} aria-hidden="true">{g}</span>
      <span className="sm">
        {children}
        <span className="sr"> ({sr})</span>
      </span>
      <span className="xs fg2">{aside}</span>
    </div>
  );
}

/** Signed P&L with arrow glyph + sign + word (never colour alone). */
export function PnL({ usd, bps, big, suffix }: { usd: string | number; bps?: number; big?: boolean; suffix?: ReactNode }) {
  const n = Number(usd);
  const tone = n > 0 ? "ok" : n < 0 ? "bad" : "";
  const arrow = n > 0 ? "▲" : n < 0 ? "▼" : "■";
  const txt = `${n > 0 ? "+" : n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
  return (
    <span className={`num b7 ${tone}`} style={big ? { fontSize: 16 } : undefined}>
      <span aria-hidden="true">{arrow}</span> {txt}
      {bps !== undefined && ` · ${bps > 0 ? "+" : bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(1)}%`}
      <span className="sr"> {n > 0 ? "gain" : n < 0 ? "loss" : "flat"}</span>
      {suffix}
    </span>
  );
}

export interface Column<R> {
  key: string;
  label: ReactNode;
  align?: "r";
  render(r: R): ReactNode;
  className?: string;
}
export function Table<R>({ cols, rows, rowKey, compact, className, caption, selected }: { cols: Column<R>[]; rows: R[]; rowKey(r: R): string; compact?: boolean; className?: string; caption?: string; selected?: string }) {
  return (
    <table className={`tbl${compact ? " cmp" : ""}${className ? " " + className : ""}`}>
      {caption && <caption className="sr">{caption}</caption>}
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} className={c.align ?? ""} scope="col">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={rowKey(r)} className={selected === rowKey(r) ? "sel" : ""}>
            {cols.map((c) => (
              <td key={c.key} className={`${c.align ?? ""}${c.className ? " " + c.className : ""}`}>
                {c.render(r)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Full-width notice (`.banner`): bad (error), warn, paused (dark). */
export function Banner({ tone, icon, title, sub, action }: { tone: "bad" | "warn" | "paused"; icon: string; title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  const ic: CSSProperties = tone === "bad" ? { background: "var(--bad)", color: "#fff" } : tone === "paused" ? { background: "#ff8d95", color: "var(--c)" } : { background: "var(--y)", color: "var(--c)" };
  return (
    <div className={`banner ${tone}`} role={tone === "bad" ? "alert" : "status"} style={{ marginBottom: 16 }}>
      <span className="ic" style={ic} aria-hidden="true">
        {icon}
      </span>
      <div className="grow">
        <div className="bt">{title}</div>
        {sub && <div className="bs">{sub}</div>}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ w, h = 12, style }: { w?: number | string; h?: number; style?: CSSProperties }) {
  return <div className="sk" aria-hidden="true" style={{ width: w ?? "100%", height: h, ...style }} />;
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div style={{ display: "grid", placeItems: "center", minHeight: 150, textAlign: "center", padding: 16 }}>
      <div>
        <div className="disp" style={{ fontSize: 30 }}>
          {title}
        </div>
        {children && <div className="sm fg2 mt8">{children}</div>}
        {action && <div style={{ marginTop: 16 }}>{action}</div>}
      </div>
    </div>
  );
}

export function ErrorBox({ code, message, hint, action }: { code: string; message: string; hint?: string; action?: ReactNode }) {
  return <Banner tone="bad" icon="!" title={<>{message} <span className="mono xs">{code}</span></>} sub={hint} action={action} />;
}

/** Segmented single-choice control. */
export function Seg<const T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode }[]; onChange(v: T): void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Filter pill (toggle). */
export function Pill({ on, children, onClick, count, title }: { on?: boolean; children: ReactNode; onClick?(): void; count?: number; title?: string }) {
  return (
    <button className={`pill${on ? " on" : ""}`} aria-pressed={!!on} onClick={onClick} title={title}>
      {children}
      {count !== undefined && <span className="ct num">{count}</span>}
    </button>
  );
}

/**
 * Modal dialog: portal, scrim, focus trap, Escape closes, focus restored on close. `children` = body (`.mb`),
 * `footer` = action bar (`.mf`). Pass `dismissable={false}` while a signature is in flight.
 */
export function Dialog({ open, onClose, eyebrow, title, children, footer, width, dismissable = true }: { open: boolean; onClose(): void; eyebrow?: ReactNode; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; dismissable?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => [...(el?.querySelectorAll<HTMLElement>('button:not(:disabled),[href],input:not(:disabled),select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])];
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0])?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      prev?.focus?.();
    };
  }, [open, onClose, dismissable]);
  if (!open) return null;
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} style={width ? { width } : undefined}>
        <div className="mh">
          {eyebrow && <div className="eb">{eyebrow}</div>}
          <h2 id={id} className="disp" style={{ fontSize: 52, margin: "12px 0 0" }}>
            {title}
          </h2>
        </div>
        <div className="mb">{children}</div>
        {footer && <div className="mf">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Radio card used inside dialogs (`.choice`). */
export function Choice({ name, checked, onChange, title, sub }: { name: string; checked: boolean; onChange(): void; title: ReactNode; sub?: ReactNode }) {
  return (
    <label className={`choice${checked ? " on" : ""}`} style={{ padding: "12px 14px" }}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <div className="row g10">
        <span className={`radio${checked ? " on" : ""}`} aria-hidden="true" />
        <b>{title}</b>
      </div>
      {sub && <div className="xs fg2 mt4" style={{ paddingLeft: 28 }}>{sub}</div>}
    </label>
  );
}

/**
 * Press-and-hold button (deliberate destructive actions). Fires after `ms` of continuous press (pointer or
 * Space/Enter). Under reduced motion the fill doesn't animate; the label counts down instead.
 */
export function HoldButton({ ms = 1500, onHold, children, disabled, className, holdingLabel }: { ms?: number; onHold(): void; children: ReactNode; disabled?: boolean; className?: string; holdingLabel?: string }) {
  const [on, setOn] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    if (disabled || t.current) return;
    setOn(true);
    t.current = setTimeout(() => {
      t.current = null;
      setOn(false);
      onHold();
    }, ms);
  };
  const stop = () => {
    if (t.current) clearTimeout(t.current);
    t.current = null;
    setOn(false);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className={`btn hold${on ? " on" : ""}${className ? " " + className : ""}`}
      style={{ ["--hold" as string]: `${ms}ms` }}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !e.repeat && (e.preventDefault(), start())}
      onKeyUp={(e) => (e.key === " " || e.key === "Enter") && stop()}
      aria-describedby={undefined}
    >
      <span className="hp" aria-hidden="true" />
      <span className="ht">{on && holdingLabel ? holdingLabel : children}</span>
    </button>
  );
}

/** Real, scannable QR (byte mode, ECC M). `data` is what the owner device reads (EIP-681 URI, Safe link…). */
export function QR({ data, size = 120, pad = 10, label }: { data: string; size?: number; pad?: number; label?: string }) {
  const m = useMemo(() => {
    try {
      return qrMatrix(data);
    } catch {
      return null;
    }
  }, [data]);
  if (!m) return <span className="qr xs">QR payload too long</span>;
  const n = m.length + 2; // 1-module quiet zone inside the white tile padding
  const d = m
    .flatMap((row, y) => row.map((on, x) => (on ? `M${x + 1} ${y + 1}h1v1h-1z` : "")))
    .join("");
  return (
    <span className="qr" style={{ padding: pad }} role="img" aria-label={label ?? `QR code: ${data}`} title={data}>
      <svg width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges">
        <path d={d} fill="#171e19" />
      </svg>
    </span>
  );
}

/** Gap-vs-cost gauge (Markets, Decision record): cost hatched in red, gap in yellow, labels above/below. */
export function Gauge({ cost, gap, max, under }: { cost: number; gap: number; max?: number; under?: ReactNode }) {
  const top = Math.max(max ?? 0, gap * 1.35, cost * 1.6, 40);
  const pc = (v: number) => `${Math.max(0, Math.min(100, (v / top) * 100))}%`;
  const net = gap - cost;
  return (
    <div className="gauge" role="img" aria-label={`gap ${gap} bps vs cost ${cost} bps: net ${net >= 0 ? "+" : ""}${net} bps`}>
      <div className="ax" />
      <div className="cost" style={{ left: 0, width: pc(cost) }} />
      {gap > cost && <div className="gp" style={{ left: pc(cost), width: `calc(${pc(gap)} - ${pc(cost)})` }} />}
      <span className="lab" style={{ left: `calc(${pc(cost)} / 2)`, color: "var(--bad)" }}>
        cost {cost}
      </span>
      <span className="lab" style={{ left: `calc(${pc(gap)} - 2%)` }}>
        gap {gap}
      </span>
      {under && <span className="lab2" style={{ left: "50%" }}>{under}</span>}
    </div>
  );
}

/** Flow brand mark, verbatim from packages/ui/brand/flow-mark-dark.svg (inlined: no extra CSP img source). */
export function FlowMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Flow">
      <rect x=".25" y=".25" width="63.5" height="63.5" rx="13.75" fill="#272727" stroke="#b7c6c2" strokeOpacity=".28" strokeWidth=".5" />
      <path d="M20 12H52V20H32V28H40V36H32V52H20Z" fill="#fff" />
      <path d="M44 28H52V36H44Z" fill="#ffe17c" />
    </svg>
  );
}
