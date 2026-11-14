/**
 * Test Suite: `engine/replica-hashes.ts`, the table hashes a standby's whole copy is checked against
 * (scratch/fable-design/decisions/DECISION-table-hashes-version.md: `v` 'd1', a recipe fingerprint `d` per table, the
 * definitions' fingerprint `def` per payload, one reading of them for every check).
 *
 * Verifies:
 * 1. `readTableHashes` reads the 'd1' shape strictly; an older release's (a number for `v`, no `d`) reads null.
 * 2. Golden rows: fixed rows (null, integer, bigint, real, text, blob) hash to the digests pinned for TABLE_HASHES_VERSION,
 *    as rowLine bytes and through the hasher on a database. A change to a row's bytes is a new `v` and a new line here.
 * 3. A table's `d` moves on each change of its recipe (a column added, dropped or reordered; its row rule; a boot stamp; its
 *    order), and back when the change goes; the sync and sliced hashers give every table the same `d` and hash.
 * 4. `def` moves on each input of the manifest it is made from (a table's columns, key, row rule, boot stamps; the tables and
 *    columns left out), and not on a reason's words.
 * 5. Every cell of compareTableHashes's table (same or other `def`; `d` equal and rows equal, `d` equal and rows differing,
 *    `d` differing, the table on their side alone, on mine alone), through each check that reads it: compareTableHashes
 *    itself, checkWholeCopy (its verdict and force-resync in the standby's record), the stager's closing check
 *    (closingHashVerdict) and leftOutTablesCurrent. An old payload's hashes give 'release', a copy without any 'content'.
 * 6. A standby's copy of the directory cache hashes as the main server's (list-on-global G5, #3152): an unlisted row, and
 *    a row from before `listings_from_here` (db.ts's own ALTER on the table as it was), copy with the value they hold.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-replica-hashes.ts
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { EXPORT_CATEGORIES } from '@beanpool/engine';
import { db, initSchema } from './db/db.js';
import { mergeReplicatedDirectory, normaliseRegistryRow, writeDirectoryRows, type DirectoryRow } from './engine/directory-cache.js';
import { BOOT_STAMPED, TABLES } from './engine/replication-manifest.js';
import {
    COLUMNS_NOT_HASHED,
    NOT_HASHED,
    TABLE_HASHES_VERSION,
    compareTableHashes,
    definitionFingerprint,
    hashedTables,
    readTableHashes,
    rowLine,
    tableContentHashes,
    tableContentHashesInSlices,
    type TableHashes,
} from './engine/replica-hashes.js';

let testsRun = 0;
let testsPassed = 0;

function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** A manifest entry, to change for one check and put back after it. */
const entryOf = (table: string) => TABLES[table] as unknown as { columns: string[]; key?: string[]; rows?: { where: string; reason: string } };

/**
 * The golden rows' digests, per TABLE_HASHES_VERSION: `rows`, sha256 over rowLine of GOLDEN_ROWS; `table`, the hasher's
 * hash of GOLDEN_TABLE_ROWS in member_badges on a database. A change to a row's bytes fails here: raise the version and
 * add its line, never edit an old one.
 */
const GOLDEN: Record<string, { rows: string; table: string }> = {
    d1: { rows: 'a958d9443cbe4d7311d353e4d38823c5026640631877ef3889bdc5c1332e9705', table: '433de24a744cbc096ae8afcec2bfdb9f0c6f1c1c27b2786cf7a20d10eb900275' },
};
const GOLDEN_ROWS: unknown[][] = [
    [null, 0, -42, 1n << 62n, 1.5, -0.25, 'text', 'naïve "quoted"\né', Buffer.from([0, 1, 254, 255]), Buffer.alloc(0), ''],
    [9007199254740991, 1e-7, '0', null],
];
const GOLDEN_TABLE_ROWS: unknown[][] = [
    ['a-member', null, 7, 2.5, Buffer.from('beans')],
    ['b-member', 'Elder', -1, 'set "at"', null],
];

