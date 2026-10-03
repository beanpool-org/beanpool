/**
 * names_access_log's CHECK on a node made before 'copy_restored' (review of #1520, finding 4171093712): schema.sql's
 * CREATE TABLE IF NOT EXISTS never changes an existing table, so db.ts rebuilds it. A state.db with the table as #1411
 * made it, booted: the old rows kept, a 'copy_restored' line accepted; the rebuild run again changes nothing.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-names-access-log-migration.ts
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

const OLD_TABLE = `CREATE TABLE names_access_log (
    id              TEXT PRIMARY KEY,
    actor_pubkey    TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('read', 'export', 'add', 'edit', 'delete', 'confirm', 'second', 'revoke',
                                                    'key_made', 'key_changed', 'key_shared', 'holder_dropped', 'settings')),
    entry_id        TEXT,
    subject_pubkey  TEXT,
    at              DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at      DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

async function main(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR not set');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Database(path.join(dir, 'state.db'));
    old.exec(OLD_TABLE);
    old.prepare(`INSERT INTO names_access_log (id, actor_pubkey, action, entry_id, subject_pubkey, at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('row-1', 'aa'.repeat(32), 'settings', null, null, '2026-10-02T21:00:00.000Z', '2026-10-02T21:00:00.000Z');
    old.close();

    const { db, initSchema, rebuildNamesAccessLogCheck } = await import('./db/db.js');
    initSchema();
    const sqlOf = () => (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='names_access_log'`).get() as { sql: string }).sql;
    check(sqlOf().includes('copy_restored'), '1. after boot the CHECK allows copy_restored');
    const kept = db.prepare(`SELECT * FROM names_access_log WHERE id = 'row-1'`).get() as Record<string, unknown> | undefined;
    check(kept?.action === 'settings' && kept?.at === '2026-10-02T21:00:00.000Z' && kept?.actor_pubkey === 'aa'.repeat(32), '2. the old row is kept as it was');
    let wrote = true;
    try {
        db.prepare(`INSERT INTO names_access_log (id, actor_pubkey, action) VALUES ('row-2', ?, 'copy_restored')`).run('bb'.repeat(32));
    } catch { wrote = false; }
    check(wrote, '3. a copy_restored line is accepted');
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_names_access_log_at'`).get();
    check(!!idx, '4. the at index is there');
    const trig = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='names_access_log'`).get() as { n: number };
    check(trig.n > 0, '5. the replication watermark triggers are on the rebuilt table');
    const stamped = db.prepare(`SELECT updated_at FROM names_access_log WHERE id = 'row-2'`).get() as { updated_at: string | null };
    check(!!stamped?.updated_at, '6. the new line carries updated_at');

    const before = { sql: sqlOf(), rows: db.prepare(`SELECT * FROM names_access_log ORDER BY id`).all() };
    const again = rebuildNamesAccessLogCheck(db);
    const after = { sql: sqlOf(), rows: db.prepare(`SELECT * FROM names_access_log ORDER BY id`).all() };
    check(again === false && JSON.stringify(before) === JSON.stringify(after), '7. run again: nothing rebuilt, nothing changed');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
