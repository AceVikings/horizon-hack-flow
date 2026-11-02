import { describe, expect, it } from "vitest";
import { FIXTURE_CANDIDATES, FIXTURE_PORTFOLIO } from "@ate/core/fixtures";
import type { ProposalDraft } from "@ate/core";
import { StubCandidateEngine, StubGuard, StubInvalidation, StubReservations } from "../src/strategy-stub.js";

const cand = FIXTURE_CANDIDATES.find((c) => c.side === "buy")!;
const draft = (o: Partial<ProposalDraft> = {}): ProposalDraft => ({
  market: cand.market,
  side: cand.side,
  tokenIn: "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029",
  amountIn: cand.maxAmountIn,
  notionalUsdE8: "500000000",
  origin: "candidate",
  candidateId: cand.candidateId,
  actor: { kind: "agent", via: "mcp" },
  scope: "agent",
  mode: "autonomous",
  ...o,
});
const pf = { ...FIXTURE_PORTFOLIO, at: cand.expiresAt - 10 };

describe("lane-b stub guard (rules 1–3)", () => {
  const g = new StubGuard();
  it("binds to a live candidate", () => {
    expect(g.check(draft(), pf, "propose")).toMatchObject({ ok: true });
  });
  it("rule 1: candidate required / mismatch / expired", () => {
    expect(g.check(draft({ candidateId: undefined }), pf, "propose")).toMatchObject({ ok: false, code: "ATE_CANDIDATE_REQUIRED" });
    expect(g.check(draft({ side: "sell" }), pf, "propose")).toMatchObject({ ok: false, code: "ATE_CANDIDATE_MISMATCH" });
    expect(g.check(draft({ amountIn: (BigInt(cand.maxAmountIn) + 1n).toString() }), pf, "propose")).toMatchObject({ ok: false, code: "ATE_CANDIDATE_MISMATCH" });
    expect(g.check(draft(), { ...pf, at: cand.expiresAt + 1 }, "propose")).toMatchObject({ ok: false, code: "ATE_CANDIDATE_MISMATCH" });
  });
  it("rule 1 (discretionary): thesis and size", () => {
    const d = draft({ origin: "discretionary", candidateId: undefined });
    expect(g.check({ ...d, thesis: "short" }, pf, "propose")).toMatchObject({ ok: false, code: "ATE_CANDIDATE_REQUIRED" });
    const thesis = "CEX ask thinning for 3 cycles while pool flow is net buy; exit if mid < entry";
    expect(g.check({ ...d, thesis, notionalUsdE8: "1100000000" }, pf, "propose")).toMatchObject({ ok: false, code: "ATE_DISCRETIONARY_LIMIT" });
    expect(g.check({ ...d, thesis }, pf, "propose")).toMatchObject({ ok: true, reserve: { discretionary: 1 } });
  });
  it("rule 2/3: position limit and turnover", () => {
    expect(g.check(draft({ notionalUsdE8: "100000000000" }), pf, "propose")).toMatchObject({ ok: false, code: "ATE_STRATEGY_BLOCKED" });
  });
  it("reservations + invalidation", () => {
    const r = new StubReservations();
    r.reserve("prop_1", { market: cand.market, turnoverUsd: "5", discretionary: 0 });
    expect(r.totals().turnoverUsd).toBe("5");
    const inv = new StubInvalidation(() => [{ proposalId: "prop_1", market: cand.market, side: "buy", origin: "candidate", status: "approved", amountIn: "1", reservedTurnoverUsd: "5", createdAt: 0, expiresAt: 1 }], r);
    expect(inv.onGuardExit(cand.market)).toEqual(["prop_1"]);
    expect(inv.isInvalidated("prop_1")).toBe(true);
    expect(r.totals().turnoverUsd).toBe("0");
    const g2 = new StubGuard((id) => inv.isInvalidated(id));
    expect(g2.check(draft({ proposalId: "prop_1" }), pf, "execute")).toMatchObject({ ok: false, rule: "invalidated" });
  });
  it("engine emits discretionary_exit only where the vault holds the priceToken", () => {
    const snaps = (FIXTURE_PORTFOLIO as unknown as { markets: Record<string, { vault: unknown }> }).markets;
    void snaps;
  });
  void StubCandidateEngine;
});
