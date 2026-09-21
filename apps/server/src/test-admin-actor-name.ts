/**
 * Unit/integration tests for adminActorName utility (apps/server/src/engine/admin-actor-name.ts).
 *
 * Asserts proper resolution of admin signer public keys to human-readable member callsigns
 * or fallback to "a community admin".
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-admin-actor-name.ts
 */

import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { adminActorName, COMMUNITY_ADMIN } from './engine/admin-actor-name.js';

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

function main() {
    console.log('Running adminActorName tests...\n');

    // Initialize state engine to set up SQLite schema (including members table)
    initStateEngine();

    // 1. Invalid input types and empty/malformed signers
    assert(adminActorName(null) === COMMUNITY_ADMIN, 'null signer returns default fallback');
    assert(adminActorName(undefined) === COMMUNITY_ADMIN, 'undefined signer returns default fallback');
    assert(adminActorName('') === COMMUNITY_ADMIN, 'empty string signer returns default fallback');
    assert(adminActorName('   ') === COMMUNITY_ADMIN, 'whitespace signer returns default fallback');
    assert(adminActorName('invalid-pubkey') === COMMUNITY_ADMIN, 'non-hex signer returns default fallback');
    assert(adminActorName('12345') === COMMUNITY_ADMIN, 'short hex signer returns default fallback');

    const validPk1 = 'a'.repeat(64);
    const validPk2 = 'B'.repeat(64);
    const validPk3 = 'c'.repeat(64);
    const validPk4 = 'd'.repeat(64);

    // 2. Pubkey not present in database
    assert(adminActorName(validPk1) === COMMUNITY_ADMIN, 'unregistered pubkey returns default fallback');

    // 3. Member with empty or whitespace callsign
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'unknown', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(validPk1);
    db.prepare(`UPDATE members SET callsign = '' WHERE public_key = ?`).run(validPk1);

    assert(adminActorName(validPk1) === COMMUNITY_ADMIN, 'member with empty callsign returns default fallback');

    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, '   ', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(validPk2);

    assert(adminActorName(validPk2) === COMMUNITY_ADMIN, 'member with whitespace callsign returns default fallback');

    // 4. Member whose callsign looks like a hex public key
    const hexLikeCallsign = 'e'.repeat(64);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(validPk3, hexLikeCallsign);

    assert(adminActorName(validPk3) === COMMUNITY_ADMIN, 'member with key-like callsign returns default fallback');

    // 5. Valid member with proper callsign (case-insensitive pubkey lookup and untrimmed callsign)
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(validPk4, '  alice_admin  ');

    assert(adminActorName(validPk4) === 'alice_admin', 'valid member callsign is trimmed and returned');
    assert(adminActorName(` ${validPk4.toUpperCase()} `) === 'alice_admin', 'lookup works with uppercase/padded pubkey');

    console.log(`\n${passed}/${run} adminActorName tests passed.`);
    process.exit(process.exitCode ?? 0);
}

main();
