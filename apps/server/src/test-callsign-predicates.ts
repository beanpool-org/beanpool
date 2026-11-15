/**
 * Callsign status-predicate regression test.
 *
 * `idx_members_callsign_unique` is deliberately partial:
 *
 *     CREATE UNIQUE INDEX ... ON members(lower(callsign)) WHERE status NOT IN ('migrated', 'pruned')
 *
 * db.ts states the rule in one line — "they left, their name is reclaimable" — and migrates
 * old nodes off the narrower predicate on purpose. Every callsign query has to spell the
 * SAME predicate, and getting it wrong fails twice over:
 *
 *   1. WRONG ANSWER. `status != 'migrated'` still matches pruned members, so a name the
 *      index will happily let you take reads as taken.
 *   2. WRONG PLAN. SQLite can only use a partial index when the query's predicate provably
 *      implies the index's. A mismatched one silently degrades to a full table SCAN — on
 *      `/api/members/callsign-available`, which is public and unauthenticated.
 *
 * (The public recovery lookup by name, which this test pinned beside the name check, was deleted with the restore by
 * name, S3: a restore finds its account from a verified sign-in. test-recovery-find pins that the find never offers a
 * member who left or moved to a new key.)
 *
 * This test pins both, because #1 is invisible in a small test DB and #2 is invisible in a
 * correctness assertion. It exists because two sites were missed the first time round.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-callsign-predicates.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTreasury, initStateEngine, isCallsignAvailable } from './state-engine.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function throws(fn: () => void, needle: string, msg: string): void {
    run++;
    try {
        fn();
        console.error(`✗ ${msg} (expected a throw, got none)`);
    } catch (e: any) {
        const hit = String(e?.message || e).includes(needle);
        if (hit) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ ${msg} — threw "${e?.message}" (wanted "${needle}")`);
    }
}

function seedMember(pk: string, callsign: string, status: string) {
    db.prepare(
        `INSERT OR REPLACE INTO members (public_key, callsign, status, joined_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pk, callsign, status);
}

/** The name check compares callsign_fold (db.ts migrateCallsignFold, #1956), answered from its own partial index. */
function usesCallsignIndex(sql: string, param: string): boolean {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(param) as { detail: string }[];
    return plan.some(r => r.detail.includes('idx_members_callsign_fold'));
}

function main() {
    console.log('Running callsign status-predicate test...\n');
    initStateEngine();

    // Three members sharing one name, in the three states that matter. They can coexist
    // precisely BECAUSE the unique index ignores the departed two.
    seedMember('activePK', 'ripple', 'active');
    seedMember('migratedPK', 'ripple', 'migrated');
    seedMember('prunedPK', 'ripple', 'pruned');
    seedMember('goneOnlyPK', 'driftwood', 'pruned');

    // ── 1. The name check counts the living only ──
    // Calls the real function the route calls (isCallsignAvailable, behind /api/members/callsign-available). An earlier
    // draft of this test pasted the SQL in and proved nothing: it passed against the buggy route, because it was querying
    // its own copy of the fixed predicate.
    assert(!isCallsignAvailable('ripple'), 'a name a live member holds is taken, though a migrated and a pruned member share it');
    assert(!isCallsignAvailable('RIPPLE'), '...case-insensitively');
    assert(isCallsignAvailable('driftwood'), 'a name held only by a pruned member is free again');
    assert(isCallsignAvailable('ripple', 'activePK'), 'the live holder re-saving their own name is no collision');

    // ── 2. The name check can still use the partial index ──
    // The correctness assertions above pass on a mismatched predicate too — this is the one
    // that catches the public endpoint quietly degrading to a full scan.
    // The copy below is the real one: the source of isCallsignAvailable is read for it.
    const membersSource = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine/members.ts'), 'utf8');
    assert(membersSource.includes("WHERE callsign_fold = ? AND status NOT IN ('migrated', 'pruned')"),
        'the name check compares callsign_fold with the status predicate below (engine/members.ts)');
    const NAME_CHECK_SQL = `
        SELECT public_key FROM members
        WHERE callsign_fold = ? AND status NOT IN ('migrated', 'pruned')`;
    assert(
        usesCallsignIndex(NAME_CHECK_SQL, 'ripple'),
        'that status predicate reaches members through idx_members_callsign_fold, not a table scan',
    );
    assert(
        !usesCallsignIndex(
            `SELECT 1 FROM members WHERE callsign_fold = ? AND status != 'migrated'`,
            'ripple',
        ),
        'the OLD predicate provably cannot use that index (which is why it cost a full scan)',
    );

    // ── 3. createTreasury agrees with the index that enforces it ──
    // A pruned member's name is reclaimable by design, so the pre-check must not refuse it —
    // it would be rejecting a name the INSERT underneath would have accepted.
    // Guarded: on the old predicate this THROWS, and an uncaught throw would abort the run
    // before the remaining assertions ever reported.
    let treasuryKey = '';
    try {
        treasuryKey = createTreasury('driftwood', 'treasury.png').publicKey;
    } catch (e: any) {
        console.error(`  (createTreasury threw: ${e?.message})`);
    }
    assert(treasuryKey.length > 0, 'a treasury can claim a pruned member\'s callsign');
    const stored = treasuryKey
        ? db.prepare(`SELECT callsign FROM members WHERE public_key = ?`).get(treasuryKey) as { callsign: string } | undefined
        : undefined;
    assert(stored?.callsign === 'driftwood', '...and the name is actually recorded');

    // The guard still guards: a LIVE member's name is taken, and the check is case-insensitive.
    throws(() => createTreasury('ripple', 'treasury.png'), 'already taken', 'a live member\'s callsign is still refused');
    throws(() => createTreasury('RiPPle', 'treasury.png'), 'already taken', '...case-insensitively');

    // And the index — not just the app check — is what makes that true.
    throws(
        () => db.prepare(
            `INSERT INTO members (public_key, callsign, status) VALUES ('dupePK', 'ripple', 'active')`
        ).run(),
        'UNIQUE',
        'the DB itself refuses a second live member on that callsign',
    );

    console.log(`\n${passed}/${run} passed`);
    // Explicit, like every other test here: initStateEngine leaves timers and handles open, so
    // returning normally hangs the runner instead of reporting a pass.
    process.exit(passed === run ? 0 : 1);
}

main();
