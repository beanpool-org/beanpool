/**
 * The database's stamp and the gate at open (db/schema-gate.ts; the 1.4.0 cutover, DESIGN-clean-slate-cutover-fable.md §1
 * and §5). Each case boots the REAL initSchema() in a child process against its own data dir:
 *
 *  1. A fresh data dir boots and is stamped: user_version 5 and this release in node_config.schema_release.
 *  2. A second boot of it is a boot: still stamped, the release written again.
 *  3. A database a kept node last started on 1.4.0 (__fixtures__/schema-v1.4.0.sql, stamped as 1.4.0 stamped it, with rows;
 *     kept-node-test-fixture.ts) boots, is stamped with this release, keeps its rows, and has exactly the tables, columns,
 *     indexes and triggers a fresh install has.
 *  3b. A database a node last started on 1.2.36 (__fixtures__/schema-v1.2.36.sql, user_version 4, with rows), which 1.4.0
 *     opened and stamped (log row CUT1, removed), is refused in §1's words, and the file is byte for byte as it was.
 *  4. A database last started on 1.2.18 (__fixtures__/schema-v1.2.18.sql) is refused in §1's words, and the file is byte
 *     for byte as it was; the node's first step (refuseUnopenableDatabase) refuses it the same way.
 *  5. The 1.2.36 file without its one 1.2.36 object (so a 1.2.35 one) is refused as well.
 *  6. A file a newer release stamped (user_version 6) is refused, in its own words, and left as it was.
 *  7. user_version 5 with no schema_release row is not a stamp: refused, left as it was.
 *  8. A file stamped by another release opens, and the stamp then names this one.
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, bootInto, columns, tmp, runSchemaSuite } from './schema-upgrade-test-harness.js';
import { REFUSED_TOO_OLD, SCHEMA_STAMP, SCHEMA_RELEASE_KEY, refusedTooNew } from './db/schema-gate.js';
import { KEPT_NODE_RELEASE, makeKeptNodeDatabase } from './kept-node-test-fixture.js';
import { getVersion } from './version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_1_2_36 = fs.readFileSync(path.join(HERE, '__fixtures__', 'schema-v1.2.36.sql'), 'utf8');
/** The one object born in 1.2.36, by which 1.4.0's gate knew a 1.2.36 or 1.2.37 file (log row CUT1, removed). */
const RELEASE_1_2_36_OBJECT = 'idx_posts_copy_authors';
const FIXTURE_1_2_18 = fs.readFileSync(path.join(HERE, '__fixtures__', 'schema-v1.2.18.sql'), 'utf8');
const RELEASE = getVersion();

const sha256 = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stateDb = (dir: string): string => path.join(dir, 'state.db');

/**
 * A copy of the database in `from`, into a new data dir. A booted child exits without closing its handle, so what it
 * committed may still be in state.db-wal: a read-write open and close folds it into state.db first.
 */
function copyOf(from: string, name: string): string {
    const d = new Database(stateDb(from));
    d.pragma('wal_checkpoint(TRUNCATE)');
    d.close();
    const dir = tmp(name);
    fs.copyFileSync(stateDb(from), stateDb(dir));
    return dir;
}

/** A data dir holding a database made by `schemaSql` at `userVersion`, in WAL as every node's is, closed (WAL folded in). */
function oldDatabase(name: string, schemaSql: string, userVersion: number, rows?: (d: Database.Database) => void): string {
    const dir = tmp(name);
    const d = new Database(stateDb(dir));
    d.pragma('journal_mode = WAL');
    d.exec(schemaSql);
    rows?.(d);
    d.pragma(`user_version = ${userVersion}`);
    d.close();
    return dir;
}

/** A data dir holding a database a kept node last started on 1.4.0 (kept-node-test-fixture.ts), in WAL, closed. */
function keptNodeDatabase(name: string, rows?: (d: Database.Database) => void): string {
    const dir = tmp(name);
    const d = new Database(stateDb(dir));
    d.pragma('journal_mode = WAL');
    makeKeptNodeDatabase(d);
    rows?.(d);
    d.close();
    return dir;
}

const stampOf = (dir: string): { userVersion: number; release: string | null } => {
    const d = new Database(stateDb(dir), { readonly: true });
    try {
        const row = d.prepare('SELECT value FROM node_config WHERE key = ?').get(SCHEMA_RELEASE_KEY) as { value: string } | undefined;
        return { userVersion: d.pragma('user_version', { simple: true }) as number, release: row?.value ?? null };
    } finally { d.close(); }
};

