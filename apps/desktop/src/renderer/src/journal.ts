// Plain-language summaries of journal records (Overview "Last decisions", Decisions timeline, record detail).
import { MARKETS, type JournalEntry, type MarketId } from "@ate/core";
import { tokenAmt } from "./format";
import type { Tone } from "./ui";

/** Agent text arrives wrapped for prompt-injection hygiene (§11.5); the UI shows it as plain text. */
export const clean = (s: string | undefined): string => (s ?? "").replace(/<\/?untrusted_agent_text>/g, "").trim();

export const marketOf = (e: JournalEntry): MarketId | undefined => (e.market ?? (e.intent?.market as MarketId | undefined)) || undefined;
export const tag = (e: JournalEntry): string => {
  const m = marketOf(e);
  return m && m in MARKETS ? MARKETS[m].label : "ALL";
};

export function kindLabel(e: JournalEntry): string {
  if (e.kind === "no_trade") return e.verdict.message === "llm_veto" ? "Veto" : "No trade";
  return (
    {
      proposal: "Proposal",
      execution: "Execution",
      attestation: "Attestation",
      strategy_change: "Strategy",
      pause: "Pause",
      outcome: "Outcome",
      payment: "Payment",
      payment_update: "Payment",
      oracle_refresh: "Oracle refresh",
    } as Record<string, string>
  )[e.kind] ?? e.kind;
}

/** Who decided: AI (llm), guard, rules engine or you. */
export function decidedBy(e: JournalEntry): "AI" | "guard" | "rules" | "you" {
  if (e.actor.kind === "human" || e.engine === "human") return "you";
  if (e.actor.kind === "guard" || e.engine === "guard") return "guard";
  return e.engine === "rules" ? "rules" : "AI";
}

/** Token amounts of a trade record: "Bought 52.62 WHSK for $4.61". */
export function tradeLine(e: JournalEntry): string | null {
  const it = e.intent;
  const m = marketOf(e);
  if (!it || !m || !(m in MARKETS)) return null;
  const mk = MARKETS[m];
  const out = e.execution?.amountOut ?? e.context.quote?.amountOut;
  if (it.side === "buy") {
    const usd = tokenAmt(it.amountIn, 6);
    return out ? `${e.kind === "execution" ? "Bought" : "Buy"} ${tokenAmt(out, mk.baseDecimals)} ${mk.base} for $${usd}` : `Buy $${usd} of ${mk.base}`;
  }
  const qty = tokenAmt(it.amountIn, mk.baseDecimals);
  return out ? `${e.kind === "execution" ? "Sold" : "Sell"} ${qty} ${mk.base} for ${tokenAmt(out, 6)} USDT` : `Sell ${qty} ${mk.base}`;
}

/** One-line description for lists. */
export function summary(e: JournalEntry): string {
  const r = clean(e.rationale);
  if (e.kind === "execution") {
    const t = tradeLine(e);
    if (e.execution?.reverted) return `Reverted on-chain${t ? ": " + t : ""}`;
    return t ? `${t}${e.execution?.exitPath ? " on the exit path" : ""}` : r;
  }
  if (e.kind === "outcome" && e.outcome) return `30 min after a veto: declining ${e.outcome.savedBps >= 0 ? "saved" : "cost"} ${Math.abs(e.outcome.savedBps)} bps ($${e.outcome.savedUsd.replace(/^-/, "")})`;
  if (e.kind === "pause") return `Paused both vaults · ${r}`;
  return r;
}

/** Result badge for a record. */
export function result(e: JournalEntry): { tone: Tone; text: string; glyph?: string } {
  if (e.kind === "execution") {
    if (e.execution?.reverted || !e.verdict.ok) return { tone: "bad", text: e.verdict.code === "OK" ? "reverted" : e.verdict.code };
    return { tone: "ok", text: "executed" };
  }
  if (e.kind === "pause") return { tone: "bad", text: "paused", glyph: "❚❚" };
  if (e.kind === "outcome" && e.outcome) return { tone: e.outcome.savedBps >= 0 ? "ok" : "bad", text: `${e.outcome.savedBps >= 0 ? "+" : "−"}${Math.abs(e.outcome.savedBps)} bps` };
  if (e.kind === "no_trade") return { tone: "mute", text: e.verdict.message === "llm_veto" ? "veto" : "skip" };
  if (!e.verdict.ok) return { tone: "bad", text: e.verdict.code.replace(/^ATE_(POLICY_)?/, "") };
  if (e.kind === "proposal") {
    if (e.origin === "discretionary") return { tone: "info", text: "discretionary" };
    return { tone: "info", text: e.verdict.approvedBy === "human" ? "you approved" : "policy approved" };
  }
  if (e.kind === "attestation") return { tone: "ok", text: "attested" };
  return { tone: "mute", text: "applied" };
}

export const isExit = (e: JournalEntry): boolean => !!(e.execution?.exitPath || e.context.quote?.exitPath || e.origin === "guard");

/** Decisions "Show" filter groups. */
export const SHOW = {
  all: () => true,
  trades: (e: JournalEntry) => e.kind === "execution",
  notrade: (e: JournalEntry) => e.kind === "no_trade",
  rejected: (e: JournalEntry) => !e.verdict.ok,
  exit: (e: JournalEntry) => (e.kind === "execution" || e.kind === "proposal") && isExit(e),
  discretionary: (e: JournalEntry) => e.origin === "discretionary",
  you: (e: JournalEntry) => decidedBy(e) === "you",
} as const;
export type ShowKey = keyof typeof SHOW;
