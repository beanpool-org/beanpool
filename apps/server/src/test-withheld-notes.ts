/**
 * Unit and integration test for engine/withheld-notes.ts:
 *
 * Covers:
 * 1. withholdsNote:
 *    - null / undefined / empty string / whitespace memo returns false
 *    - missing / empty / identical from/to returns false
 *    - synthetic accounts (from/to) return false
 *    - non-blocked members return false
 *    - blocked member to blocker returns true (unless treasury account involved)
 *    - treasury accounts (from or to) return false
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

    // Insert test members with required callsign field
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'alice', 0)").run(alice);
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'bob', 0)").run(bob);
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'charlie', 0)").run(charlie);
    db.prepare("INSERT INTO members (public_key, callsign, is_treasury) VALUES (?, 'treasury', 1)").run(treasuryKey);

    // --- 1. withholdsNote checks ---
    console.log('--- Testing withholdsNote ---');

    // Blank / null memo checks
    check(withholdsNote(alice, bob, null) === false, 'null memo returns false');
    check(withholdsNote(alice, bob, undefined) === false, 'undefined memo returns false');
    check(withholdsNote(alice, bob, '') === false, 'empty memo returns false');
    check(withholdsNote(alice, bob, '   ') === false, 'whitespace memo returns false');

    // Account check edge cases
    check(withholdsNote('', bob, 'hello') === false, 'empty from returns false');
    check(withholdsNote(alice, '', 'hello') === false, 'empty to returns false');
    check(withholdsNote(alice, alice, 'hello') === false, 'from === to returns false');
    check(withholdsNote('COMMONS', bob, 'hello') === false, 'synthetic from returns false');
    check(withholdsNote(alice, 'COMMONS', 'hello') === false, 'synthetic to returns false');

    // Bob has NOT blocked Alice yet
    check(withholdsNote(alice, bob, 'hello') === false, 'returns false when recipient has not blocked sender');

    // Bob blocks Alice (owner_pubkey is Bob, blocked_pubkey is Alice)
    db.prepare("INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)").run(bob, alice);

    // Bob has blocked Alice
    check(withholdsNote(alice, bob, 'hello') === true, 'returns true when recipient has blocked sender');
    check(withholdsNote(alice, bob, 123456) === true, 'returns true for numeric memo when recipient has blocked sender');

    // Treasury checks
    check(withholdsNote(treasuryKey, bob, 'hello') === false, 'returns false when sender is treasury key');
    check(withholdsNote(alice, treasuryKey, 'hello') === false, 'returns false when recipient is treasury key');

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

    console.log(`\nPassed ${passedChecks}/${totalChecks} assertions.`);
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
