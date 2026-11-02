-- 001_init.sql — ATE SQLite schema v1 (SPEC §12, §13). FROZEN at the interface freeze.
-- Generated verbatim from SPEC.md §12 by the freeze agent; later changes are new numbered migrations
-- owned by Lane B. The migration runner (packages/journal/src/migrate.ts) wraps each file in one
-- transaction and records it in schema_version. Time = Unix seconds; amounts = decimal strings.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, address TEXT NOT NULL, chain_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);

CREATE TABLE vaults (                    -- one row per market (§4.1); mirrors deployments/177.json
  address TEXT PRIMARY KEY, market TEXT UNIQUE NOT NULL, agent_id TEXT REFERENCES agents(id),
  price_token TEXT NOT NULL, price_decimals INTEGER NOT NULL, oracle TEXT NOT NULL, pool TEXT NOT NULL,
  deployed_block INTEGER NOT NULL
);

CREATE TABLE limits (
  id TEXT PRIMARY KEY, vault TEXT NOT NULL, hash TEXT NOT NULL,
  max_trade_usd TEXT NOT NULL, max_epoch_usd TEXT NOT NULL,
  epoch_duration INTEGER NOT NULL, max_slippage_bps INTEGER NOT NULL,
  max_oracle_deviation_bps INTEGER NOT NULL, max_exit_discount_bps INTEGER NOT NULL,
  max_oracle_age INTEGER NOT NULL,
  max_exposure_usd TEXT NOT NULL, cooldown INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE strategy (                  -- scope = 'portfolio' or a market id
  scope TEXT PRIMARY KEY, params TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY, market TEXT NOT NULL, vault TEXT NOT NULL REFERENCES vaults(address), side TEXT NOT NULL,
  token_in TEXT NOT NULL, amount_in TEXT NOT NULL, min_amount_out TEXT NOT NULL,
  rationale TEXT NOT NULL, rationale_hash TEXT NOT NULL, candidate_id TEXT, signal_id TEXT,
  origin TEXT NOT NULL,                   -- candidate | discretionary | guard | human
  thesis TEXT,                            -- required iff origin = discretionary (§11.4 rule 8)
  journal_hash TEXT NOT NULL,             -- = on-chain proposalId (§13)
  oracle_price TEXT NOT NULL, oracle_updated_at INTEGER NOT NULL, pool_price TEXT NOT NULL,
  policy_reason INTEGER NOT NULL, status TEXT NOT NULL,   -- … | expired | invalidated (§7.3)
  reserved_turnover_usd TEXT NOT NULL DEFAULT '0',        -- released on expired/rejected/invalidated/failed
  approved_by TEXT, approved_at INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);

CREATE TABLE executions (
  id TEXT PRIMARY KEY, proposal_id TEXT REFERENCES proposals(id),
  tx_hash TEXT, block_number INTEGER, status TEXT NOT NULL,
  amount_out TEXT, gas_used TEXT, exit_path INTEGER, eas_uid TEXT,
  error_code TEXT, error_message TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY, market TEXT NOT NULL, generator TEXT NOT NULL, leg TEXT,   -- leg: open | close (spread-revert)
  side TEXT NOT NULL, max_amount_in TEXT NOT NULL,
  edge_bps INTEGER, cost_bps INTEGER, net_edge_bps INTEGER, reason TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_by TEXT
);

CREATE TABLE fills (                      -- cost basis for P&L, per market; spread-revert lots by generator
  id TEXT PRIMARY KEY, execution_id TEXT REFERENCES executions(id), market TEXT NOT NULL,
  generator TEXT NOT NULL, side TEXT NOT NULL, base_qty TEXT NOT NULL, quote_qty TEXT NOT NULL,
  price TEXT NOT NULL, cex_mid TEXT, at INTEGER NOT NULL
);

CREATE TABLE lots (                       -- spread-revert sub-ledger, close trigger only (§11.4 rule 4)
  id TEXT PRIMARY KEY, market TEXT NOT NULL, open_fill_id TEXT NOT NULL REFERENCES fills(id),
  qty_open TEXT NOT NULL, qty_remaining TEXT NOT NULL, entry_price TEXT NOT NULL,
  realised_usd TEXT NOT NULL DEFAULT '0',  -- reported alongside position P&L, never summed with it
  opened_at INTEGER NOT NULL, closed_at INTEGER
);                                         -- every sell consumes open lots FIFO first, then other inventory

CREATE TABLE payments (                   -- worker; mirrored read-only to desktop
  id TEXT PRIMARY KEY, offer_id TEXT NOT NULL, conditions_hash TEXT NOT NULL,
  order_id TEXT, flow_id TEXT, payment_request_id TEXT UNIQUE,
  typed_data_digest TEXT, amount_raw TEXT, token TEXT, chain_id INTEGER,
  state TEXT NOT NULL, valid_until INTEGER,
  sign_approved_at INTEGER, submit_approved_at INTEGER,
  gateway_tx TEXT, attribution_verified INTEGER, last_status TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE decisions (                 -- the §13 journal; append-only, hash-chained
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL,
  ref_id TEXT,                            -- the decision this record follows up (execution, payment_update, attestation)
  record TEXT NOT NULL,                   -- canonical JSON (RFC 8785) of the Decision
  prev_hash TEXT NOT NULL UNIQUE,         -- genesis prev_hash = 0x00…00 (32 zero bytes); UNIQUE forbids forks
  hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions
  BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,   -- user | assistant | tool
  content TEXT NOT NULL, tool_name TEXT, decision_id TEXT, at INTEGER NOT NULL
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events   (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, payload TEXT);

CREATE INDEX idx_exec_proposal ON executions(proposal_id);
CREATE INDEX idx_prop_expires  ON proposals(expires_at);
CREATE INDEX idx_pay_state     ON payments(state);
CREATE INDEX idx_dec_ref       ON decisions(ref_id);
CREATE INDEX idx_chat_session  ON chat_messages(session_id, at);
