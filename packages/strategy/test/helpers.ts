import { MARKET_WBTC, MARKET_WHSK, type MarketId, type MarketSnapshot, type PortfolioState, type ProposalDraft } from "@ate/core";
import { FIXTURE_MARKET_SNAPSHOTS, FIXTURE_NOW, FIXTURE_PORTFOLIO } from "@ate/core/fixtures";

export { MARKET_WBTC, MARKET_WHSK, FIXTURE_NOW };

export function snaps(): Record<MarketId, MarketSnapshot> {
  return structuredClone(FIXTURE_MARKET_SNAPSHOTS);
}

export function pf(mut?: (p: PortfolioState) => void): PortfolioState {
  const p = structuredClone(FIXTURE_PORTFOLIO);
  mut?.(p);
  return p;
}

/** Portfolio where no entry happened recently (rule 7 out of the way). */
export function freshPf(mut?: (p: PortfolioState) => void): PortfolioState {
  return pf((p) => {
    for (const b of Object.values(p.markets)) b.lastEntryAt = null;
    mut?.(p);
  });
}

export function draft(over: Partial<ProposalDraft> & Pick<ProposalDraft, "market" | "side" | "amountIn" | "notionalUsdE8">): ProposalDraft {
  return {
    tokenIn: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
    origin: "candidate",
    actor: { kind: "agent" },
    scope: "agent",
    mode: "autonomous",
    ...over,
  };
}

/** Set a vault's on-chain exposure (E8) and keep the book's exposureUsd in sync. */
export function setExposure(p: PortfolioState, s: Record<MarketId, MarketSnapshot> | null, market: MarketId, usd: number): void {
  const e8 = BigInt(Math.round(usd * 1e8)).toString();
  p.markets[market].exposureUsd = String(usd);
  p.markets[market].vault.exposureUsdE8 = e8;
  if (s) s[market].vault.exposureUsdE8 = e8;
}