type Shape = { tables: Map<string, string[]>; objects: Map<string, string> };
/** Every table's columns, and every index's and trigger's SQL (whitespace folded), of the file in `dir`. */
function shapeOf(dir: string): Shape {
    const d = new Database(stateDb(dir), { readonly: true });
    try {
        const rows = d.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).all() as { type: string; name: string; sql: string | null }[];
        const tables = new Map<string, string[]>();
        const objects = new Map<string, string>();
        for (const r of rows) {
            if (r.type === 'table') tables.set(r.name, columns(d, r.name));
            else if (r.type === 'index' || r.type === 'trigger') objects.set(`${r.type} ${r.name}`, String(r.sql).replace(/\s+/g, ' ').trim());
        }
        return { tables, objects };
    } finally { d.close(); }
}

/** A refused boot: the exact line, a failed boot, and the file byte for byte as it was. */
function expectRefused(dir: string, line: string, label: string): void {
    const before = sha256(stateDb(dir));
    const boot = bootInto(dir);
    assert(!boot.ok, `${label}: the boot stops`);
    assert(boot.output.includes(line), `${label}: the operator reads the gate's words (${line.slice(0, 60)}…)`);
    assert(!boot.output.includes('BOOT_OK'), `${label}: nothing after the gate ran`);
    assert(sha256(stateDb(dir)) === before, `${label}: state.db is byte for byte as it was`);
}

