// Numbered SQL migrations, each in one transaction, recorded in schema_version (§12).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort()
    .map((f) => ({ version: Number(f.slice(0, 3)), name: f, sql: readFileSync(`${dir}${f}`, "utf8") }));
}

/** Applies pending migrations; returns the versions applied. Sets WAL + foreign keys. */
export function migrate(db: Database.Database, dir = MIGRATIONS_DIR, now = () => Math.floor(Date.now() / 1000)): number[] {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)");
  const done = new Set((db.prepare("SELECT version FROM schema_version").all() as { version: number }[]).map((r) => r.version));
  const applied: number[] = [];
  for (const m of loadMigrations(dir)) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, now());
    })();
    applied.push(m.version);
  }
  return applied;
}
