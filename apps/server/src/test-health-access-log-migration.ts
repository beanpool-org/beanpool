/**
 * health_access_log on a node made before the looks at disputes and alerts were logged (queue item 29, Marty 4 Oct:
 * "Keep disputes, log every look, totals only in member stats"): schema.sql's CREATE TABLE IF NOT EXISTS never changes
 * an existing table, so db.ts rebuilds it. A state.db with the table as #1599 made it, booted: the old rows kept, a
 * dispute look with its trade ids, a stranded escrows look and an alerts look accepted; the rebuild run again changes
 * nothing; a table with the trade looks but no stranded escrows look is rebuilt with its detail kept. Then the token
 * behind a look (#1613's actor survey): main's table (before token_id/token_name) gains both, every row kept, NULL in
 * both; run again, and on the newest table, nothing changes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-health-access-log-migration.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

let passed = 0;
let run = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const OLD_TABLE = `CREATE TABLE health_access_log (
    id             TEXT PRIMARY KEY,
    actor_pubkey   TEXT NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('exceptions_opened', 'offboard_preview', 'offboard_settled')),
    subject_pubkey TEXT,
    at             DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

const MIDDLE_TABLE = `CREATE TABLE health_access_log (
    id             TEXT PRIMARY KEY,
    actor_pubkey   TEXT NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('exceptions_opened', 'offboard_preview', 'offboard_settled',
                                                   'disputes_listed', 'dispute_opened', 'alerts_read')),
    subject_pubkey TEXT,
    detail         TEXT,
    at             DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

// health_access_log as main made it before the token was recorded (schema.sql at 901ee0fe).
const MAIN_TABLE = `CREATE TABLE health_access_log (
    id             TEXT PRIMARY KEY,
    actor_pubkey   TEXT NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('exceptions_opened', 'offboard_preview', 'offboard_settled',
                                                   'disputes_listed', 'dispute_opened', 'alerts_read',
                                                   'stranded_escrows_read')),
    subject_pubkey TEXT,
    detail         TEXT,
    at             DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

async function main(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR not set');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Database(path.join(dir, 'state.db'));
    old.exec(OLD_TABLE);
    old.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('row-1', 'aa'.repeat(32), 'offboard_preview', 'cc'.repeat(32), '2026-10-03T21:00:00.000Z', '2026-10-03T21:00:00.000Z');
    old.close();

    const { db, initSchema, rebuildHealthAccessLogCheck, addHealthAccessLogToken } = await import('./db/db.js');
    initSchema();
    const sqlOf = () => (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='health_access_log'`).get() as { sql: string }).sql;
    check(['disputes_listed', 'dispute_opened', 'alerts_read', 'stranded_escrows_read'].every((a) => sqlOf().includes(a)) && /\bdetail\b/.test(sqlOf()),
        '1. after boot the CHECK allows the looks at disputes, stranded escrows and alerts, and the table has detail');
    check(/\btoken_id\b/.test(sqlOf()) && /\btoken_name\b/.test(sqlOf()), '1b. and booting gives it token_id and token_name');
    const kept = db.prepare(`SELECT * FROM health_access_log WHERE id = 'row-1'`).get() as Record<string, unknown> | undefined;
    check(kept?.action === 'offboard_preview' && kept?.subject_pubkey === 'cc'.repeat(32) && kept?.at === '2026-10-03T21:00:00.000Z'
        && kept?.actor_pubkey === 'aa'.repeat(32) && kept?.detail === null, '2. the old row is kept as it was');
    let wrote = true;
    try {
        db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, detail) VALUES ('row-2', ?, 'disputes_listed', ?)`).run('bb'.repeat(32), JSON.stringify(['t1', 't2']));
        db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey) VALUES ('row-3', ?, 'alerts_read', ?)`).run('bb'.repeat(32), 'cc'.repeat(32));
        db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, detail) VALUES ('row-5', ?, 'stranded_escrows_read', ?)`).run('bb'.repeat(32), JSON.stringify(['t3']));
    } catch { wrote = false; }
    check(wrote, '3. a disputes look with its trade ids, a stranded escrows look and an alerts look naming a member are accepted');
    let refused = false;
    try { db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action) VALUES ('row-4', ?, 'anything')`).run('bb'.repeat(32)); } catch { refused = true; }
    check(refused, '4. an action outside the list is still refused');
    const trig = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='health_access_log'`).get() as { n: number };
    check(trig.n > 0, '5. the replication watermark triggers are on the rebuilt table');
    const stamped = db.prepare(`SELECT updated_at FROM health_access_log WHERE id = 'row-2'`).get() as { updated_at: string | null };
    check(!!stamped?.updated_at, '6. the new line carries updated_at');

    const before = { sql: sqlOf(), rows: db.prepare(`SELECT * FROM health_access_log ORDER BY id`).all() };
    const again = rebuildHealthAccessLogCheck(db);
    const after = { sql: sqlOf(), rows: db.prepare(`SELECT * FROM health_access_log ORDER BY id`).all() };
    check(again === false && JSON.stringify(before) === JSON.stringify(after), '7. run again: nothing rebuilt, nothing changed');

    // A table this PR's first rebuild made (the trade looks and detail, but no stranded_escrows_read): rebuilt, every
    // row kept with its detail.
    db.exec(`DROP TABLE health_access_log; ${MIDDLE_TABLE}`);
    db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, detail, at, updated_at) VALUES ('mid-1', ?, 'disputes_listed', ?, ?, ?)`)
        .run('aa'.repeat(32), JSON.stringify(['t7']), '2026-10-04T10:00:00.000Z', '2026-10-04T10:00:00.000Z');
    const rebuiltMiddle = rebuildHealthAccessLogCheck(db);
    const mid = db.prepare(`SELECT * FROM health_access_log WHERE id = 'mid-1'`).get() as Record<string, unknown> | undefined;
    check(rebuiltMiddle && sqlOf().includes('stranded_escrows_read') && mid?.detail === JSON.stringify(['t7']) && mid?.action === 'disputes_listed'
        && mid?.at === '2026-10-04T10:00:00.000Z', '8. a table with the trade looks but no stranded escrows look is rebuilt, its rows kept with their detail');

    const colsOf = () => (db.prepare('PRAGMA table_info(health_access_log)').all() as { name: string }[]).map((c) => c.name);
    check(addHealthAccessLogToken(db) && colsOf().includes('token_id') && colsOf().includes('token_name')
        && (db.prepare(`SELECT * FROM health_access_log WHERE id = 'mid-1'`).get() as Record<string, unknown>)?.detail === JSON.stringify(['t7']),
        '9. that rebuilt table gains token_id and token_name, its rows kept');

    // Main's table, with rows of every kind: it gains the two columns, every row as it was, NULL in both.
    db.exec(`DROP TABLE health_access_log; ${MAIN_TABLE}`);
    const mainRow = db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey, detail, at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    mainRow.run('main-1', 'aa'.repeat(32), 'offboard_preview', 'cc'.repeat(32), null, '2026-10-04T09:00:00.000Z', '2026-10-04T09:00:00.000Z');
    mainRow.run('main-2', 'bb'.repeat(32), 'dispute_opened', null, JSON.stringify(['t8']), '2026-10-04T09:01:00.000Z', '2026-10-04T09:01:00.000Z');
    mainRow.run('main-3', 'bb'.repeat(32), 'alerts_read', 'cc'.repeat(32), null, '2026-10-04T09:02:00.000Z', '2026-10-04T09:02:00.000Z');
    const mainBefore = db.prepare(`SELECT id, actor_pubkey, action, subject_pubkey, detail, at, updated_at FROM health_access_log ORDER BY id`).all();
    const added = addHealthAccessLogToken(db);
    const mainAfter = db.prepare(`SELECT id, actor_pubkey, action, subject_pubkey, detail, at, updated_at FROM health_access_log ORDER BY id`).all();
    const tokens = db.prepare(`SELECT token_id, token_name FROM health_access_log`).all() as Array<{ token_id: unknown; token_name: unknown }>;
    check(added && mainAfter.length === 3 && JSON.stringify(mainAfter) === JSON.stringify(mainBefore) && tokens.every((t) => t.token_id === null && t.token_name === null),
        '10. main\'s table gains token_id and token_name: all 3 rows kept as they were, NULL in both');
    let tokenWrote = true;
    try {
        db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, detail, token_id, token_name) VALUES ('main-4', ?, 'disputes_listed', '[]', 'abcdef012345', 'nightly report')`).run('aa'.repeat(32));
    } catch { tokenWrote = false; }
    check(tokenWrote && (db.prepare(`SELECT token_name FROM health_access_log WHERE id = 'main-4'`).get() as { token_name: string })?.token_name === 'nightly report',
        '11. a token\'s look is written with its id and name');
    const sqlBefore = sqlOf();
    check(addHealthAccessLogToken(db) === false && rebuildHealthAccessLogCheck(db) === false && sqlOf() === sqlBefore
        && (db.prepare('SELECT COUNT(*) AS n FROM health_access_log').get() as { n: number }).n === 4,
        '12. run again, on a table that has them: nothing added, nothing rebuilt, every row there');
    // The newest table, as schema.sql makes it on a new node: nothing to do.
    const schemaSql = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'db', 'schema.sql'), 'utf8');
    const newest = /CREATE TABLE IF NOT EXISTS health_access_log \([\s\S]*?\n\);/.exec(schemaSql)?.[0] ?? '';
    db.exec(`DROP TABLE health_access_log; ${newest}`);
    check(newest.includes('token_id') && addHealthAccessLogToken(db) === false && rebuildHealthAccessLogCheck(db) === false,
        '13. the newest table (schema.sql) has the token already: nothing to do');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
