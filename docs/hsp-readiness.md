# HSP readiness (SPEC §9, no-go deliverable)

Status at writing (Nov 2, ~10:30 IST): **G-HSP not confirmed.** Worker egress `13.205.56.13` submitted via the QA
access form (team `Vikings`); Operations confirmation not received. Nothing in this repo has called
`https://mcp-qa.hashkeymerchant.com/`, signed typed data for HSP, or moved funds. Recorded listing / organiser
reply: _pending — ops-2 to paste here_.

The payment path is built in full and tested against **recorded (synthesised) responses** in
`packages/payments/fixtures/hsp/` (provenance in its README: shapes from the official guide rev. 2026-10-30; replace
with real captures when access arrives — only the `norm*` functions in `packages/payments/src/hsp.ts` should need
changes).

## Eight tools → state-machine transition → test

Tests: `packages/payments/test/payments.test.ts` (P) and `apps/worker/test/worker.test.ts` (W).

| HSP tool | Called by | §9.4 transition it drives | Recorded-response test |
|---|---|---|---|
| `get_chain_config` | ate-signal (`GET /offers`), ate-pay `start` | conditions verify (§9.3 step 1) → `CREATED` or `ATE_PAYMENT_CONDITIONS_INVALID` / `_NETWORK_UNSUPPORTED` | P "network mismatch with live get_chain_config", P "§9.2/§9.3 conditions" |
| `create_order` | ate-signal | merchant side; precedes `CREATED` | W "offer → buy → … → signal released once" |
| `get_order` | ate-pay `start` | order = conditions, else `ATE_PAYMENT_ORDER_MISMATCH` (nothing reserved) | P "get_order mismatch" |
| `prepare_payment` | ate-pay `start` | `CREATED → PREPARED` (`prepared`); 30043 → `EXPIRED` | P "happy path", P "30043 at prepare → EXPIRED" |
| `finalize_payment` | ate-pay after approval #1 + signature | `SIGNED → AUTH_FINALIZED` (`finalized`); 30043 → `EXPIRED` | P "happy path", P "30043 at finalize" |
| `estimate_fee` | ate-pay after finalize | feeds approval #2 payload (`AUTH_FINALIZED`, `gas_fee_advanced` recorded) | P "happy path" (feeRaw in approval #2) |
| `submit_payment` | ate-pay after approval #2 | `SUBMIT_APPROVED → SUBMITTED` (`submit_ok`) / `→ UNCERTAIN` (timeout/5xx) / 30043 → `EXPIRED` | P "uncertain submit (timeout)", P "5xx at submit", P "crash after SUBMIT_APPROVED" |
| `query_payment` | ate-pay poller/reconciler, ate-signal `/redeem` | `→ SAFE`, `→ SETTLED` (attributed), `→ SETTLED_UNATTRIBUTED`, `→ FAILED`; never resubmits | P "happy path", P "attribution_verified=false", P "definitive failure", P "no definitive result after 10 min", W signal release |

Approvals: `PREPARED → SIGN_APPROVED` and `AUTH_FINALIZED → SUBMIT_APPROVED` need an `ate-approve` Secure Enclave
signature over an agent-built payload bound to `typedDataDigest` + `payment_request_id` (P "rejects an approval by another
key"); denial/timeout → `FAILED_DENIED` (P "denial at approval #1/#2", P "approval timeout"). TTY codes are never accepted
for payments (W "TTY codes never approve payments").

## Go-live checklist (only if G-HSP is go)

1. On the worker: `curl https://mcp-qa.hashkeymerchant.com/health` → `{"status":"ok"}` (proves nothing about tools).
2. `ATE_HSP_LIVE=1 ate-signal` / `ate-pay` refuse to start unless all eight tools are listed (§9.7). Paste the listing here.
3. Read `get_chain_config`; verify the signer supports EIP-712 on that chain (`onchainos` argv in `createOnchainosSigner`
   is UNVERIFIED; fallback = `ATE_SIGNER=local-eoa` with a 0400 key file funded ≤ $1).
4. Funding + Permit2/token approvals are separate, manual, user-approved transactions.
5. One live QA payment end-to-end → E8 only if `SETTLED` with `attribution_verified=true`.
