-- A market can have more than one vault over time (Flow creates new vaults; older ones stay in history), so the
-- vaults table is keyed by address only. SQLite cannot drop a UNIQUE constraint in place: rebuild the table.
CREATE TABLE vaults_new (
  address TEXT PRIMARY KEY, market TEXT NOT NULL, agent_id TEXT REFERENCES agents(id),
  price_token TEXT NOT NULL, price_decimals INTEGER NOT NULL, oracle TEXT NOT NULL, pool TEXT NOT NULL,
  deployed_block INTEGER NOT NULL
);
INSERT INTO vaults_new SELECT address, market, agent_id, price_token, price_decimals, oracle, pool, deployed_block FROM vaults;
DROP TABLE vaults;
ALTER TABLE vaults_new RENAME TO vaults;
CREATE INDEX vaults_market ON vaults(market);
