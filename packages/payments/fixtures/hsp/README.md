Recorded HSP tool responses used by `@ate/payments/testing` (MockHsp) and the worker tests.

Provenance: **synthesised** from the official hackathon guide (rev. 2026-10-30, `.context/track-b-access-requirements.md`)
because QA access (egress IP allowlist) was not confirmed when these were written. Field names follow the guide
(`flow_id`, `payment_request_id`, `token_total_raw`, `attribution_verified`, `gas_fee_advanced`, status strings
`payment-submitted|payment-safe|payment-finalized`, error `30043`). Placeholders `{{…}}` are filled by MockHsp.
When the live tool listing arrives, replace these files with real captures (secrets stripped) and adjust only the
`norm*` functions in `src/hsp.ts`.
