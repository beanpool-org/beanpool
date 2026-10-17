/**
 * Unit and integration tests for `apps/server/src/break-glass-code.ts`:
 *
 *   1. generateBreakGlassCode & isBreakGlassCodeShape: validates formatting, case-insensitivity, and shape checks.
 *   2. hashBreakGlassCode & isLegacyBreakGlassHash: validates scrypt hashing format and SHA-256 legacy hash identification.
 *   3. breakGlassCodeMatches: validates match outcomes ('match', 'legacy', 'no') for both modern scrypt and legacy SHA-256 hashes,
 *      as well as error handling for invalid/malformed inputs.
 *   4. upgradeBreakGlassHashes: validates SQLite database migration of legacy SHA-256 break glass hashes to scrypt format in
 *      node_roles and suspended_node_roles tables.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-break-glass-code.ts
 */

import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {
    generateBreakGlassCode,
    isBreakGlassCodeShape,
    hashBreakGlassCode,
    isLegacyBreakGlassHash,
    breakGlassCodeMatches,
    upgradeBreakGlassHashes,
} from './break-glass-code.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
        process.exitCode = 1;
    }
}

async function main(): Promise<void> {
    console.log('=== Testing apps/server/src/break-glass-code.ts ===');

    // 1. generateBreakGlassCode & isBreakGlassCodeShape
    console.log('\n— 1. generateBreakGlassCode & isBreakGlassCodeShape —');
    const code1 = generateBreakGlassCode();
    const code2 = generateBreakGlassCode();
    assert(/^bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/.test(code1), `generated code1 has correct shape (${code1})`);
    assert(code1 !== code2, 'successive calls generate distinct codes');
    assert(isBreakGlassCodeShape(code1), 'isBreakGlassCodeShape accepts generated code');
    assert(isBreakGlassCodeShape(`  ${code1.toUpperCase()}  `), 'isBreakGlassCodeShape trims whitespace and normalizes case');

    const badShapes = [
        null,
        undefined,
        12345,
        {},
        '',
        'bg-1234-5678-9012',
        'bg-1234-5678-9012-34567',
        'bg-1234-5678-9012-345g',
        'claim-1234-5678-9012-3456',
        'bg1234567890123456',
    ];
    for (const bad of badShapes) {
        assert(!isBreakGlassCodeShape(bad), `isBreakGlassCodeShape rejects invalid shape: ${JSON.stringify(bad)}`);
    }

    // 2. hashBreakGlassCode & isLegacyBreakGlassHash
    console.log('\n— 2. hashBreakGlassCode & isLegacyBreakGlassHash —');
    const hashed1 = hashBreakGlassCode(code1);
    const hashed2 = hashBreakGlassCode(code1);
    assert(hashed1.startsWith('scrypt$'), 'hashBreakGlassCode produces scrypt$ prefixed hash');
    assert(hashed1 !== hashed2, 'hashBreakGlassCode uses a fresh salt per invocation');
    assert(!isLegacyBreakGlassHash(hashed1), 'scrypt hash is not identified as legacy hash');

    const legacyDigest = crypto.createHash('sha256').update(code1).digest('hex');
    assert(legacyDigest.length === 64, 'legacy SHA-256 digest is 64 hex chars');
    assert(isLegacyBreakGlassHash(legacyDigest), '64 hex char string is identified as legacy hash');

    const nonLegacyInputs = [
        null,
        undefined,
        123,
        hashed1,
        'a'.repeat(63),
        'a'.repeat(65),
        'z'.repeat(64), // not hex
    ];
    for (const nonLegacy of nonLegacyInputs) {
        assert(!isLegacyBreakGlassHash(nonLegacy), `isLegacyBreakGlassHash rejects non-legacy input: ${JSON.stringify(nonLegacy)}`);
    }

    // 3. breakGlassCodeMatches
    console.log('\n— 3. breakGlassCodeMatches —');
    // Valid code matching modern scrypt hash
    const matchResult = await breakGlassCodeMatches(code1, hashed1);
    assert(matchResult === 'match', 'returns "match" for valid code against scrypt hash');

    // Valid code matching legacy SHA-256 hash
    const legacyResult = await breakGlassCodeMatches(code1, legacyDigest);
    assert(legacyResult === 'legacy', 'returns "legacy" for valid code against legacy SHA-256 hash');

    // Wrong code matching scrypt hash
    const wrongScryptResult = await breakGlassCodeMatches(code2, hashed1);
    assert(wrongScryptResult === 'no', 'returns "no" for wrong code against scrypt hash');

    // Wrong code matching legacy hash
    const wrongLegacyResult = await breakGlassCodeMatches(code2, legacyDigest);
    assert(wrongLegacyResult === 'no', 'returns "no" for wrong code against legacy hash');

    // Invalid code shape or stored values
    assert((await breakGlassCodeMatches('not-a-code', hashed1)) === 'no', 'returns "no" for invalid code shape');
    assert((await breakGlassCodeMatches(code1, null as any)) === 'no', 'returns "no" for null stored value');
    assert((await breakGlassCodeMatches(code1, 'scrypt$invalidformat')) === 'no', 'returns "no" for malformed scrypt stored value');
    assert((await breakGlassCodeMatches(code1, 'scrypt$salt$nothex!')) === 'no', 'returns "no" for non-hex hash in scrypt value');

    // 4. upgradeBreakGlassHashes
    console.log('\n— 4. upgradeBreakGlassHashes —');
    const db = new Database(':memory:');

    db.exec(`
        CREATE TABLE node_roles (
            member_pubkey TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            break_glass_hash TEXT
        );
        CREATE TABLE suspended_node_roles (
            member_pubkey TEXT PRIMARY KEY,
            role TEXT NOT NULL,
            break_glass_hash TEXT
        );
    `);

    const codeActive = generateBreakGlassCode();
    const activeLegacyHash = crypto.createHash('sha256').update(codeActive).digest('hex');

    const codeSuspended = generateBreakGlassCode();
    const suspendedLegacyHash = crypto.createHash('sha256').update(codeSuspended).digest('hex');

    const codeAlreadyScrypt = generateBreakGlassCode();
    const activeScryptHash = hashBreakGlassCode(codeAlreadyScrypt);

    // Populate node_roles
    db.prepare('INSERT INTO node_roles (member_pubkey, role, break_glass_hash) VALUES (?, ?, ?)').run('pk1', 'owner', activeLegacyHash);
    db.prepare('INSERT INTO node_roles (member_pubkey, role, break_glass_hash) VALUES (?, ?, ?)').run('pk2', 'owner', activeScryptHash);
    db.prepare('INSERT INTO node_roles (member_pubkey, role, break_glass_hash) VALUES (?, ?, ?)').run('pk3', 'owner', null);

    // Populate suspended_node_roles
    db.prepare('INSERT INTO suspended_node_roles (member_pubkey, role, break_glass_hash) VALUES (?, ?, ?)').run('pk4', 'owner', suspendedLegacyHash);

    // Upgrade with suspendedToo: false
    const upgradedCount1 = upgradeBreakGlassHashes(db, { suspendedToo: false });
    assert(upgradedCount1 === 1, 'upgraded 1 row in node_roles when suspendedToo is false');

    const pk1Row1 = db.prepare('SELECT break_glass_hash FROM node_roles WHERE member_pubkey = ?').get('pk1') as { break_glass_hash: string };
    assert(pk1Row1.break_glass_hash.startsWith('scrypt$'), 'pk1 row in node_roles was upgraded to scrypt format');
    assert((await breakGlassCodeMatches(codeActive, pk1Row1.break_glass_hash)) === 'match', 'upgraded scrypt hash matches codeActive');

    const pk2Row1 = db.prepare('SELECT break_glass_hash FROM node_roles WHERE member_pubkey = ?').get('pk2') as { break_glass_hash: string };
    assert(pk2Row1.break_glass_hash === activeScryptHash, 'already scrypt row in node_roles was left unchanged');

    const pk4Row1 = db.prepare('SELECT break_glass_hash FROM suspended_node_roles WHERE member_pubkey = ?').get('pk4') as { break_glass_hash: string };
    assert(pk4Row1.break_glass_hash === suspendedLegacyHash, 'suspended_node_roles row was skipped when suspendedToo is false');

    // Upgrade with suspendedToo: true
    const upgradedCount2 = upgradeBreakGlassHashes(db, { suspendedToo: true });
    assert(upgradedCount2 === 1, 'upgraded 1 row in suspended_node_roles when suspendedToo is true');

    const pk4Row2 = db.prepare('SELECT break_glass_hash FROM suspended_node_roles WHERE member_pubkey = ?').get('pk4') as { break_glass_hash: string };
    assert(pk4Row2.break_glass_hash.startsWith('scrypt$'), 'suspended_node_roles row was upgraded to scrypt format');
    assert((await breakGlassCodeMatches(codeSuspended, pk4Row2.break_glass_hash)) === 'match', 'upgraded suspended scrypt hash matches codeSuspended');

    // Subsequent upgrade call should upgrade 0 rows
    const upgradedCount3 = upgradeBreakGlassHashes(db, { suspendedToo: true });
    assert(upgradedCount3 === 0, 'subsequent upgrade call finds 0 legacy rows to upgrade');

    db.close();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
}

main().then(() => {
    process.exit(0);
}).catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
});
