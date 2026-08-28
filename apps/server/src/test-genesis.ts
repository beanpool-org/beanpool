/**
 * Integration test for genesis initialization in `genesis.ts`.
 *
 * Verifies:
 * 1. Initial genesis creation on first boot (genesis.json & community.key creation, data structure).
 * 2. Subsequent boot loading from existing genesis.json without re-generation.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ensureGenesis } from './genesis.js';

let run = 0;
let passed = 0;
function testAssert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

async function main() {
    console.log('Running Genesis logic integration test...');

    const dataDir = process.env.BEANPOOL_DATA_DIR;
    testAssert(!!dataDir, 'BEANPOOL_DATA_DIR environment variable must be set');
    if (!dataDir) process.exit(1);

    const genesisPath = path.join(dataDir, 'genesis.json');
    const keyPath = path.join(dataDir, 'community.key');

    testAssert(!fs.existsSync(genesisPath), 'genesis.json must not exist before first boot');
    testAssert(!fs.existsSync(keyPath), 'community.key must not exist before first boot');

    // 1. First boot: ensureGenesis generates new genesis block & key
    const state1 = await ensureGenesis();

    testAssert(typeof state1.communityId === 'string' && state1.communityId.length === 16, 'First boot creates 16-char communityId');
    testAssert(typeof state1.publicKey === 'string' && state1.publicKey.length > 0, 'First boot creates publicKey hex');
    testAssert(typeof state1.genesisHash === 'string' && state1.genesisHash.length > 0, 'First boot creates genesisHash');
    testAssert(typeof state1.createdAt === 'string' && !isNaN(Date.parse(state1.createdAt)), 'First boot creates valid createdAt timestamp');

    testAssert(fs.existsSync(genesisPath), 'genesis.json created on first boot');
    testAssert(fs.existsSync(keyPath), 'community.key created on first boot');

    const keyBytes = fs.readFileSync(keyPath);
    testAssert(keyBytes.length > 0, 'community.key is non-empty');

    // 2. Second boot: ensureGenesis loads existing genesis.json
    const state2 = await ensureGenesis();

    testAssert(state2.communityId === state1.communityId, 'Second boot preserves communityId');
    testAssert(state2.publicKey === state1.publicKey, 'Second boot preserves publicKey');
    testAssert(state2.genesisHash === state1.genesisHash, 'Second boot preserves genesisHash');
    testAssert(state2.createdAt === state1.createdAt, 'Second boot preserves createdAt timestamp');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Genesis checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
