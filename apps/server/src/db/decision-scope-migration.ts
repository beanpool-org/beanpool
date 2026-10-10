import type Database from 'better-sqlite3';
import { createTableText } from './table-rules.js';

/**
 * Gives `decisions` a scope (DESIGN-group-decisions §2.1, 2026-10-10): `scope_kind` / `scope_id` and the 'scope' touch.
 *
 * A table from before them is rebuilt once into schema.sql's own `decisions` (createTableText), every row kept as a
 * community Decision. Then the one-open-per-author index becomes one open per author per scope: a keeper of three
 * enterprises may have one open in each, and the community rule is unchanged. Day zero: no live node holds a scoped row.
 *
 * Idempotent: once the table names `scope_kind` and the index names it too, nothing is done.
 * Relies on `foreign_keys = OFF` (db.ts), so dropping the old `decisions` table does not cascade to its votes.
 */
export const DECISIONS_AUTHOR_SCOPE_OPEN_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_member_author_open
    ON decisions(author_pubkey, scope_kind, COALESCE(scope_id, '')) WHERE status = 'open' AND author_pubkey != 'SYSTEM'`;

export function addDecisionScope(targetDb: Database.Database, schemaSql: string): 'already' | 'rebuilt' | 'indexed' {
    const tableSql = (targetDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='decisions'"
    ).get() as { sql: string } | undefined)?.sql || '';
    const indexSql = (targetDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_decisions_member_author_open'"
    ).get() as { sql: string } | undefined)?.sql || '';
    const tableHasScope = /\bscope_kind\b/.test(tableSql);
    if (tableHasScope && /\bscope_kind\b/.test(indexSql)) return 'already';

    let rebuilt = false;
    targetDb.transaction(() => {
        if (!tableHasScope) {
            const fresh = createTableText(schemaSql, 'decisions');
            if (!fresh) throw new Error('schema.sql declares no decisions table');
            const oldCols = (targetDb.prepare('PRAGMA table_info(decisions)').all() as Array<{ name: string }>).map(c => c.name);
            targetDb.exec(fresh.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+decisions\b/i, 'CREATE TABLE decisions_new'));
            const newCols = new Set((targetDb.prepare('PRAGMA table_info(decisions_new)').all() as Array<{ name: string }>).map(c => c.name));
            const cols = oldCols.filter(c => newCols.has(c)).join(', ');
            targetDb.exec(`INSERT INTO decisions_new (${cols}) SELECT ${cols} FROM decisions`);
            targetDb.exec('DROP TABLE decisions');
            targetDb.exec('ALTER TABLE decisions_new RENAME TO decisions');
            targetDb.exec(`
                CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
                CREATE INDEX IF NOT EXISTS idx_decisions_closes_at ON decisions(closes_at);
                CREATE INDEX IF NOT EXISTS idx_decisions_author ON decisions(author_pubkey);
                CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_decisions_tick_open ON decisions(status, closes_at ASC);
                CREATE INDEX IF NOT EXISTS idx_decisions_tick_grace ON decisions(status, grace_period_ends_at ASC);
                CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at DESC);
            `);
            rebuilt = true;
        }
        targetDb.exec('DROP INDEX IF EXISTS idx_decisions_author_open');
        targetDb.exec('DROP INDEX IF EXISTS idx_decisions_member_author_open');
        targetDb.exec(DECISIONS_AUTHOR_SCOPE_OPEN_INDEX);
        targetDb.exec('CREATE INDEX IF NOT EXISTS idx_decisions_scope ON decisions(scope_kind, scope_id, status)');
    })();
    return rebuilt ? 'rebuilt' : 'indexed';
}
