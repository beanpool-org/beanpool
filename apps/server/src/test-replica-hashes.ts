/**
 * Test Suite: `engine/replica-hashes.ts` utility functions.
 *
 * Verifies:
 * 1. `readTableHashes` parses raw payload objects, validating version and hash shapes.
 * 2. `tableContentHashes` generates table hashes matching schema definition.
 * 3. `tableContentHashesInSlices` produces identical table hashes incrementally and respects `stopped()`.
 * 4. `compareTableHashes` identifies matching vs differing table counts and hashes between nodes.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-replica-hashes.ts
 */

import { createHash } from 'node:crypto';
import { db, initSchema } from './db/db.js';
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
    const COLUMNS_OF_VERSION: Record<number, string> = { 12: '94ccf348f3c0a4d2', 13: '1eddae5ac2206a8f', 14: '328e536e828a0c8f', 15: 'e000deb40cdb8c0b', 16: '81b5a378f62edbe1', 17: '5b6e068af63cda88', 18: '2866f78fb2b501e0', 19: 'd0a7e99a402c6281', 20: 'ba4952783ffdbd19', 21: '0d5be0f41cf54ef5', 22: '663002c14983ab05', 23: 'ffdbd0746a1a8d42', 24: '873ddd99258062ef', 25: '11af18a2c10c6c53', 26: '39fdfeea1be6782e', 27: '19a2d097427cc373', 28: 'c23b2c7f33899cb6', 29: '45f24e376949a399', 30: 'b0b032ac0fb22adc', 31: 'd18bf1cc914fe840' };
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

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) {
        throw new Error(`${testsRun - testsPassed} check(s) failed`);
    }
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e?.message || e);
    process.exit(1);
});
