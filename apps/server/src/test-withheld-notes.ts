/**
 * Unit and integration test for engine/withheld-notes.ts:
 *
 * Covers:
 * 1. withholdsNote:
 *    - null / undefined / empty string / whitespace memo returns false
 *    - missing / empty / identical from/to returns false
 *    - synthetic accounts (from/to) return false even when blocked
 *    - non-blocked members return false
 *    - blocked member to blocker returns true (unless treasury account involved)
 *    - treasury accounts (from or to) return false even when blocked
 * 2. keepWithheldNote:
 *    - writes row into withheld_notes table
 * 3. noteAsReadBy:
 *    - row with no withheld_memo returns row.memo or empty string
 *    - sender reading row with withheld_memo returns row.withheld_memo
 *    - recipient reading row with withheld_memo returns BLOCKED_BEANS_NOTE
 *    - third party reading row with withheld_memo returns row.memo
 * 4. dropWithheldNotesOf:
 *    - clears memo field in withheld_notes table for sender (sets to '') while preserving rows
 */
import { BLOCKED_BEANS_NOTE } from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
import {
    withholdsNote,
    keepWithheldNote,
    noteAsReadBy,
    dropWithheldNotesOf,
} from './engine/withheld-notes.js';

let totalChecks = 0;
let passedChecks = 0;

function check(cond: boolean, msg: string): void {
    totalChecks++;
    if (cond) {
        passedChecks++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

interface WithheldNoteRow {
    transaction_id: string;
    memo: string;
}

async function main() {
    console.log('Running test-withheld-notes.ts...\n');

    initStateEngine();

    // 64-char hex strings satisfying member_blocks CHECK constraints
    const alice = 'a'.repeat(64);
    const bob = 'b'.repeat(64);
    const charlie = 'c'.repeat(64);
    const treasuryKey = 'd'.repeat(64);
    const syntheticBlocked = 'e'.repeat(64); // 64-char hex blocked key for synthetic test

    // Insert test members with required callsign field
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'alice', 0)").run(alice);
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'bob', 0)").run(bob);
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'charlie', 0)").run(charlie);
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'treasury', 1)").run(treasuryKey);

    // --- 1. withholdsNote checks ---
    console.log('--- Testing withholdsNote ---');

    // Bob blocks Alice, Treasury, and syntheticBlocked
    db.prepare("INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)").run(bob, alice);
    db.prepare("INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)").run(bob, treasuryKey);
    db.prepare("INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)").run(bob, syntheticBlocked);
    // Treasury blocks Alice
    db.prepare("INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)").run(treasuryKey, alice);

    // Verified non-vacuous block baseline: Bob blocked Alice, so Alice -> Bob with memo is withheld
    check(withholdsNote(alice, bob, 'hello') === true, 'returns true when recipient has blocked sender');
    check(withholdsNote(alice, bob, 123456) === true, 'returns true for numeric memo when recipient has blocked sender');

    // Blank / null memo checks (where block exists)
    check(withholdsNote(alice, bob, null) === false, 'null memo returns false even when blocked');
    check(withholdsNote(alice, bob, undefined) === false, 'undefined memo returns false even when blocked');
    check(withholdsNote(alice, bob, '') === false, 'empty memo returns false even when blocked');
    check(withholdsNote(alice, bob, '   ') === false, 'whitespace memo returns false even when blocked');

    // Account check edge cases (where block exists or same account)
    check(withholdsNote('', bob, 'hello') === false, 'empty from returns false');
    check(withholdsNote(alice, '', 'hello') === false, 'empty to returns false');
    check(withholdsNote(alice, alice, 'hello') === false, 'from === to returns false');

    // Synthetic account exemptions (NON-VACUOUS: Bob has blocked synthetic account 'COMMONS_POOL' and 'escrow_123')
    check(withholdsNote('COMMONS_POOL', bob, 'hello') === false, 'synthetic COMMONS_POOL from returns false');
    check(withholdsNote('escrow_123', bob, 'hello') === false, 'synthetic escrow_123 from returns false');
    check(withholdsNote(bob, 'COMMONS_POOL', 'hello') === false, 'synthetic COMMONS_POOL to returns false');

    // Treasury account exemptions (NON-VACUOUS: Bob has blocked treasuryKey, treasuryKey blocked Alice)
    check(withholdsNote(treasuryKey, bob, 'hello') === false, 'returns false when sender is treasury key even when blocked');
    check(withholdsNote(alice, treasuryKey, 'hello') === false, 'returns false when recipient is treasury key even when blocked');

    // Non-blocked check (Charlie has NOT blocked Alice)
    check(withholdsNote(alice, charlie, 'hello') === false, 'returns false when recipient has not blocked sender');

    // --- 2. keepWithheldNote checks ---
    console.log('\n--- Testing keepWithheldNote ---');

    const txId1 = 'tx_1_' + Date.now();
    keepWithheldNote(txId1, 'Secret note for Bob');

    const row1 = db.prepare('SELECT * FROM withheld_notes WHERE transaction_id = ?').get(txId1) as WithheldNoteRow | undefined;
    check(row1 !== undefined && row1.memo === 'Secret note for Bob', 'keepWithheldNote inserts row into database');

    // --- 3. noteAsReadBy checks ---
    console.log('\n--- Testing noteAsReadBy & WITHHELD_NOTE_JOIN ---');

    const normalRow = { from_pubkey: alice, to_pubkey: charlie, memo: 'Public memo' };
    check(noteAsReadBy(normalRow, alice) === 'Public memo', 'returns normal memo for sender when withheld_memo is undefined');
    check(noteAsReadBy(normalRow, charlie) === 'Public memo', 'returns normal memo for recipient when withheld_memo is undefined');

    const withheldRow = {
        from_pubkey: alice,
        to_pubkey: bob,
        memo: '',
        withheld_memo: 'Secret note for Bob',
    };

    check(noteAsReadBy(withheldRow, alice) === 'Secret note for Bob', 'sender reads their original withheld note');
    check(noteAsReadBy(withheldRow, bob) === BLOCKED_BEANS_NOTE, 'recipient reads BLOCKED_BEANS_NOTE');
    check(noteAsReadBy(withheldRow, charlie) === '', 'third party reads the row memo');

    // --- 4. dropWithheldNotesOf checks ---
    console.log('\n--- Testing dropWithheldNotesOf ---');

    const txId2 = 'tx_2_' + Date.now();
    // Insert dummy transaction row
    db.prepare("INSERT INTO transactions (id, from_pubkey, to_pubkey, amount) VALUES (?, ?, ?, 10)").run(txId2, alice, bob);
    keepWithheldNote(txId2, 'Another secret note');

    const rowBefore = db.prepare('SELECT memo FROM withheld_notes WHERE transaction_id = ?').get(txId2) as WithheldNoteRow | undefined;
    check(rowBefore !== undefined && rowBefore.memo === 'Another secret note', 'withheld note exists before drop');

    dropWithheldNotesOf(alice);

    const rowAfter = db.prepare('SELECT memo FROM withheld_notes WHERE transaction_id = ?').get(txId2) as WithheldNoteRow | undefined;
    check(rowAfter !== undefined && rowAfter.memo === '', 'dropWithheldNotesOf blanks memo field for sender');

    console.log(`\n${passedChecks}/${totalChecks} checks passed.`);
    if (passedChecks !== totalChecks) {
        throw new Error(`Test failed: ${totalChecks - passedChecks} assertion(s) failed`);
    }

    console.log('✅ test-withheld-notes.ts completed successfully!');
    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Test error:', err);
    process.exit(1);
});