async function main(): Promise<void> {
    if (!process.env.BEANPOOL_DATA_DIR) {
        throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    }

    initSchema();

    console.log('\n— 1. readTableHashes —');
    assert(readTableHashes(null) === null, 'null raw payload returns null');
    assert(readTableHashes(undefined) === null, 'undefined raw payload returns null');
    assert(readTableHashes('string') === null, 'string raw payload returns null');
    assert(readTableHashes({}) === null, 'empty object returns null');
    const validHash = 'a'.repeat(64);
    const d = '0123456789abcdef';
    const def = 'fedcba9876543210';
    // An older release's payload (v 43, 44: a number, and no `d` in a table): not this one's, whatever it holds.
    assert(readTableHashes({ v: 43, tables: { accounts: { rows: 2, hash: validHash } } }) === null, 'the old shape (v 43, no d) reads null');
    assert(readTableHashes({ v: 44, tables: { accounts: { rows: 2, hash: validHash } } }) === null, 'the old shape (v 44, no d) reads null');
    assert(readTableHashes({ v: 44, def, tables: { accounts: { rows: 2, hash: validHash, d } } }) === null, 'a number for v reads null, even with d and def');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, tables: {} }) === null, 'no def returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def: 'xyz', tables: {} }) === null, 'a def that is no fingerprint returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: 'invalid' }) === null, 'non-object tables returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: [] }) === null, 'a list for tables returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: { accounts: { rows: 2, hash: 'invalid-hash', d } } }) === null,
        'invalid table hash string causes readTableHashes to return null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: { accounts: { rows: 'two', hash: validHash, d } } }) === null,
        'invalid table row count causes readTableHashes to return null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: { accounts: { rows: 2, hash: validHash } } }) === null,
        'a table without d returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: { accounts: { rows: 2, hash: validHash, d: 'D'.repeat(16) } } }) === null,
        'a d that is no fingerprint returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: { 'no such; table': { rows: 2, hash: validHash, d } } }) === null,
        'a table name that is no name returns null');
    const parsed = readTableHashes({ v: TABLE_HASHES_VERSION, def, tables: { accounts: { rows: 2, hash: validHash, d } } });
    assert(parsed !== null && parsed.def === def && parsed.v === TABLE_HASHES_VERSION, 'valid table hashes object returns them');
    assert(parsed?.tables.accounts?.rows === 2 && parsed.tables.accounts.hash === validHash && parsed.tables.accounts.d === d, 'valid table entry parsed correctly');

    console.log('\n— 2. golden rows —');
    const golden = GOLDEN[TABLE_HASHES_VERSION];
    const rowsDigest = sha256(GOLDEN_ROWS.map(rowLine).join(''));
    assert(golden?.rows === rowsDigest, `the golden rows' bytes are version ${TABLE_HASHES_VERSION}'s (they read ${rowsDigest})`);
    const goldenDb = new Database(':memory:');
    goldenDb.exec('CREATE TABLE member_badges (member_pubkey, tier, set_by, set_at, updated_at, PRIMARY KEY (member_pubkey))');
    const putGolden = goldenDb.prepare('INSERT INTO member_badges (member_pubkey, tier, set_by, set_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const row of GOLDEN_TABLE_ROWS) putGolden.run(...row);
    const goldenTable = tableContentHashes({ only: ['member_badges'] }, goldenDb).tables.member_badges;
    assert(goldenTable?.rows === 2 && golden?.table === goldenTable.hash,
        `the hasher's hash of the golden table is version ${TABLE_HASHES_VERSION}'s (it reads ${goldenTable?.hash})`);
    assert(goldenTable?.hash === sha256(GOLDEN_TABLE_ROWS.map(rowLine).join('')), 'the hasher hashes each row as rowLine says, in key order');

    console.log('\n— 3. a table\'s d —');
    // member_badges, on a database of its own: every column the manifest names, keyed on the member.
    const badges = (columns: string) => {
        const conn = new Database(':memory:');
        conn.exec(`CREATE TABLE member_badges (${columns}, PRIMARY KEY (member_pubkey))`);
        return conn;
    };
    const dOf = (conn: Database.Database, table = 'member_badges') => hashedTables(conn).find((t) => t.table === table)?.d;
    const full = badges('member_pubkey, tier, set_by, set_at, updated_at');
    const base = dOf(full);
    assert(typeof base === 'string' && /^[0-9a-f]{16}$/.test(base), `a table's d is 16 hex (${base})`);
    assert(dOf(badges('updated_at, set_at, set_by, tier, member_pubkey')) === base, 'the database\'s own column order moves no d (the manifest\'s order is hashed)');
    const dropped = dOf(badges('member_pubkey, tier, set_at, updated_at'));
    assert(dropped !== undefined && dropped !== base, `a column dropped moves d (${dropped} vs ${base})`);
    const entry = entryOf('member_badges');
    const columnsBefore = entry.columns;
    entry.columns = [...columnsBefore, 'note'];
    const added = dOf(badges('member_pubkey, tier, set_by, set_at, updated_at, note'));
    assert(added !== undefined && added !== base, `a column added moves d (${added} vs ${base})`);
    entry.columns = [columnsBefore[1], columnsBefore[0], ...columnsBefore.slice(2)];
    const reordered = dOf(full);
    assert(reordered !== base, `the manifest's columns reordered move d (${reordered} vs ${base})`);
    entry.columns = columnsBefore;
    assert(dOf(full) === base, 'the columns put back give the same d');
    entry.rows = { where: "tier IS NOT NULL", reason: 'a check of this suite' };
    const ruled = dOf(full);
    assert(ruled !== base, `a row rule moves d (${ruled} vs ${base})`);
    delete entry.rows;
    BOOT_STAMPED.push({ table: 'member_badges', column: 'updated_at', where: "tier = 'Elder'", reason: 'a check of this suite' });
    const stamped = dOf(full);
    BOOT_STAMPED.pop();
    assert(stamped !== base, `a boot stamp moves d (${stamped} vs ${base})`);
    entry.key = ['tier', 'member_pubkey'];
    const ordered = dOf(full);
    delete entry.key;
    assert(ordered !== base, `another order moves d (${ordered} vs ${base})`);
    assert(dOf(full) === base, 'everything put back gives the same d');
    assert(dOf(badges('member_pubkey, tier, set_by, set_at, updated_at, local_only')) === base, 'a column the manifest doesn\'t name moves no d (it isn\'t hashed)');

    const syncHashes = tableContentHashes();
    assert(syncHashes.v === TABLE_HASHES_VERSION && syncHashes.def === definitionFingerprint(), 'the sync hashes carry this version and the definitions\' fingerprint');
    assert(typeof syncHashes.tables.accounts === 'object' && /^[0-9a-f]{64}$/.test(syncHashes.tables.accounts.hash), 'accounts table hash generated');
    const accountsOnly = tableContentHashes({ only: ['accounts'] });
    assert(Object.keys(accountsOnly.tables).length === 1 && 'accounts' in accountsOnly.tables, '`only` option filters to specified tables');
    const slicedHashes = await tableContentHashesInSlices(db, {}, { sliceRows: 1, sliceBytes: 100, pause: async () => {}, stopped: () => false });
    assert(slicedHashes.v === TABLE_HASHES_VERSION && slicedHashes.def === syncHashes.def, 'the sliced hashes carry the same version and def');
    const notSame = Object.keys(syncHashes.tables).filter((t) => JSON.stringify(slicedHashes.tables[t]) !== JSON.stringify(syncHashes.tables[t]));
    assert(Object.keys(syncHashes.tables).length > 100 && notSame.length === 0 && Object.keys(slicedHashes.tables).length === Object.keys(syncHashes.tables).length,
        `the sync and sliced hashers give every table (${Object.keys(syncHashes.tables).length}) the same d, rows and hash (${notSame.join(', ') || 'none differ'})`);
    const stampedTable = BOOT_STAMPED[0].table;
    assert(syncHashes.tables[stampedTable]?.d === dOf(db, stampedTable) && syncHashes.tables[stampedTable].d !== undefined,
        `a boot-stamped table (${stampedTable}) carries the d hashedTables gives it`);
    let stoppedErrorCaught = false;
    try {
        await tableContentHashesInSlices(db, { only: ['accounts'] }, { sliceRows: 1, sliceBytes: 100, pause: async () => {}, stopped: () => true });
    } catch (e: any) {
        stoppedErrorCaught = e?.message === 'stopped';
    }
    assert(stoppedErrorCaught, 'tableContentHashesInSlices throws when stopped() returns true');

    console.log('\n— 4. def —');
    const def0 = definitionFingerprint();
    assert(/^[0-9a-f]{16}$/.test(def0), `def is 16 hex (${def0})`);
    const moves = (what: string, change: () => () => void) => {
        const undo = change();
        const moved = definitionFingerprint();
        undo();
        assert(moved !== def0 && definitionFingerprint() === def0, `def moves on ${what}, and comes back (${moved} vs ${def0})`);
    };
    moves('a table\'s columns', () => { entry.columns = [...columnsBefore, 'note']; return () => { entry.columns = columnsBefore; }; });
    moves('a table\'s columns reordered', () => { entry.columns = [...columnsBefore].reverse(); return () => { entry.columns = columnsBefore; }; });
    moves('a table\'s key', () => { entry.key = ['member_pubkey']; return () => { delete entry.key; }; });
    moves('a table\'s row rule', () => { entry.rows = { where: 'tier IS NOT NULL', reason: 'r' }; return () => { delete entry.rows; }; });
    moves('a boot stamp', () => {
        BOOT_STAMPED.push({ table: 'member_badges', column: 'updated_at', where: "tier = 'Elder'", reason: 'r' });
        return () => { BOOT_STAMPED.pop(); };
    });
    moves('a boot stamp\'s rows', () => {
        const was = BOOT_STAMPED[0].where;
        BOOT_STAMPED[0].where = `${was} OR 0`;
        return () => { BOOT_STAMPED[0].where = was; };
    });
    moves('a new table', () => {
        (TABLES as Record<string, unknown>).hash_suite_table = { ...TABLES.member_badges };
        return () => { delete (TABLES as Record<string, unknown>).hash_suite_table; };
    });
    moves('a table left out (NOT_HASHED)', () => { NOT_HASHED.member_badges = 'r'; return () => { delete NOT_HASHED.member_badges; }; });
    moves('a column left out (COLUMNS_NOT_HASHED)', () => {
        COLUMNS_NOT_HASHED.member_badges = { set_by: 'r' };
        return () => { delete COLUMNS_NOT_HASHED.member_badges; };
    });
    const reasonWas = BOOT_STAMPED[0].reason;
    BOOT_STAMPED[0].reason = 'other words';
    entry.rows = undefined;
    assert(definitionFingerprint() === def0, 'a reason\'s words move no def (code only)');
    BOOT_STAMPED[0].reason = reasonWas;
    delete entry.rows;

    console.log('\n— 5. every cell, through every check —');
    const { checkWholeCopy, leftOutTablesCurrent } = await import('./services/backup-puller.js');
    const { closingHashVerdict } = await import('./services/stager.js');
    const { readCopyRecord } = await import('./services/standby-copy-record.js');
    // Each check runs seven hours after the last, so the held force-resync's six-hour limit never hides one asked for.
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const T = 'member_badges';
    const mine0 = tableContentHashes();
    type Shape = 'equal' | 'rows differ' | 'd differs' | 'theirs only' | 'mine only';
    interface Cell { shape: Shape; sameDef: boolean; cmp: 'compared' | 'differing' | 'drift' | 'otherRelease'; verdict: 'exact' | 'inexact' | 'uncompared'; resync: boolean; current: boolean }
    const cells: Cell[] = [
        { shape: 'equal', sameDef: true, cmp: 'compared', verdict: 'exact', resync: false, current: true },
        { shape: 'rows differ', sameDef: true, cmp: 'differing', verdict: 'inexact', resync: true, current: false },
        { shape: 'd differs', sameDef: true, cmp: 'drift', verdict: 'inexact', resync: false, current: false },
        { shape: 'theirs only', sameDef: true, cmp: 'drift', verdict: 'inexact', resync: false, current: false },
        { shape: 'mine only', sameDef: true, cmp: 'drift', verdict: 'inexact', resync: false, current: false },
        { shape: 'equal', sameDef: false, cmp: 'compared', verdict: 'exact', resync: false, current: true },
        { shape: 'rows differ', sameDef: false, cmp: 'differing', verdict: 'inexact', resync: true, current: false },
        { shape: 'd differs', sameDef: false, cmp: 'otherRelease', verdict: 'uncompared', resync: false, current: false },
        { shape: 'theirs only', sameDef: false, cmp: 'otherRelease', verdict: 'uncompared', resync: false, current: false },
        { shape: 'mine only', sameDef: false, cmp: 'otherRelease', verdict: 'uncompared', resync: false, current: false },
    ];
    const recordOf = () => readCopyRecord();
    for (const cell of cells) {
        const name = `${cell.shape}, ${cell.sameDef ? 'same def' : 'other def'}`;
        const theirs: TableHashes = clone(mine0);
        if (!cell.sameDef) theirs.def = '0000000000000000';
        if (cell.shape === 'rows differ') theirs.tables[T] = { ...theirs.tables[T], rows: theirs.tables[T].rows + 1, hash: 'f'.repeat(64) };
        if (cell.shape === 'd differs') theirs.tables[T] = { ...theirs.tables[T], d: '0123456789abcdef' };
        if (cell.shape === 'mine only') delete theirs.tables[T];
        // On their side alone: this database lacks the table (a migration that failed), as the main server has it.
        if (cell.shape === 'theirs only') db.exec(`ALTER TABLE ${T} RENAME TO hash_suite_aside`);
        try {
            shift += 7 * 3600_000;
            db.prepare("DELETE FROM node_config WHERE key = 'standby_copy_record'").run();
            const mine = tableContentHashes();
            const found = compareTableHashes(theirs, mine);
            const where = (['compared', 'drift', 'otherRelease'] as const).filter((k) => found[k].includes(T));
            const differing = found.differing.some((x) => x.table === T);
            assert(JSON.stringify(where) === JSON.stringify(cell.cmp === 'differing' ? ['compared'] : [cell.cmp]) && differing === (cell.cmp === 'differing'),
                `${name}: compareTableHashes puts ${T} in ${cell.cmp} (${JSON.stringify(where)}${differing ? ', differing' : ''})`);
            const others = [...found.compared.filter((t) => t !== T), ...found.drift, ...found.otherRelease].filter((t) => t !== T);
            assert(others.length === found.compared.length - (where.includes('compared') ? 1 : 0) && found.exact === (cell.verdict === 'exact'),
                `${name}: every other table compared and equal, and exact is ${cell.verdict === 'exact'} (${found.exact})`);

            // checkWholeCopy: a copy carrying these hashes, and nothing else it would count.
            checkWholeCopy({ tableHashes: theirs, accounts: [] } as any);
            const r = recordOf();
            const verdict = r.lastWhole ? (r.lastWhole.exact ? 'exact' : 'inexact') : r.lastUncompared ? 'uncompared' : 'none';
            assert(verdict === cell.verdict, `${name}: checkWholeCopy's verdict is ${cell.verdict} (${verdict}: ${JSON.stringify(r.lastWhole ?? r.lastUncompared)})`);
            if (cell.verdict === 'inexact') {
                assert(r.lastWhole?.differs.includes(T) === true && r.lastWhole.resyncAsked === cell.resync,
                    `${name}: checkWholeCopy names ${T} and ${cell.resync ? 'asks' : 'asks no'} force-resync (${JSON.stringify(r.lastWhole?.differs)}, ${r.lastWhole?.resyncAsked})`);
            }
            if (cell.verdict === 'uncompared') {
                assert(JSON.stringify(r.lastUncompared?.notCompared) === '["release"]' && JSON.stringify(r.lastUncompared?.otherRelease) === JSON.stringify([T]),
                    `${name}: checkWholeCopy says another release, ${T} not compared (${JSON.stringify(r.lastUncompared)})`);
            }

            // The stager's closing check.
            const staged = closingHashVerdict(theirs, found, new Set(), new Set());
            assert(staged.verdict === cell.verdict && staged.mendable.includes(T) === cell.resync
                && staged.drift.includes(T) === (cell.cmp === 'drift') && staged.otherRelease.includes(T) === (cell.cmp === 'otherRelease')
                && staged.differs.includes(T) === (cell.verdict === 'inexact'),
                `${name}: the stager's closing check says ${cell.verdict}${cell.resync ? ', mended by a force-resync' : ''} (${JSON.stringify(staged)})`);
            assert(JSON.stringify(staged.notCompared) === (cell.verdict === 'uncompared' ? '["release"]' : '[]'),
                `${name}: the stager's closing check says what wasn't compared (${JSON.stringify(staged.notCompared)})`);

            // leftOutTablesCurrent: the table, left out of the copy, is current here only when compared and equal.
            const current = leftOutTablesCurrent({ tableHashes: theirs } as any, [T]);
            assert(JSON.stringify(current) === JSON.stringify(cell.current ? [T] : []), `${name}: leftOutTablesCurrent ${cell.current ? 'finds' : 'doesn\'t find'} ${T} current (${JSON.stringify(current)})`);
        } finally {
            if (cell.shape === 'theirs only') db.exec(`ALTER TABLE hash_suite_aside RENAME TO ${T}`);
        }
    }
    // An empty list of hashes is no exact copy: every table this server hashes is on its side alone.
    const empty = compareTableHashes({ ...mine0, tables: {} }, mine0);
    assert(!empty.exact && empty.drift.length === Object.keys(mine0.tables).length, `an empty list of hashes is drift for every table (${empty.drift.length})`);
    // A copy without hashes: 'content'. One with an older release's (v 44, no d): 'release', and no table named.
    shift += 7 * 3600_000;
    checkWholeCopy({ accounts: [] } as any);
    assert(JSON.stringify(recordOf().lastUncompared?.notCompared) === '["content"]', `a copy without hashes: not compared, 'content' (${JSON.stringify(recordOf().lastUncompared)})`);
    shift += 7 * 3600_000;
    const oldShape = { v: 44, tables: Object.fromEntries(Object.entries(mine0.tables).map(([t, h]) => [t, { rows: h.rows, hash: h.hash }])) };
    checkWholeCopy({ tableHashes: oldShape, accounts: [] } as any);
    const old = recordOf().lastUncompared;
    assert(JSON.stringify(old?.notCompared) === '["release"]' && JSON.stringify(old?.otherRelease) === '[]',
        `an older release's hashes (v 44, no d): not compared, 'release', no table named (${JSON.stringify(old)})`);
    assert(closingHashVerdict(oldShape, null, new Set(), new Set()).verdict === 'uncompared'
        && JSON.stringify(closingHashVerdict(oldShape, null, new Set(), new Set()).notCompared) === '["release"]'
        && JSON.stringify(closingHashVerdict(undefined, null, new Set(), new Set()).notCompared) === '["content"]',
        'the stager\'s closing check says the same of both');
    assert(JSON.stringify(leftOutTablesCurrent({ tableHashes: oldShape } as any, [T])) === '[]', 'leftOutTablesCurrent finds nothing current from an older release\'s hashes');
    Date.now = realNow;

    console.log('\n— 6. A standby\'s copy of the directory cache hashes as the main server\'s —');
    // The main server's rows go out as a whole copy does (the engine's export category), the table is emptied as a
    // force-resync empties it, and the standby's merge takes them: the two hashes are one.
    const directoryCategory = EXPORT_CATEGORIES.find((c) => c.key === 'directoryCache')!;
    const directoryHash = (conn: Database.Database) => tableContentHashes({ only: ['directory_cache'] }, conn).tables.directory_cache;
    const copiedOnto = (from: Database.Database) => {
        const rows = directoryCategory.shape(from as any, from.prepare('SELECT * FROM directory_cache').all());
        db.prepare('DELETE FROM directory_cache').run();
        return mergeReplicatedDirectory(rows);
    };
    const switchOf = (conn: Database.Database, key: string) =>
        (conn.prepare('SELECT listings_from_here AS v FROM directory_cache WHERE community_key = ?').get(key) as { v: unknown } | undefined)?.v;
    const community = (key: string, listingsFromHere?: boolean): DirectoryRow => normaliseRegistryRow({
        node_id: key, community_name: `Commons ${key}`, node_url: `https://${key}.example.org`, updated_at: '2026-11-15T00:00:00.000Z',
        ...(listingsFromHere === undefined ? {} : { listings_from_here: listingsFromHere }),
    })!;

    // a. An unlisted row: listed with its switch off, then gone from the registry, so a run scrubs it.
    writeDirectoryRows([community('dir-on'), community('dir-off', false), community('dir-leaving', false)], '2026-11-15T00:00:00.000Z');
    writeDirectoryRows([community('dir-on'), community('dir-off', false)], '2026-11-15T01:00:00.000Z');
    const mainDirectory = directoryHash(db);
    assert(switchOf(db, 'dir-leaving') === 1 && switchOf(db, 'dir-off') === 0 && switchOf(db, 'dir-on') === 1,
        `the main server stores the unlisted row's switch as 1, never NULL, and a listed false as 0 (${switchOf(db, 'dir-leaving')}, ${switchOf(db, 'dir-off')}, ${switchOf(db, 'dir-on')})`);
    const mergedUnlisted = copiedOnto(db);
    assert(mergedUnlisted.written === 3 && mergedUnlisted.invalid === 0, `the standby takes the three rows (${JSON.stringify(mergedUnlisted)})`);
    assert(switchOf(db, 'dir-leaving') === 1 && switchOf(db, 'dir-off') === 0,
        `the copy stores the unlisted row's switch as 1 and the listed false as 0 (${switchOf(db, 'dir-leaving')}, ${switchOf(db, 'dir-off')})`);
    assert(directoryHash(db).rows === 3 && directoryHash(db).hash === mainDirectory.hash,
        `an unlisted row: the standby's hash is the main server's (${directoryHash(db).hash.slice(0, 12)} vs ${mainDirectory.hash.slice(0, 12)})`);

    // b. A row from before the column, on a main server that has been running since: the table as schema.sql had it
    // before G5, a listed and a scrubbed row in it, then db.ts's own ALTER, as an update's boot runs it.
    const schemaSql = fs.readFileSync(new URL('./db/schema.sql', import.meta.url), 'utf8');
    const dbTs = fs.readFileSync(new URL('./db/db.ts', import.meta.url), 'utf8');
    const createNow = /CREATE TABLE IF NOT EXISTS directory_cache \([\s\S]*?\n\);/.exec(schemaSql)?.[0] ?? '';
    const createBefore = createNow.replace(/,\n\s*listings_from_here [^\n]*\n\);$/, '\n);');
    const alter = /`(ALTER TABLE directory_cache ADD COLUMN listings_from_here [^`]+)`/.exec(dbTs)?.[1] ?? '';
    assert(createBefore !== createNow && !createBefore.includes('listings_from_here') && alter !== '',
        'the fixture: schema.sql\'s table without its last column, and db.ts\'s ALTER for it');
    const older = new Database(':memory:');
    older.exec(createBefore);
    older.prepare(`INSERT INTO directory_cache (community_key, listed, name, node_url, first_seen_at, updated_at)
        VALUES ('dir-old', 1, 'Commons dir-old', 'https://dir-old.example.org', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`).run();
    older.prepare(`INSERT INTO directory_cache (community_key, listed, first_seen_at, updated_at)
        VALUES ('dir-old-gone', 0, '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z')`).run();
    older.exec(alter);
    const columnOf = (conn: Database.Database) => conn.prepare(`SELECT type, "notnull" AS required, dflt_value AS dflt FROM pragma_table_info('directory_cache')
        WHERE name = 'listings_from_here'`).get();
    assert(JSON.stringify(columnOf(older)) === JSON.stringify(columnOf(db)) && (columnOf(db) as { required: number }).required === 1,
        `db.ts's ALTER makes the column schema.sql makes, never NULL (${JSON.stringify(columnOf(older))} vs ${JSON.stringify(columnOf(db))})`);
    assert(switchOf(older, 'dir-old') === 1 && switchOf(older, 'dir-old-gone') === 1,
        `the rows from before the column read 1 there (${switchOf(older, 'dir-old')}, ${switchOf(older, 'dir-old-gone')})`);
    const olderDirectory = directoryHash(older);
    const mergedOlder = copiedOnto(older);
    assert(mergedOlder.written === 2 && mergedOlder.invalid === 0, `the standby takes the two rows (${JSON.stringify(mergedOlder)})`);
    assert(directoryHash(db).rows === 2 && directoryHash(db).hash === olderDirectory.hash,
        `a row from before the column: the standby's hash is the main server's (${directoryHash(db).hash.slice(0, 12)} vs ${olderDirectory.hash.slice(0, 12)})`);
    older.close();

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) {
        throw new Error(`${testsRun - testsPassed} check(s) failed`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e?.message || e);
    process.exit(1);
});
