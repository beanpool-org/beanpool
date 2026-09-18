import type Database from 'better-sqlite3';

/**
 * Removes what the retired voting features left in the database (2026-09-19).
 *
 * Old voting rounds and the Decision effects set_rule, set_levy, poll, grant/revoke tier and
 * grant/revoke elder were deleted outright. Nothing is carried forward — no node used them:
 * 1. The `voting_rounds` blob in `node_config` (rounds had no SQL table) is deleted.
 * 2. Decisions with a removed effect, or touching 'rule'/'nothing', are deleted with their votes.
 * 3. The `decisions.touches` CHECK drops 'rule' and 'nothing' (table rebuilt once, rows kept).
 *
 * Idempotent: once the CHECK no longer names 'rule', steps 2-3 find nothing to do.
 * Relies on `foreign_keys = OFF` (db.ts), so dropping the old `decisions` table does not cascade.
 */
export const REMOVED_DECISION_EFFECTS = [
    'set_rule', 'set_levy', 'poll', 'grant_tier', 'revoke_tier', 'grant_elder', 'revoke_elder',
] as const;

export function ripOutLegacyVoting(targetDb: Database.Database): void {
    targetDb.prepare("DELETE FROM node_config WHERE key = 'voting_rounds'").run();

    const tableSql = (targetDb.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='decisions'"
    ).get() as { sql: string } | undefined)?.sql || '';
    if (!tableSql.includes("'rule'")) return;

    const placeholders = REMOVED_DECISION_EFFECTS.map(() => '?').join(', ');
    const doomed = `SELECT id FROM decisions WHERE effect IN (${placeholders}) OR touches NOT IN ('member', 'pool')`;

    targetDb.transaction(() => {
        targetDb.prepare(`DELETE FROM decision_votes WHERE decision_id IN (${doomed})`).run(...REMOVED_DECISION_EFFECTS);
        targetDb.prepare(`DELETE FROM decisions WHERE id IN (${doomed})`).run(...REMOVED_DECISION_EFFECTS);
        targetDb.exec(`
            CREATE TABLE decisions_new (
                id                   TEXT PRIMARY KEY,
                author_pubkey        TEXT NOT NULL REFERENCES members(public_key),
                title                TEXT NOT NULL,
                description          TEXT NOT NULL,
                touches              TEXT NOT NULL CHECK (touches IN ('member', 'pool')),
                effect               TEXT NOT NULL,
                subject              TEXT,
                params               TEXT,
                franchise            TEXT NOT NULL CHECK (franchise IN ('1m1v', 'quadratic_trade')),
                status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
                    'open',
                    'passed',
                    'failed',
                    'unresolved',
                    'passed_queued_for_funds',
                    'execution_pending_grace',
                    'execution_blocked',
                    'execution_void',
                    'executed',
                    'admin_halted'
                )),
                opens_at             DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                closes_at            DATETIME NOT NULL,
                grace_period_ends_at DATETIME,
                created_at           DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                executed_at          DATETIME,
                execution_error      TEXT,
                execution_reason     TEXT,
                admin_halted_at      DATETIME,
                admin_halted_by      TEXT REFERENCES members(public_key) ON DELETE SET NULL,
                admin_halt_reason    TEXT,
                updated_at           DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            INSERT INTO decisions_new (
                id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                opens_at, closes_at, grace_period_ends_at, created_at, executed_at, execution_error,
                execution_reason, admin_halted_at, admin_halted_by, admin_halt_reason, updated_at
            )
            SELECT
                id, author_pubkey, title, description, touches, effect, subject, params, franchise, status,
                opens_at, closes_at, grace_period_ends_at, created_at, executed_at, execution_error,
                execution_reason, admin_halted_at, admin_halted_by, admin_halt_reason, updated_at
            FROM decisions;
            DROP TABLE decisions;
            ALTER TABLE decisions_new RENAME TO decisions;
            CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
            CREATE INDEX IF NOT EXISTS idx_decisions_closes_at ON decisions(closes_at);
            CREATE INDEX IF NOT EXISTS idx_decisions_author ON decisions(author_pubkey);
            CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_decisions_tick_open ON decisions(status, closes_at ASC);
            CREATE INDEX IF NOT EXISTS idx_decisions_tick_grace ON decisions(status, grace_period_ends_at ASC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_author_open ON decisions(author_pubkey) WHERE status = 'open';
            CREATE INDEX IF NOT EXISTS idx_decisions_status_created ON decisions(status, created_at DESC);
        `);
    })();
}
