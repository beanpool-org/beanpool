/**
 * Unit/integration test for withheld notes engine module (apps/server/src/engine/withheld-notes.ts).
 *
 * Asserts withheld note determination logic (withholdsNote), note persistence (keepWithheldNote),
 * query join/column constants (WITHHELD_NOTE_COLUMN, WITHHELD_NOTE_JOIN), reader view resolution (noteAsReadBy),
 * and sender cleanup (dropWithheldNotesOf).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-withheld-notes.ts
 */

import { BLOCKED_BEANS_NOTE } from '@beanpool/core';
import { db } from './db/db.js';
import { initStateEngine } from './state-engine.js';
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

function main(): void {
    console.log('Running withheld-notes tests...\n');

    initStateEngine();

    const alice = 'a111111111111111111111111111111111111111111111111111111111111111';
    const bob = 'b222222222222222222222222222222222222222222222222222222222222222';
    const charlie = 'c333333333333333333333333333333333333333333333333333333333333333';
    const treasuryKey = 'd444444444444444444444444444444444444444444444444444444444444444';

    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign) VALUES (?, ?)').run(alice, 'alice');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign) VALUES (?, ?)').run(bob, 'bob');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign) VALUES (?, ?)').run(charlie, 'charlie');
    db.prepare('INSERT OR IGNORE INTO members (public_key, callsign, is_treasury) VALUES (?, ?, 1)').run(treasuryKey, 'treasury');

    // 1. withholdsNote checks
    assert(!withholdsNote(alice, bob, null), 'withholdsNote returns false for null memo');
    assert(!withholdsNote(alice, bob, '   '), 'withholdsNote returns false for whitespace memo');
    assert(!withholdsNote(alice, alice, 'Coffee'), 'withholdsNote returns false for self-transfer');
    assert(!withholdsNote('COMMONS_POOL', bob, 'Grant'), 'withholdsNote returns false for synthetic account source');
    assert(!withholdsNote(alice, 'COMMONS_POOL', 'Donation'), 'withholdsNote returns false for synthetic account dest');
    assert(!withholdsNote(alice, bob, 'Coffee'), 'withholdsNote returns false when recipient has not blocked sender');

    // Bob blocks Alice
    const now = new Date().toISOString();
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey, created_at, updated_at) VALUES (?, ?, ?, ?)').run(bob, alice, now, now);

    assert(withholdsNote(alice, bob, 'Coffee'), 'withholdsNote returns true when recipient has blocked sender and valid memo');
    assert(withholdsNote(alice, bob, 12345), 'withholdsNote returns true for numeric memo');
    assert(!withholdsNote(treasuryKey, bob, 'Tax'), 'withholdsNote returns false when sender is treasury');
    assert(!withholdsNote(alice, treasuryKey, 'Tax'), 'withholdsNote returns false when recipient is treasury');

    // 2. keepWithheldNote & DB Persistence
    const txId1 = 'tx_1111111111111111111111111111111111111111111111111111111111111111';
    keepWithheldNote(txId1, 'Secret Coffee Note');

    const txRow = db.prepare('SELECT * FROM withheld_notes WHERE transaction_id = ?').get(txId1) as { memo: string } | undefined;
    assert(txRow?.memo === 'Secret Coffee Note', 'keepWithheldNote stores note in withheld_notes table');

    // 3. WITHHELD_NOTE_COLUMN & WITHHELD_NOTE_JOIN SQL usage
    db.prepare(`
        INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp)
        VALUES (?, ?, ?, 10, 0, '', ?)
    `).run(txId1, alice, bob, new Date().toISOString());

    const joinedRow = db.prepare(`
        SELECT t.*, ${WITHHELD_NOTE_COLUMN}
        FROM transactions t
        ${WITHHELD_NOTE_JOIN}
        WHERE t.id = ?
    `).get(txId1) as { from_pubkey: string; to_pubkey: string; memo: string | null; withheld_memo?: string | null } | undefined;

    assert(joinedRow?.withheld_memo === 'Secret Coffee Note', 'WITHHELD_NOTE_JOIN fetches withheld note memo');

    // 4. noteAsReadBy resolution
    const normalRow = { from_pubkey: alice, to_pubkey: charlie, memo: 'Public Note', withheld_memo: null };
    assert(noteAsReadBy(normalRow, alice) === 'Public Note', 'noteAsReadBy returns row.memo when withheld_memo is null');

    const withheldRow = { from_pubkey: alice, to_pubkey: bob, memo: '', withheld_memo: 'Secret Coffee Note' };
    assert(noteAsReadBy(withheldRow, alice) === 'Secret Coffee Note', 'noteAsReadBy returns withheld_memo for sender');
    assert(noteAsReadBy(withheldRow, bob) === BLOCKED_BEANS_NOTE, 'noteAsReadBy returns BLOCKED_BEANS_NOTE for recipient');
    assert(noteAsReadBy(withheldRow, charlie) === '', 'noteAsReadBy returns row.memo for third party');

    // 5. dropWithheldNotesOf sender cleanup
    dropWithheldNotesOf(alice);
    const cleanedRow = db.prepare('SELECT memo FROM withheld_notes WHERE transaction_id = ?').get(txId1) as { memo: string } | undefined;
    assert(cleanedRow?.memo === '', 'dropWithheldNotesOf resets withheld note memo to empty string');

    // Post-cleanup noteAsReadBy check
    const postCleanupRow = { from_pubkey: alice, to_pubkey: bob, memo: '', withheld_memo: '' };
    assert(noteAsReadBy(postCleanupRow, bob) === BLOCKED_BEANS_NOTE, 'noteAsReadBy still returns BLOCKED_BEANS_NOTE after sender drop');

    console.log(`\n${passed}/${run} checks passed.`);
    process.exit(process.exitCode ?? 0);
}

main();
