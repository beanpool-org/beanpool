/**
 * Unit/integration tests for withheld notes engine module (apps/server/src/engine/withheld-notes.ts).
 *
 * Asserts note withholding decision logic, storage of withheld notes, reader perspective
 * behavior (sender vs recipient vs third party), clearing withheld notes on account drop/purge,
 * and SQL join/column constants.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-withheld-notes.ts
 */

import { BLOCKED_BEANS_NOTE } from '@beanpool/core';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import {
    withholdsNote,
    keepWithheldNote,
    noteAsReadBy,
    dropWithheldNotesOf,
    WITHHELD_NOTE_COLUMN,
    WITHHELD_NOTE_JOIN,
} from './engine/withheld-notes.js';

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
    console.log('Running withheld-notes tests...\n');

    initStateEngine();

    const alice = '1111111111111111111111111111111111111111111111111111111111111111';
    const bob = '2222222222222222222222222222222222222222222222222222222222222222';
    const charlie = '3333333333333333333333333333333333333333333333333333333333333333';
    const treasuryKey = '4444444444444444444444444444444444444444444444444444444444444444';

    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign, is_treasury) VALUES (?, ?, 0)').run(alice, 'alice');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign, is_treasury) VALUES (?, ?, 0)').run(bob, 'bob');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign, is_treasury) VALUES (?, ?, 0)').run(charlie, 'charlie');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign, is_treasury) VALUES (?, ?, 1)').run(treasuryKey, 'shop_treasury');

    // 1. SQL Constants check
    assert(WITHHELD_NOTE_COLUMN === 'wn.memo AS withheld_memo', 'WITHHELD_NOTE_COLUMN selects wn.memo AS withheld_memo');
    assert(WITHHELD_NOTE_JOIN === 'LEFT JOIN withheld_notes wn ON wn.transaction_id = t.id', 'WITHHELD_NOTE_JOIN defines correct LEFT JOIN');

    // 2. withholdsNote decision logic
    assert(withholdsNote(alice, bob, null) === false, 'withholdsNote returns false for null memo');
    assert(withholdsNote(alice, bob, '') === false, 'withholdsNote returns false for empty string memo');
    assert(withholdsNote(alice, bob, '   ') === false, 'withholdsNote returns false for whitespace memo');

    assert(withholdsNote('', bob, 'hello') === false, 'withholdsNote returns false when from is empty');
    assert(withholdsNote(alice, '', 'hello') === false, 'withholdsNote returns false when to is empty');
    assert(withholdsNote(alice, alice, 'hello') === false, 'withholdsNote returns false when sender and recipient are the same');

    assert(withholdsNote('genesis', bob, 'hello') === false, 'withholdsNote returns false for synthetic account "genesis"');
    assert(withholdsNote(alice, 'genesis', 'hello') === false, 'withholdsNote returns false to synthetic account "genesis"');

    // Without a block in place
    assert(withholdsNote(alice, bob, 'unblocked memo') === false, 'withholdsNote returns false when recipient has not blocked sender');

    // Add block: Bob blocks Alice (owner_pubkey = Bob, blocked_pubkey = Alice)
    const now = new Date().toISOString();
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)').run(bob, alice, now, now);

    assert(withholdsNote(alice, bob, 'secret memo') === true, 'withholdsNote returns true when recipient (Bob) blocked sender (Alice)');
    assert(withholdsNote(alice, bob, 12345) === true, 'withholdsNote returns true for numeric memo when blocked');
    assert(withholdsNote(bob, alice, 'hello') === false, 'withholdsNote returns false when sender (Bob) sends to blocked person (Alice)');

    // Treasury accounts are exempt from withholding notes
    assert(withholdsNote(treasuryKey, bob, 'treasury note') === false, 'withholdsNote returns false when sender is a treasury');
    assert(withholdsNote(alice, treasuryKey, 'to treasury') === false, 'withholdsNote returns false when recipient is a treasury');

    // 3. keepWithheldNote storage
    const txId1 = 'tx_1111111111111111111111111111111111111111111111111111111111111111';
    keepWithheldNote(txId1, 'secret memo for tx1');

    const storedRow = db.prepare('SELECT * FROM withheld_notes WHERE transaction_id = ?').get(txId1) as { transaction_id: string; memo: string } | undefined;
    assert(storedRow !== undefined && storedRow.memo === 'secret memo for tx1', 'keepWithheldNote stores note in withheld_notes table');

    // 4. noteAsReadBy reader perspectives
    const rowWithoutWithheld = {
        from_pubkey: alice,
        to_pubkey: charlie,
        memo: 'public note',
        withheld_memo: null,
    };
    assert(noteAsReadBy(rowWithoutWithheld, alice) === 'public note', 'noteAsReadBy returns original memo if withheld_memo is null');
    assert(noteAsReadBy(rowWithoutWithheld, charlie) === 'public note', 'noteAsReadBy returns original memo to recipient when withheld_memo is null');

    const rowWithWithheld = {
        from_pubkey: alice,
        to_pubkey: bob,
        memo: '',
        withheld_memo: 'secret memo for tx1',
    };
    assert(noteAsReadBy(rowWithWithheld, alice) === 'secret memo for tx1', 'noteAsReadBy returns withheld_memo to sender');
    assert(noteAsReadBy(rowWithWithheld, bob) === BLOCKED_BEANS_NOTE, 'noteAsReadBy returns BLOCKED_BEANS_NOTE to recipient');
    assert(noteAsReadBy(rowWithWithheld, charlie) === '', 'noteAsReadBy returns row.memo ("") to third parties');

    // 5. dropWithheldNotesOf (account prune / self-deletion)
    const txId2 = 'tx_2222222222222222222222222222222222222222222222222222222222222222';
    // Insert dummy transaction for alice
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp)
                VALUES (?, ?, ?, 10, 0, '', ?)`).run(txId1, alice, bob, new Date().toISOString());
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp)
                VALUES (?, ?, ?, 10, 0, '', ?)`).run(txId2, charlie, bob, new Date().toISOString());
    keepWithheldNote(txId2, 'charlie secret memo');

    dropWithheldNotesOf(alice);

    const aliceNoteAfterDrop = db.prepare('SELECT memo FROM withheld_notes WHERE transaction_id = ?').get(txId1) as { memo: string } | undefined;
    const charlieNoteAfterDrop = db.prepare('SELECT memo FROM withheld_notes WHERE transaction_id = ?').get(txId2) as { memo: string } | undefined;

    assert(aliceNoteAfterDrop?.memo === '', 'dropWithheldNotesOf clears withheld memo to empty string for sender');
    assert(charlieNoteAfterDrop?.memo === 'charlie secret memo', 'dropWithheldNotesOf leaves other senders withheld notes intact');

    console.log(`\n${passed}/${run} withheld-notes checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main();
