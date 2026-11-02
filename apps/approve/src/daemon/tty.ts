// §10.1 v0.1 degradation: TTY one-time codes, for /ui/attach, /chat/session and pending loosening strategy
// changes ONLY (plus desktop Settings saves, purpose "config"). Modes: "off" (never), "armed" (disabled until `approval-fallback enable` is typed on the
// daemon's own controlling TTY — no HTTP route, no restart), "tty" (enabled from start).
// Codes: 8 digits, printed solely to the TTY writer, TTL 60 s, single use, 5 attempts per code.
// Switches itself off — and refuses `enable` — once ate-approve has passed on this machine.
import { randomInt, timingSafeEqual } from "node:crypto";
import { APPROVAL_TTL_SEC } from "../builders.js";

export type FallbackMode = "off" | "armed" | "tty";
export type TtyPurpose = "ui_attach" | "chat_session" | "strategy" | "config";

export const TTY_CODE_RE = /^[0-9]{8}$/;
export const TTY_MAX_ATTEMPTS = 5;

interface CodeEntry {
  code: string;
  purpose: TtyPurpose;
  expiresAt: number;
  attempts: number;
}

export interface TtyFallbackOptions {
  mode: FallbackMode;
  /** Writes to the daemon's controlling TTY only (never a log file, /events or the journal). */
  ttyWrite: (line: string) => void;
  now: () => number;
  /** True when ate-approve already passed its §18.2 test on this machine (e.g. a persisted marker). */
  approveGreen?: boolean;
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: "disabled" | "no_code" | "expired" | "wrong_code" | "locked" | "wrong_purpose" };

export class TtyFallback {
  private mode: FallbackMode;
  private enabled: boolean;
  private approveGreen: boolean;
  private readonly codes = new Map<string, CodeEntry>();
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(opts: TtyFallbackOptions) {
    this.mode = opts.mode;
    this.write = opts.ttyWrite;
    this.now = opts.now;
    this.approveGreen = opts.approveGreen ?? false;
    this.enabled = opts.mode === "tty" && !this.approveGreen;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  status(): { mode: FallbackMode; enabled: boolean; approveGreen: boolean } {
    return { mode: this.mode, enabled: this.enabled, approveGreen: this.approveGreen };
  }

  /**
   * One line typed on the daemon's controlling TTY (stdin). Lane B wires `process.stdin` lines here;
   * there is deliberately no HTTP route. Returns true if the line was an approval-fallback command.
   */
  handleTtyLine(line: string): boolean {
    const cmd = line.trim().replace(/\s+/g, " ");
    if (!cmd.startsWith("approval-fallback")) return false;
    const arg = cmd.slice("approval-fallback".length).trim();
    if (arg === "enable") {
      if (this.approveGreen) this.write("approval-fallback: refused — ate-approve passed on this machine; use Touch ID");
      else if (this.mode === "off") this.write("approval-fallback: refused — daemon started with approvalFallback=off");
      else {
        this.enabled = true;
        this.write("approval-fallback: ENABLED — one-time codes print here for /ui/attach, /chat/session and strategy loosening only");
      }
    } else if (arg === "disable") {
      this.enabled = false;
      this.codes.clear();
      this.write("approval-fallback: disabled");
    } else {
      this.write(`approval-fallback: mode=${this.mode} enabled=${this.enabled} approveGreen=${this.approveGreen}`);
    }
    return true;
  }

  /** ate-approve signed end-to-end: codes off for good on this run (§10.1). */
  markApproveGreen(): void {
    if (this.approveGreen) return;
    this.approveGreen = true;
    if (this.enabled) this.write("approval-fallback: switched off — ate-approve verified on this machine");
    this.enabled = false;
    this.codes.clear();
  }

  /** Issue a code bound to `bindTo` (nonce or changeId). No-op (null) unless enabled. */
  issue(purpose: TtyPurpose, bindTo: string, label: string): string | null {
    if (!this.enabled) return null;
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    this.codes.set(bindTo, { code, purpose, expiresAt: this.now() + APPROVAL_TTL_SEC, attempts: 0 });
    this.write(`ATE approval code for ${label}: ${code} (single use, 60 s)`);
    return code;
  }

  redeem(purpose: TtyPurpose, bindTo: string, code: string): RedeemResult {
    if (!this.enabled) return { ok: false, reason: "disabled" };
    const e = this.codes.get(bindTo);
    if (!e) return { ok: false, reason: "no_code" };
    if (e.purpose !== purpose) return { ok: false, reason: "wrong_purpose" };
    if (this.now() > e.expiresAt) {
      this.codes.delete(bindTo);
      return { ok: false, reason: "expired" };
    }
    if (e.attempts >= TTY_MAX_ATTEMPTS) {
      this.codes.delete(bindTo);
      return { ok: false, reason: "locked" };
    }
    e.attempts += 1;
    const a = Buffer.from(code.padEnd(8, "x").slice(0, 8));
    const b = Buffer.from(e.code);
    if (TTY_CODE_RE.test(code) && timingSafeEqual(a, b)) {
      this.codes.delete(bindTo);
      return { ok: true };
    }
    if (e.attempts >= TTY_MAX_ATTEMPTS) this.codes.delete(bindTo);
    return { ok: false, reason: "wrong_code" };
  }
}
