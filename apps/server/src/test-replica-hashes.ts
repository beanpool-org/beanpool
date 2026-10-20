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

import { db, initSchema } from './db/db.js';
import {
    readTableHashes,
    tableContentHashes,
    tableContentHashesInSlices,
    compareTableHashes,
    TABLE_HASHES_VERSION,
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
