/**
 * What a boot does for the rule on what the admins can see (scratch/fable-design/DESIGN-balance-rule-fable.md §3, §5):
 *
 *   1. a state.db from before: confirmations as it was, known_consents with rows, known_consent_log with rows. Booted, every
 *      confirmation is kept as it was, stamps included, 'member' is accepted, the live-row indexes and watermark triggers are
 *      back, the live consents are gone and their record is kept (Q-C). schema.sql calls no connection function
 *   2. the rebuild run again changes nothing
 *   3. the start is written once, 14 days on, and neither a second boot, a second process nor a take-over's passes move it
 *   4. a boot that has to write it writes node_config and nothing else
 *   5. a standby writes none
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-balance-rule-boot.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SCRIPT = fileURLToPath(import.meta.url);

let passed = 0;
let run = 0;
function check(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const OLD_TABLES = `CREATE TABLE confirmations (
    id             TEXT PRIMARY KEY,
    member_pubkey  TEXT NOT NULL,
    entry_id       TEXT NOT NULL,
    confirmed_by   TEXT NOT NULL,
    confirmed_at   DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    needs_second   INTEGER NOT NULL DEFAULT 0 CHECK (needs_second IN (0, 1)),
    seconded_by    TEXT,
    seconded_at    DATETIME,
    revoked_by     TEXT,
    revoked_at     DATETIME,
    -- \`admin\`: an admin revoked it; \`removed\`: the community or an admin removed the member; \`account_deleted\`: the member
    -- deleted their account.
    revoke_reason  TEXT CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin', 'removed', 'account_deleted')),
    updated_at     DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE known_consents (
    member_pubkey  TEXT PRIMARY KEY,
    version        TEXT NOT NULL,
    consented_at   DATETIME NOT NULL,
    updated_at     DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE known_consent_log (
    id             TEXT PRIMARY KEY,
    member_pubkey  TEXT NOT NULL,
    action         TEXT NOT NULL CHECK (action IN ('agreed', 'withdrawn')),
    version        TEXT NOT NULL,
    at             DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`;

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const AT = '2026-10-02T21:00:00.000Z';

/** A process of its own on the data dir it is given: it boots, and says what the start reads there. */
async function bootAndSay(): Promise<void> {
    const { db, initSchema } = await import('./db/db.js');
    initSchema();
    const row = db.prepare("SELECT value FROM node_config WHERE key = 'balance_rule_from'").get() as { value: string } | undefined;
    console.log(`STAMP=${row?.value ?? 'none'}`);
    process.exit(0);
}

function boot(dir: string, env: Record<string, string> = {}): string {
    const out = execFileSync(process.execPath, ['--import', 'tsx', SCRIPT, '--boot-and-say'], { cwd: path.dirname(path.dirname(SCRIPT)), env: { ...process.env, BEANPOOL_DATA_DIR: dir, ...env }, encoding: 'utf8' });
    return /STAMP=(.*)/.exec(out)?.[1] ?? '';
}

