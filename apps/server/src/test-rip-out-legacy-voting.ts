/**
 * The retired voting features leave nothing behind in the database (2026-09-19).
 *
 * Runs ripOutLegacyVoting against a database shaped like a live node before the removal:
 *   1. the `voting_rounds` blob in node_config is deleted;
 *   2. Decisions with a removed effect (set_rule, set_levy, poll, grant/revoke tier, grant/revoke elder)
 *      are deleted with their votes, so no stored row can reach the executor;
 *   3. the `decisions.touches` CHECK no longer admits 'rule' or 'nothing';
 *   4. every other Decision and vote is kept, with its indexes;
 *   5. re-running is a no-op.
 * Also checks that a fresh node (schema.sql via initSchema) gets the narrow CHECK.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-rip-out-legacy-voting.ts
 */
import Database from 'better-sqlite3';
import { ripOutLegacyVoting, REMOVED_DECISION_EFFECTS } from './db/rip-out-legacy-voting-migration.js';
import { db as freshDb, initSchema } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

// The decisions table exactly as nodes created it before 2026-09-19.
const OLD_SCHEMA = `
CREATE TABLE node_config (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE decisions (
    id                   TEXT PRIMARY KEY,
    author_pubkey        TEXT NOT NULL REFERENCES members(public_key),
    title                TEXT NOT NULL,
    description          TEXT NOT NULL,
    touches              TEXT NOT NULL CHECK (touches IN ('member', 'pool', 'rule', 'nothing')),
    effect               TEXT NOT NULL,
    subject              TEXT,
    params               TEXT,
    franchise            TEXT NOT NULL CHECK (franchise IN ('1m1v', 'quadratic_trade')),
    status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
        'open', 'passed', 'failed', 'unresolved', 'passed_queued_for_funds', 'execution_pending_grace',
        'execution_blocked', 'execution_void', 'executed', 'admin_halted'
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
CREATE UNIQUE INDEX idx_decisions_author_open ON decisions(author_pubkey) WHERE status = 'open';
CREATE TABLE decision_votes (
    decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
    voter_pubkey  TEXT NOT NULL,
    support       INTEGER NOT NULL CHECK (support IN (0, 1)),
    weight        REAL NOT NULL DEFAULT 1,
    credits_used  REAL NOT NULL DEFAULT 1,
    signature     TEXT,
    created_at    DATETIME,
    updated_at    DATETIME,
    PRIMARY KEY (decision_id, voter_pubkey)
);
`;

const TOUCHES: Record<string, string> = {
    set_rule: 'rule', set_levy: 'rule', poll: 'nothing',
    grant_tier: 'member', revoke_tier: 'member', grant_elder: 'member', revoke_elder: 'member',
};

function main() {
    console.log('Running retired-voting cleanup checks...\n');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF'); // as db.ts runs every node
    db.exec(OLD_SCHEMA);

    db.prepare("INSERT INTO node_config (key, value) VALUES ('voting_rounds', ?)").run(JSON.stringify([{ id: 'r1', status: 'open' }]));
    db.prepare("INSERT INTO node_config (key, value) VALUES ('commons_projects', '[]')").run();

    const insert = db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, closes_at)
                               VALUES (?, ?, ?, 'd', ?, ?, ?, ?, '2099-01-01T00:00:00.000Z')`);
    const vote = db.prepare("INSERT INTO decision_votes (decision_id, voter_pubkey, support) VALUES (?, 'voter', 1)");
    for (const effect of REMOVED_DECISION_EFFECTS) {
        insert.run(`gone-${effect}`, `author-${effect}`, effect, TOUCHES[effect], effect, '1m1v', 'passed');
        vote.run(`gone-${effect}`);
    }
    insert.run('keep-member', 'author-keep', 'Suspend spammer', 'member', 'suspend_member', '1m1v', 'open');
    vote.run('keep-member');
    insert.run('keep-pool', 'author-pool', 'Grant', 'pool', 'grant_enterprise', 'quadratic_trade', 'executed');
    vote.run('keep-pool');

    ripOutLegacyVoting(db);

    assert(!db.prepare("SELECT 1 FROM node_config WHERE key = 'voting_rounds'").get(), 'the voting_rounds blob is deleted');
    assert(!!db.prepare("SELECT 1 FROM node_config WHERE key = 'commons_projects'").get(),
        'the commons_projects blob stays (the current propose-project flow still uses it)');

    const left = (db.prepare('SELECT id FROM decisions ORDER BY id').all() as { id: string }[]).map(r => r.id);
    assert(JSON.stringify(left) === JSON.stringify(['keep-member', 'keep-pool']),
        `only Decisions with a current effect remain (got ${left.join(', ')})`);
    const votesLeft = (db.prepare('SELECT decision_id FROM decision_votes ORDER BY decision_id').all() as { decision_id: string }[]).map(r => r.decision_id);
    assert(JSON.stringify(votesLeft) === JSON.stringify(['keep-member', 'keep-pool']),
        `votes on removed Decisions are deleted, the rest kept (got ${votesLeft.join(', ')})`);

    const kept = db.prepare("SELECT * FROM decisions WHERE id = 'keep-member'").get() as any;
    assert(kept.effect === 'suspend_member' && kept.status === 'open' && kept.title === 'Suspend spammer',
        'a kept Decision is copied across unchanged');

    const sqlAfter = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='decisions'").get() as any).sql as string;
    assert(!sqlAfter.includes("'rule'") && !sqlAfter.includes("'nothing'"), 'the touches CHECK no longer names rule or nothing');
    let refused = '';
    try {
        db.prepare("INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, closes_at) VALUES ('x', 'a', 't', 'd', 'rule', 'set_rule', '1m1v', '2099')").run();
    } catch (e: any) { refused = e.message; }
    assert(/CHECK constraint failed/.test(refused), `a 'rule' Decision can no longer be stored (${refused || 'accepted'})`);

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions' AND name LIKE 'idx_%'").all() as { name: string }[]).map(r => r.name);
    assert(indexes.includes('idx_decisions_author_open') && indexes.includes('idx_decisions_tick_open'),
        `the decisions indexes are rebuilt (got ${indexes.join(', ')})`);
    let dupOpen = '';
    try { insert.run('dup-open', 'author-keep', 'Second', 'member', 'grant_voucher', '1m1v', 'open'); } catch (e: any) { dupOpen = e.message; }
    assert(/UNIQUE constraint failed/.test(dupOpen), 'one-open-Decision-per-author is still enforced by its index');

    ripOutLegacyVoting(db);
    assert((db.prepare('SELECT COUNT(*) AS c FROM decisions').get() as any).c === 2, 're-running the cleanup changes nothing');

    initSchema();
    const freshSql = (freshDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='decisions'").get() as any).sql as string;
    assert(!freshSql.includes("'rule'") && !freshSql.includes("'nothing'"), 'a fresh node gets the narrow touches CHECK from schema.sql');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Retired voting leaves nothing behind.');
}

try { main(); process.exit(0); } catch (e) { console.error('❌ Test failed:', e); process.exit(1); }
