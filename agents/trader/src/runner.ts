// Cycle scheduler (§11.1 cycle rules, normative):
//  - cycles never overlap: a tick while a run is active is skipped (counted, not journalled as a decision);
//  - an out-of-schedule cycle (strategy change, scan found a new entry candidate) obeys the same lock and is
//    rate-limited to ≥ 30 s between starts;
//  - a run still active after runTimeoutSec (90 s) is aborted and the runner writes no_trade(timeout).

export type CycleReason = "tick" | "scan" | "manual" | "strategy_change";

export interface CycleContext {
  cycle: number;
  reason: CycleReason;
  startedAt: number;
  /** Aborted at the timeout: executors must kill their child process. */
  signal: AbortSignal;
}

export interface CycleOutcome {
  ok: boolean;
  summary?: string;
  costUsd?: number;
  turns?: number;
}

export interface CycleExecutor {
  run(ctx: CycleContext): Promise<CycleOutcome>;
}

export interface CycleRecord {
  cycle: number;
  reason: CycleReason;
  startedAt: number;
  latencyMs: number;
  status: "ok" | "error" | "timeout";
  summary?: string;
  costUsd?: number;
}

export interface RunnerOptions {
  executor: CycleExecutor;
  /** Default 90 s (§11.1). */
  timeoutMs?: number;
  /** Minimum gap between out-of-schedule cycle starts (default 30 s). */
  minTriggerGapMs?: number;
  /** Writes ate_decide { reason: "timeout" } (engine=rules) for the killed cycle. */
  onTimeout?: (cycle: number) => Promise<void>;
  onRecord?: (r: CycleRecord) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

export class TraderRunner {
  private running: Promise<void> | null = null;
  private cycle = 0;
  private lastStart = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  readonly records: CycleRecord[] = [];
  skipped = 0;
  private readonly timeoutMs: number;
  private readonly minGap: number;
  private readonly now: () => number;

  constructor(private readonly o: RunnerOptions) {
    this.timeoutMs = o.timeoutMs ?? 90_000;
    this.minGap = o.minTriggerGapMs ?? 30_000;
    this.now = o.now ?? Date.now;
  }

  get active(): boolean {
    return this.running !== null;
  }

  /** Scheduled tick. Returns "skipped" while a run is active (no overlap). */
  tick(reason: CycleReason = "tick"): "started" | "skipped" {
    if (this.running) {
      this.skipped++;
      this.o.log?.(`tick skipped (cycle ${this.cycle} still running)`);
      return "skipped";
    }
    this.start(reason);
    return "started";
  }

  /** Out-of-schedule cycle: same lock, ≥ minTriggerGapMs since the last start. */
  trigger(reason: Exclude<CycleReason, "tick">): "started" | "skipped" | "rate_limited" {
    if (this.now() - this.lastStart < this.minGap) return "rate_limited";
    return this.tick(reason);
  }

  /** Resolves when the current run (if any) has finished. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private start(reason: CycleReason): void {
    const cycle = ++this.cycle;
    const startedAt = this.now();
    this.lastStart = startedAt;
    const ac = new AbortController();
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((res) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error("cycle timeout"));
        res("timeout");
      }, this.timeoutMs);
    });
    const exec = this.o.executor.run({ cycle, reason, startedAt, signal: ac.signal }).then(
      (r) => r,
      (e: unknown) => ({ ok: false, summary: e instanceof Error ? e.message : String(e) }) as CycleOutcome,
    );
    this.o.log?.(`cycle ${cycle} start (${reason})`);
    this.running = (async () => {
      const r = await Promise.race([exec, timeout]);
      clearTimeout(timeoutHandle);
      const latencyMs = this.now() - startedAt;
      let rec: CycleRecord;
      if (r === "timeout" || timedOut) {
        rec = { cycle, reason, startedAt, latencyMs, status: "timeout", summary: `killed after ${this.timeoutMs} ms` };
        try {
          await this.o.onTimeout?.(cycle);
        } catch (e) {
          this.o.log?.(`timeout record failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        // Let the killed executor settle before releasing the lock.
        await Promise.race([exec, new Promise((res) => setTimeout(res, 5_000))]);
      } else {
        rec = { cycle, reason, startedAt, latencyMs, status: r.ok ? "ok" : "error", ...(r.summary ? { summary: r.summary } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
      }
      this.records.push(rec);
      this.o.onRecord?.(rec);
      this.o.log?.(`cycle ${cycle} ${rec.status} in ${(latencyMs / 1000).toFixed(1)} s${rec.summary ? `: ${rec.summary.slice(0, 600)}` : ""}`);
      this.running = null;
    })();
  }

  /** Start ticking every `periodMs` (first tick immediately). */
  startTimer(periodMs: number): void {
    this.stopTimer();
    this.tick("tick");
    this.timer = setInterval(() => this.tick("tick"), periodMs);
  }

  stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats(): { cycles: number; skipped: number; timeouts: number; p50Ms: number | null; p95Ms: number | null; candidateTtlSec: number } {
    const lat = this.records.filter((r) => r.status !== "timeout").map((r) => r.latencyMs);
    const p95 = percentile(lat, 0.95);
    return {
      cycles: this.records.length,
      skipped: this.skipped,
      timeouts: this.records.filter((r) => r.status === "timeout").length,
      p50Ms: percentile(lat, 0.5),
      p95Ms: p95,
      candidateTtlSec: candidateTtlFromP95(p95),
    };
  }
}

export function percentile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
}

/** candidateTtlSec = max(120 s, 2 × p95 LLM run latency) (§11.1). */
export function candidateTtlFromP95(p95Ms: number | null): number {
  if (p95Ms === null) return 120;
  return Math.max(120, Math.ceil((2 * p95Ms) / 1000));
}