async function main(): Promise<void> {
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('BEANPOOL_DATA_DIR not set');
    fs.mkdirSync(dir, { recursive: true });
    const old = new Database(path.join(dir, 'state.db'));
    old.exec(OLD_TABLES);
    const confirm = old.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, confirmed_at, needs_second, seconded_by, seconded_at, revoked_by, revoked_at, revoke_reason, updated_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    confirm.run('c-live', A, 'entry-live', B, AT, 1, B, AT, null, null, null, AT);
    confirm.run('c-gone', B, 'entry-gone', A, AT, 0, null, null, A, AT, 'admin', AT);
    old.prepare('INSERT INTO known_consents (member_pubkey, version, consented_at) VALUES (?, ?, ?)').run(A, '6:50:60', AT);
    old.prepare("INSERT INTO known_consent_log (id, member_pubkey, action, version, at) VALUES ('kept', ?, 'agreed', '6:50:60', ?)").run(A, AT);
    old.close();

    const before = Date.now();
    const { db, initSchema, runMainServerSchemaPasses, rebuildConfirmationsRevokeCheck } = await import('./db/db.js');
    initSchema();

    // ── 1. the migration ──
    const sqlOf = () => (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='confirmations'").get() as { sql: string }).sql;
    check(sqlOf().includes("'member'"), "1. after boot the CHECK allows 'member'");
    const rows = db.prepare('SELECT * FROM confirmations ORDER BY id').all() as Array<Record<string, unknown>>;
    check(rows.length === 2 && rows[0].id === 'c-gone' && rows[0].revoke_reason === 'admin' && rows[0].revoked_by === A && rows[0].stepped_back_owing === 0
        && rows[1].id === 'c-live' && rows[1].needs_second === 1 && rows[1].seconded_at === AT && rows[1].confirmed_at === AT,
        `2. every confirmation is kept as it was (${JSON.stringify(rows)})`);
    check(rows.every((r) => r.updated_at === AT), '3. with its stamp: a standby is sent nothing new for the rebuild');
    db.prepare("UPDATE confirmations SET revoke_reason = 'member', stepped_back_owing = 1, revoked_at = ? WHERE id = 'c-live'").run(AT);
    check((db.prepare("SELECT revoke_reason FROM confirmations WHERE id = 'c-live'").get() as { revoke_reason: string }).revoke_reason === 'member', "4. a 'member' revoke is accepted");
    let refused = false;
    try { db.prepare("UPDATE confirmations SET revoke_reason = 'whim' WHERE id = 'c-live'").run(); } catch { refused = true; }
    check(refused, '5. and the CHECK still refuses anything else');
    db.prepare("UPDATE confirmations SET revoke_reason = NULL, stepped_back_owing = 0, revoked_at = NULL WHERE id = 'c-live'").run();
    const stamped = (db.prepare("SELECT updated_at FROM confirmations WHERE id = 'c-live'").get() as { updated_at: string }).updated_at;
    check(stamped !== AT, '6. the watermark triggers are on the rebuilt table: a write moves the stamp');
    let twice = false;
    try {
        db.prepare("INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by) VALUES ('c-twice', ?, 'entry-other', ?)").run(A, B);
    } catch { twice = true; }
    let entryTwice = false;
    try {
        db.prepare("INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by) VALUES ('c-twice', ?, 'entry-live', ?)").run('cc'.repeat(32), B);
    } catch { entryTwice = true; }
    check(twice && entryTwice, '7. the live-row indexes are back: one live confirmation per member and per entry');
    check(!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'known_consents'").get(), '8. the live consents are gone');
    check((db.prepare('SELECT COUNT(*) AS n FROM known_consent_log').get() as { n: number }).n === 1, '9. and the record of them is kept (Q-C)');

    // ── 2. run again ──
    const was = { sql: sqlOf(), rows: db.prepare('SELECT * FROM confirmations ORDER BY id').all() };
    const again = rebuildConfirmationsRevokeCheck(db);
    check(again === false && JSON.stringify(was) === JSON.stringify({ sql: sqlOf(), rows: db.prepare('SELECT * FROM confirmations ORDER BY id').all() }),
        '10. the rebuild run again: nothing rebuilt, nothing changed');

    // Nothing in the file schema calls a function registered on a connection (no-connection-functions-in-file-schema): an
    // older image's handle has none of ours, and every statement that fires such a trigger would fail to prepare there.
    const schema = fs.readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
    check(!/\b(name_fold|haversine_km)\s*\(/.test(schema.replace(/--.*$/gm, '')), '11. schema.sql calls no connection function');

    // ── 3. the start, once ──
    const read = () => (db.prepare("SELECT value FROM node_config WHERE key = 'balance_rule_from'").get() as { value: string } | undefined)?.value;
    const stamp = read();
    check(!!stamp && Date.parse(stamp) >= before && Date.parse(stamp) <= Date.now(), `12. the boot wrote the start: that moment, no notice (${stamp})`);
    initSchema();
    check(read() === stamp, '13. a second boot leaves it where it was');
    runMainServerSchemaPasses();
    check(read() === stamp, "14. and so do a take-over's passes");
    check(boot(dir) === stamp, '15. and a boot of a process of its own, on the same data dir');

    // ── 4. nothing but node_config ──
    db.prepare("INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 123.45, 1)").run(A);
    const accounts = () => JSON.stringify(db.prepare('SELECT * FROM accounts ORDER BY public_key').all());
    const wereAccounts = accounts();
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    db.prepare("DELETE FROM node_config WHERE key = 'balance_rule_from'").run();
    runMainServerSchemaPasses();
    check(!!read() && accounts() === wereAccounts, '16. a boot that writes the start moves no account');
    const passes = fs.readFileSync(new URL('./db/db.ts', import.meta.url), 'utf8');
    const body = passes.slice(passes.indexOf('function stampBalanceRuleFrom'), passes.indexOf('\n}\n', passes.indexOf('function stampBalanceRuleFrom')));
    check(body.length > 100 && !/getBalance|getAccount|accounts|ledger/i.test(body), '17. and reads none: its only statement is the one INSERT into node_config');
    check(changesBefore > 0, '(the connection was writing all along)');

    // ── 5. a standby ──
    const standby = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-rule-standby-'));
    try {
        check(boot(standby, { NODE_ROLE: 'backup' }) === 'none', "18. a standby's boot writes none: it waits for its main server's");
    } finally {
        fs.rmSync(standby, { recursive: true, force: true });
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

if (process.argv.includes('--boot-and-say')) {
    bootAndSay().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
}