runSchemaSuite("the database's stamp and the gate at open", '⭐️ Schema gate checks PASSED.', async () => {
    // ── 1. A fresh install is stamped ─────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. A fresh data dir ---');
    const freshDir = tmp('gate-fresh');
    const fresh = bootInto(freshDir);
    assert(fresh.ok, 'a fresh data dir boots');
    const freshStamp = stampOf(freshDir);
    assert(freshStamp.userVersion === SCHEMA_STAMP, `a fresh install has user_version ${SCHEMA_STAMP} (got ${freshStamp.userVersion})`);
    assert(freshStamp.release === RELEASE, `a fresh install names this release (${RELEASE}) in schema_release (got ${freshStamp.release})`);
    const freshShape = shapeOf(freshDir);
    // What the comparison in 3 reads: hundreds of tables, indexes and triggers, so an empty read can never pass it.
    assert(freshShape.tables.size > 100 && freshShape.objects.size > 300,
        `a fresh install's shape is read whole (${freshShape.tables.size} tables, ${freshShape.objects.size} indexes and triggers)`);
    assert(freshShape.objects.has(`index ${RELEASE_1_2_36_OBJECT}`), `a fresh install has ${RELEASE_1_2_36_OBJECT} too`);
    for (const name of ['idx_members_callsign_unique', 'idx_members_callsign_fold', 'idx_decisions_member_author_open', 'idx_decisions_scope']) {
        assert(freshShape.objects.has(`index ${name}`), `a fresh install has ${name} (schema.sql makes it now, not a boot pass)`);
    }

    // ── 2. A second boot is a boot ────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. The same data dir booted again ---');
    const again = bootInto(freshDir);
    assert(again.ok, 'a stamped database boots again');
    const againStamp = stampOf(freshDir);
    assert(againStamp.userVersion === SCHEMA_STAMP && againStamp.release === RELEASE, 'still stamped, with this release');

    // ── 3. A 1.4.0 database opens, is stamped, and has a fresh install's shape ────────────────────────────────────
    console.log('\n--- 3. A database a kept node last started on 1.4.0 ---');
    const memberKey = 'a'.repeat(64);
    const dir140 = keptNodeDatabase('gate-1.4.0', (d) => {
        d.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, 'Castle')`).run(memberKey);
        d.prepare(`INSERT INTO accounts (public_key, balance_c) VALUES (?, 1250)`).run(memberKey);
        d.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey) VALUES ('p1', 'offer', 'food', 'Eggs', 'A dozen', 400, ?)`).run(memberKey);
        d.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount_c, memo) VALUES ('t1', 'SYSTEM', ?, 1250, 'gift')`).run(memberKey);
    });
    {
        const before = stampOf(dir140);
        assert(before.userVersion === SCHEMA_STAMP && before.release === KEPT_NODE_RELEASE,
            `setup: the file is stamped as 1.4.0 stamped it (user_version ${before.userVersion}, schema_release ${before.release})`);
    }
    const boot140 = bootInto(dir140);
    assert(boot140.ok, `the 1.4.0 database boots${boot140.ok ? '' : `: ${boot140.output.slice(-600)}`}`);
    const stamp140 = stampOf(dir140);
    assert(stamp140.userVersion === SCHEMA_STAMP, `it is stamped user_version ${SCHEMA_STAMP} (got ${stamp140.userVersion})`);
    assert(stamp140.release === RELEASE, `and names this release (got ${stamp140.release})`);
    const shape140 = shapeOf(dir140);
    const missingTables = [...freshShape.tables.keys()].filter((t) => !shape140.tables.has(t));
    assert(missingTables.length === 0, `it has every table a fresh install has${missingTables.length ? ` (missing: ${missingTables.join(', ')})` : ''}`);
    const columnDiffs: string[] = [];
    for (const [table, cols] of freshShape.tables) {
        const got = shape140.tables.get(table);
        if (!got) continue;
        const missing = cols.filter((c) => !got.includes(c));
        const extra = got.filter((c) => !cols.includes(c));
        if (missing.length || extra.length) columnDiffs.push(`${table}: missing [${missing.join(', ')}] extra [${extra.join(', ')}]`);
    }
    assert(columnDiffs.length === 0, `every table has exactly a fresh install's columns${columnDiffs.length ? `:\n    ${columnDiffs.join('\n    ')}` : ''}`);
    const objectDiffs: string[] = [];
    for (const [name, sql] of freshShape.objects) {
        const got = shape140.objects.get(name);
        if (got === undefined) objectDiffs.push(`${name}: missing`);
        else if (got !== sql) objectDiffs.push(`${name}: another shape\n      fresh:    ${sql.slice(0, 160)}\n      upgraded: ${got.slice(0, 160)}`);
    }
    assert(objectDiffs.length === 0, `every index and trigger is a fresh install's, in its shape${objectDiffs.length ? `:\n    ${objectDiffs.join('\n    ')}` : ''}`);
    const extraTables = [...shape140.tables.keys()].filter((t) => !freshShape.tables.has(t));
    const extraObjects = [...shape140.objects.keys()].filter((o) => !freshShape.objects.has(o));
    assert(extraTables.length === 0 && extraObjects.length === 0,
        `nothing a fresh install lacks is left behind${extraTables.length || extraObjects.length ? ` (tables: ${extraTables.join(', ')}; objects: ${extraObjects.join(', ')})` : ''}`);
    {
        const d = new Database(stateDb(dir140), { readonly: true });
        const member = d.prepare('SELECT callsign, inviter_shown FROM members WHERE public_key = ?').get(memberKey) as { callsign: string; inviter_shown: number } | undefined;
        assert(member?.callsign === 'Castle' && member.inviter_shown === 1, 'its member row is kept, as it was');
        const balance = d.prepare('SELECT balance_c FROM accounts WHERE public_key = ?').get(memberKey) as { balance_c: number } | undefined;
        assert(balance?.balance_c === 1250, `its balance is kept, to the hundredth: no step drops money any more (got ${balance?.balance_c})`);
        const post = d.prepare(`SELECT title, price_c, units_left FROM posts WHERE id = 'p1'`).get() as { title: string; price_c: number; units_left: number | null } | undefined;
        assert(post?.title === 'Eggs' && post.price_c === 400 && post.units_left === null,
            `its listing is kept with its price, the column born since 1.4.0 empty (${JSON.stringify(post)})`);
        const ledger = d.prepare(`SELECT amount_c FROM transactions WHERE id = 't1'`).get() as { amount_c: number } | undefined;
        assert(ledger?.amount_c === 1250, 'and its ledger row is kept as it was');
        d.close();
    }
    const twice = bootInto(dir140);
    assert(twice.ok && stampOf(dir140).userVersion === SCHEMA_STAMP, 'booted again, it opens as a stamped database');

    // ── 3b. A 1.2.36 database, which 1.4.0 opened, is refused, untouched ─────────────────────────────────────────
    // 1.4.0 alone opened an unstamped file a kept node last started on 1.2.36 or 1.2.37, knowing it by its one 1.2.36
    // object, and stamped it (log row CUT1); its schema steps brought it to 1.4.0's shape (CUT2, B10, B11). Every kept node
    // has crossed, and those went: such a file is refused now, as one older than 1.2.36 was by 1.4.0.
    console.log('\n--- 3b. A database last started on 1.2.36 ---');
    const dir1236 = oldDatabase('gate-1.2.36', FIXTURE_1_2_36, 4, (d) => {
        d.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, 'Castle')`).run(memberKey);
        d.prepare(`INSERT INTO accounts (public_key, balance) VALUES (?, 12.5)`).run(memberKey);
        d.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey) VALUES ('p1', 'offer', 'food', 'Eggs', 'A dozen', 4, ?)`).run(memberKey);
        d.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo) VALUES ('t1', 'SYSTEM', ?, 12.5, 'gift')`).run(memberKey);
    });
    {
        const d = new Database(stateDb(dir1236), { readonly: true });
        const has1236Object = !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(RELEASE_1_2_36_OBJECT);
        const oldMoney = !!d.prepare(`SELECT 1 FROM pragma_table_info('accounts') WHERE name = 'balance'`).get();
        d.close();
        assert(has1236Object && oldMoney && stampOf(dir1236).userVersion === 4,
            `setup: the file is the shape 1.4.0 opened (user_version 4, ${RELEASE_1_2_36_OBJECT}, its money REAL Beans in accounts.balance)`);
    }
    expectRefused(dir1236, REFUSED_TOO_OLD, 'the 1.2.36 database');
    {
        const before = sha256(stateDb(dir1236));
        const first = bootInto(dir1236, {}, `
            import { refuseUnopenableDatabase } from ${JSON.stringify(path.join(HERE, 'db', 'db.ts'))};
            refuseUnopenableDatabase();
            console.log('BOOT_OK');
        `);
        assert(!first.ok && first.output.includes(REFUSED_TOO_OLD) && sha256(stateDb(dir1236)) === before,
            "the node's first step (index.ts main) refuses it the same way, and leaves it byte for byte as it was");
    }

    // ── 4. A 1.2.18 database is refused, untouched ───────────────────────────────────────────────────────────────
    console.log('\n--- 4. A database last started on 1.2.18 ---');
    const dir1218 = oldDatabase('gate-1.2.18', FIXTURE_1_2_18, 3, (d) => {
        d.prepare(`INSERT INTO members (public_key, callsign) VALUES (?, 'Old')`).run(memberKey);
    });
    expectRefused(dir1218, REFUSED_TOO_OLD, 'the 1.2.18 database');
    assert(REFUSED_TOO_OLD.includes('older than 1.4.0') && REFUSED_TOO_OLD.includes('ghcr.io/beanpool-org/beanpool-node:1.4.0')
        && REFUSED_TOO_OLD.endsWith('Nothing was changed.'), 'the words name the minimum, the image to start once, and that nothing changed');
    {
        const before = sha256(stateDb(dir1218));
        const first = bootInto(dir1218, {}, `
            import { refuseUnopenableDatabase } from ${JSON.stringify(path.join(HERE, 'db', 'db.ts'))};
            refuseUnopenableDatabase();
            console.log('BOOT_OK');
        `);
        assert(!first.ok && first.output.includes(REFUSED_TOO_OLD), "the node's first step (index.ts main) refuses it the same way");
        assert(sha256(stateDb(dir1218)) === before, 'and leaves it byte for byte as it was');
    }

    // ── 5. user_version 4 without the 1.2.36 object ──────────────────────────────────────────────────────────────
    console.log('\n--- 5. A user_version 4 database without the 1.2.36 object ---');
    const dir1235 = oldDatabase('gate-1.2.35', FIXTURE_1_2_36, 4, (d) => { d.exec(`DROP INDEX ${RELEASE_1_2_36_OBJECT}`); });
    expectRefused(dir1235, REFUSED_TOO_OLD, 'a 1.2.35-shape database');

    // ── 6. A newer release's stamp ───────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 6. A database a newer release stamped ---');
    const newerDir = copyOf(freshDir, 'gate-newer');
    { const d = new Database(stateDb(newerDir)); d.pragma('journal_mode = WAL'); d.pragma(`user_version = ${SCHEMA_STAMP + 1}`); d.close(); }
    expectRefused(newerDir, refusedTooNew(SCHEMA_STAMP + 1), 'a newer stamp');

    // ── 7. user_version 5 without a schema_release row ───────────────────────────────────────────────────────────
    console.log('\n--- 7. user_version 5 with no schema_release ---');
    const halfDir = copyOf(freshDir, 'gate-half');
    { const d = new Database(stateDb(halfDir)); d.pragma('journal_mode = WAL'); d.prepare('DELETE FROM node_config WHERE key = ?').run(SCHEMA_RELEASE_KEY); d.close(); }
    expectRefused(halfDir, REFUSED_TOO_OLD, 'user_version 5 without its release');

    // ── 8. Another release's stamp opens, and names this one after ───────────────────────────────────────────────
    console.log('\n--- 8. A database another release stamped ---');
    const otherDir = copyOf(freshDir, 'gate-other');
    { const d = new Database(stateDb(otherDir)); d.pragma('journal_mode = WAL'); d.prepare('UPDATE node_config SET value = ? WHERE key = ?').run('1.4.0-previous', SCHEMA_RELEASE_KEY); d.close(); }
    const other = bootInto(otherDir);
    assert(other.ok, "a database another release stamped boots");
    assert(stampOf(otherDir).release === RELEASE, `its stamp then names this release (${RELEASE})`);

    for (const dir of [freshDir, dir140, dir1236, dir1218, dir1235, newerDir, halfDir, otherDir]) fs.rmSync(dir, { recursive: true, force: true });
});
