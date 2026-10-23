/**
 * member_tool_state's CHECK on a node made before a tool could name more than 64 KB (the Tool shed's 128 KB, Marty,
 * 23 Oct 2026): schema.sql's CREATE TABLE IF NOT EXISTS never changes an existing table, so db.ts rebuilds it. A
 * state.db with the table as slice S2 made it, booted: the old rows kept, stamp for stamp, a 128 KB shed accepted and a
 * byte past the ceiling still refused by the table itself; the rebuild run again changes nothing.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-tool-state-check-migration.ts
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

const OLD_TABLE = `CREATE TABLE member_tool_state (
    public_key TEXT NOT NULL REFERENCES members(public_key) ON DELETE CASCADE,
    -- The tool's id: 1 to 24 of a-z, 0-9 and '-' (engine/tool-state.ts TOOL_ID).
    tool       TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 24 AND tool NOT GLOB '*[^a-z0-9-]*'),
    -- The document as JSON text, at most 64 KB as UTF-8 (TOOL_STATE_MAX_BYTES).
    body       TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 65536),
    -- The replication watermark (a plain table), and the copy's time the apps reconcile by: engine/tool-state.ts stamps it.
    updated_at DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (public_key, tool)
);`;

const ANN = 'aa'.repeat(32);
const body = (bytes: number) => JSON.stringify({ v: 1, p: 'a'.repeat(bytes - 14) });

async function main(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR not set');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Database(path.join(dir, 'state.db'));
    // As on every node (db.ts): foreign keys are off, so the rows need no members table here.
    old.pragma('foreign_keys = OFF');
    old.exec(OLD_TABLE);
    old.prepare('INSERT INTO member_tool_state (public_key, tool, body, updated_at) VALUES (?, ?, ?, ?)')
        .run(ANN, 'things', body(65_536), '2026-10-20T01:00:00.000Z');
    old.prepare('INSERT INTO member_tool_state (public_key, tool, body, updated_at) VALUES (?, ?, ?, ?)')
        .run(ANN, 'kit', '{"v":1}', '2026-10-20T02:00:00.000Z');
    let oldRefused = false;
    try { old.prepare('INSERT INTO member_tool_state (public_key, tool, body) VALUES (?, ?, ?)').run(ANN, 'big', body(65_537)); } catch { oldRefused = true; }
    check(oldRefused, '0. setup: the old table refuses a byte past 64 KB');
    old.close();

    const { db, initSchema, rebuildToolStateBodyCheck } = await import('./db/db.js');
    const { TOOL_STATE_CEILING_BYTES } = await import('./engine/tool-state.js');
    initSchema();
    const sqlOf = () => (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='member_tool_state'`).get() as { sql: string }).sql;
    check(sqlOf().includes(`<= ${TOOL_STATE_CEILING_BYTES})`) && TOOL_STATE_CEILING_BYTES === 131_072,
        `1. after boot the CHECK lets in ${TOOL_STATE_CEILING_BYTES} bytes, the most any tool may name`);
    const rows = db.prepare('SELECT public_key, tool, body, updated_at FROM member_tool_state ORDER BY tool').all() as Array<Record<string, string>>;
    check(rows.length === 2 && rows[0].tool === 'kit' && rows[0].updated_at === '2026-10-20T02:00:00.000Z'
        && rows[1].tool === 'things' && rows[1].body === body(65_536) && rows[1].updated_at === '2026-10-20T01:00:00.000Z',
        '2. the old rows are kept as they were, stamp for stamp');
    let took = true;
    try { db.prepare('UPDATE member_tool_state SET body = ? WHERE public_key = ? AND tool = ?').run(body(131_072), ANN, 'things'); } catch { took = false; }
    check(took, '3. a 128 KB shed is taken by the table');
    let refused = false;
    try { db.prepare('UPDATE member_tool_state SET body = ? WHERE public_key = ? AND tool = ?').run(body(131_073), ANN, 'things'); } catch { refused = true; }
    check(refused && (db.prepare(`SELECT length(CAST(body AS BLOB)) AS n FROM member_tool_state WHERE tool = 'things'`).get() as { n: number }).n === 131_072,
        '4. a byte past the ceiling is still refused by the table itself, and nothing changes');
    const fk = db.prepare('PRAGMA foreign_key_list(member_tool_state)').all() as Array<{ table: string; on_delete: string }>;
    check(fk.length === 1 && fk[0].table === 'members' && fk[0].on_delete === 'CASCADE', "5. the owner's row is still named its parent, as schema.sql declares it");

    const before = { sql: sqlOf(), rows: db.prepare('SELECT * FROM member_tool_state ORDER BY tool').all() };
    const again = rebuildToolStateBodyCheck(db);
    const after = { sql: sqlOf(), rows: db.prepare('SELECT * FROM member_tool_state ORDER BY tool').all() };
    check(again === false && JSON.stringify(before) === JSON.stringify(after), '6. run again: nothing rebuilt, nothing changed');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
