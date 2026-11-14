/**
 * Test Suite: `engine/replica-hashes.ts` utility functions.
 *
 * Verifies:
 * 1. `readTableHashes` parses raw payload objects, validating version and hash shapes.
 * 2. `tableContentHashes` generates table hashes matching schema definition.
 * 3. `tableContentHashesInSlices` produces identical table hashes incrementally and respects `stopped()`.
 * 4. `compareTableHashes` identifies matching vs differing table counts and hashes between nodes.
 * 5. A standby's copy of the directory cache hashes as the main server's (list-on-global G5, #3152): an unlisted row, and
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
import {
    readTableHashes,
    tableContentHashes,
    tableContentHashesInSlices,
    compareTableHashes,
    TABLE_HASHES_VERSION,
    hashedTables,
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
    // The columns hashed belong to a version. A column added with the version left alone makes two sides on different releases
    // read every whole copy as wrong (#2736, and decisions in af712414 before it). Changed the columns? Raise
    // TABLE_HASHES_VERSION, say why in its notes, and add a line here.
    const hashedColumns = createHash('sha256')
        .update(JSON.stringify(hashedTables(db).map((t) => [t.table, t.columns]).sort()))
        .digest('hex').slice(0, 16);
    const COLUMNS_OF_VERSION: Record<number, string> = { 12: '94ccf348f3c0a4d2', 13: '1eddae5ac2206a8f', 14: '328e536e828a0c8f', 15: 'e000deb40cdb8c0b', 16: '81b5a378f62edbe1', 17: '5b6e068af63cda88', 18: '2866f78fb2b501e0', 19: 'd0a7e99a402c6281', 20: 'ba4952783ffdbd19', 21: '0d5be0f41cf54ef5', 22: '663002c14983ab05', 23: 'ffdbd0746a1a8d42', 24: '873ddd99258062ef', 25: '11af18a2c10c6c53', 26: '39fdfeea1be6782e', 27: '19a2d097427cc373', 28: 'c23b2c7f33899cb6', 29: '45f24e376949a399', 30: 'b0b032ac0fb22adc', 31: 'd18bf1cc914fe840', 32: '86254bafd624e8c2', 33: '80929547e06f7305', 34: '1f5d3b4ae56beede', 35: '4cdd10fa37ef7ae9', 36: '469d04d7f5d63f0d', 37: '56aed40441c90fd2', 38: '7b715bf5e20a6ffc', 39: 'b3b42e582f6591ab', 40: '639e641f370b059b', 41: '3fd4e96288f20d70', 42: '386124d709d189ad' };
    assert(COLUMNS_OF_VERSION[TABLE_HASHES_VERSION] === hashedColumns,
        `the hashed columns belong to version ${TABLE_HASHES_VERSION} (they read ${hashedColumns})`);

    assert(readTableHashes({ v: TABLE_HASHES_VERSION - 1, tables: {} }) === null, 'wrong version returns null');
    assert(readTableHashes({ v: TABLE_HASHES_VERSION, tables: 'invalid' }) === null, 'non-object tables returns null');

    const validHash = 'a'.repeat(64);
    assert(readTableHashes({
        v: TABLE_HASHES_VERSION,
        tables: {
            accounts: { rows: 2, hash: 'invalid-hash' },
        },
    }) === null, 'invalid table hash string causes readTableHashes to return null');

    assert(readTableHashes({
        v: TABLE_HASHES_VERSION,
        tables: {
            accounts: { rows: 'two', hash: validHash },
        },
    }) === null, 'invalid table row count causes readTableHashes to return null');

    const parsed = readTableHashes({
        v: TABLE_HASHES_VERSION,
        tables: {
            accounts: { rows: 2, hash: validHash },
        },
    });

    assert(parsed !== null, 'valid table hashes object returns parsed map');
    assert(parsed?.accounts?.rows === 2 && parsed?.accounts?.hash === validHash, 'valid table entry parsed correctly');

    console.log('\n— 2. tableContentHashes —');
    const syncHashes = tableContentHashes();
    assert(syncHashes.v === TABLE_HASHES_VERSION, 'version matches TABLE_HASHES_VERSION');
    assert(typeof syncHashes.tables.accounts === 'object', 'accounts table hash generated');
    assert(typeof syncHashes.tables.accounts.rows === 'number', 'accounts table row count is numeric');
    assert(/^[0-9a-f]{64}$/.test(syncHashes.tables.accounts.hash), 'accounts table hash is a 64-char hex string');

    const accountsOnly = tableContentHashes({ only: ['accounts'] });
    assert(Object.keys(accountsOnly.tables).length === 1 && 'accounts' in accountsOnly.tables, '`only` option filters to specified tables');

    console.log('\n— 3. tableContentHashesInSlices —');
    const slicedHashes = await tableContentHashesInSlices(
        db,
        { only: ['accounts'] },
        {
            sliceRows: 1,
            sliceBytes: 100,
            pause: async () => {},
            stopped: () => false,
        },
    );

    assert(slicedHashes.v === TABLE_HASHES_VERSION, 'sliced version matches TABLE_HASHES_VERSION');
    assert(slicedHashes.tables.accounts.hash === accountsOnly.tables.accounts.hash, 'sliced hash matches synchronous hash');
    assert(slicedHashes.tables.accounts.rows === accountsOnly.tables.accounts.rows, 'sliced row count matches synchronous count');

    let stoppedErrorCaught = false;
    try {
        await tableContentHashesInSlices(
            db,
            { only: ['accounts'] },
            {
                sliceRows: 1,
                sliceBytes: 100,
                pause: async () => {},
                stopped: () => true,
            },
        );
    } catch (e: any) {
        stoppedErrorCaught = e?.message === 'stopped';
    }
    assert(stoppedErrorCaught, 'tableContentHashesInSlices throws when stopped() returns true');

    console.log('\n— 4. compareTableHashes —');
    const comparison = compareTableHashes({
        accounts: syncHashes.tables.accounts,
        fake_table: { rows: 99, hash: validHash },
    });

    assert(comparison.compared.includes('accounts'), 'accounts table compared');
    assert(!comparison.compared.includes('fake_table'), 'unmatched local table not listed in compared');
    assert(comparison.differing.length === 0, 'matching accounts table reports no differences');

    const mismatchedComparison = compareTableHashes({
        accounts: { rows: syncHashes.tables.accounts.rows + 10, hash: validHash },
    });
    assert(mismatchedComparison.differing.length === 1, 'mismatched rows/hash detected');
    assert(mismatchedComparison.differing[0].table === 'accounts', 'differing table name identified as accounts');
    assert(mismatchedComparison.differing[0].theirRows === syncHashes.tables.accounts.rows + 10, 'theirRows count accurately reported');

    console.log('\n— 5. A standby\'s copy of the directory cache hashes as the main server\'s —');
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
