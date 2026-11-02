// `ate rogue` engine (SPEC §22.3). The engine now lives in the daemon package (apps/daemon/src/rogue.ts) so the
// desktop app can run the same suite in-app (POST /proof/run, testnet only); this module re-exports it unchanged.
export {
  FULL_RUN,
  STAGE_RUN,
  EXPECTED,
  decodeRevert,
  loadLocal,
  resolveMarket,
  runRogue,
  type AttackId,
  type AttackResult,
  type RogueOptions,
} from "@ate/daemon";
