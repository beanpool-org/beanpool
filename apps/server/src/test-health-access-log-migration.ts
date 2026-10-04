/**
 * health_access_log on a node made before the looks at disputes and alerts were logged (queue item 29, Marty 4 Oct:
 * "Keep disputes, log every look, totals only in member stats"): schema.sql's CREATE TABLE IF NOT EXISTS never changes
 * an existing table, so db.ts rebuilds it. A state.db with the table as #1599 made it, booted: the old rows kept, a
 * dispute look with its trade ids and an alerts look accepted; the rebuild run again changes nothing.
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

async function main(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR not set');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Database(path.join(dir, 'state.db'));
    old.exec(OLD_TABLE);
    old.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey, at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('row-1', 'aa'.repeat(32), 'offboard_preview', 'cc'.repeat(32), '2026-10-03T21:00:00.000Z', '2026-10-03T21:00:00.000Z');
    old.close();

    const { db, initSchema, rebuildHealthAccessLogCheck } = await import('./db/db.js');
    initSchema();
    const sqlOf = () => (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='health_access_log'`).get() as { sql: string }).sql;
    check(['disputes_listed', 'dispute_opened', 'alerts_read'].every((a) => sqlOf().includes(a)) && /\bdetail\b/.test(sqlOf()),
        '1. after boot the CHECK allows the looks at disputes and alerts, and the table has detail');
    const kept = db.prepare(`SELECT * FROM health_access_log WHERE id = 'row-1'`).get() as Record<string, unknown> | undefined;
    check(kept?.action === 'offboard_preview' && kept?.subject_pubkey === 'cc'.repeat(32) && kept?.at === '2026-10-03T21:00:00.000Z'
        && kept?.actor_pubkey === 'aa'.repeat(32) && kept?.detail === null, '2. the old row is kept as it was');
    let wrote = true;
    try {
        db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, detail) VALUES ('row-2', ?, 'disputes_listed', ?)`).run('bb'.repeat(32), JSON.stringify(['t1', 't2']));
        db.prepare(`INSERT INTO health_access_log (id, actor_pubkey, action, subject_pubkey) VALUES ('row-3', ?, 'alerts_read', ?)`).run('bb'.repeat(32), 'cc'.repeat(32));
    } catch { wrote = false; }
    check(wrote, '3. a disputes look with its trade ids and an alerts look naming a member are accepted');
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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
