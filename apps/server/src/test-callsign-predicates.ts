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
 *      index will happily let you take reads as taken, and a member the node has let go
 *      still shows up as a live recovery target.
 *   2. WRONG PLAN. SQLite can only use a partial index when the query's predicate provably
 *      implies the index's. A mismatched one silently degrades to a full table SCAN — on
 *      `/api/recovery/lookup`, which is public and unauthenticated.
 *
 * This test pins both, because #1 is invisible in a small test DB and #2 is invisible in a
 * correctness assertion. It exists because two sites were missed the first time round.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-callsign-predicates.ts
 */
import { createTreasury, findRecoveryCandidates, initStateEngine } from './state-engine.js';
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

function seedMember(pk: string, callsign: string, status: string, guardians = 0) {
    db.prepare(
        `INSERT OR REPLACE INTO members (public_key, callsign, avatar_url, status, joined_at)
         VALUES (?, ?, 'a.png', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pk, callsign, status);
    for (let i = 0; i < guardians; i++) {
        db.prepare(
            `INSERT OR REPLACE INTO friends (owner_pubkey, friend_pubkey, is_guardian) VALUES (?, ?, 1)`
        ).run(pk, `${pk}-guardian-${i}`);
    }
}

function usesCallsignIndex(sql: string, param: string): boolean {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(param) as { detail: string }[];
    return plan.some(r => r.detail.includes('idx_members_callsign_unique'));
}

function main() {
    console.log('Running callsign status-predicate test...\n');
    initStateEngine();

    // Three members sharing one name, in the three states that matter. They can coexist
    // precisely BECAUSE the unique index ignores the departed two.
    seedMember('activePK', 'ripple', 'active', 3);
    seedMember('migratedPK', 'ripple', 'migrated', 3);
    seedMember('prunedPK', 'ripple', 'pruned', 3);
    seedMember('goneOnlyPK', 'driftwood', 'pruned', 3);

    // ── 1. Recovery lookup returns the living only ──
    // Calls the real function the route calls. An earlier draft of this test pasted the SQL
    // in and proved nothing: it passed against the buggy route, because it was querying its
    // own copy of the fixed predicate.
    const hits = findRecoveryCandidates('ripple');
    assert(hits.length === 1, 'recovery lookup returns exactly one member for a shared callsign');
    assert(hits[0]?.publicKey === 'activePK', '...and it is the active one');

    const keys = hits.map(h => h.publicKey);
    assert(!keys.includes('prunedPK'), 'a PRUNED member is not offered as a recovery target');
    assert(!keys.includes('migratedPK'), 'a migrated member is not offered as a recovery target');

    assert(findRecoveryCandidates('driftwood').length === 0, 'a callsign held only by a pruned member resolves to nobody');
    assert(findRecoveryCandidates('RIPPLE').length === 1, 'the lookup is case-insensitive');

    // Prefix matching is the whole point of the change: a member given `paul12` because `paul` was
    // taken will type `paul` months later, and an exact match answers "nobody", which reads as
    // "your account is gone" rather than "try harder".
    assert(findRecoveryCandidates('ripp').length >= 1, 'a prefix finds the account whose full callsign the member has forgotten');
    assert(findRecoveryCandidates('rippleX').length === 0, 'a prefix that matches nobody still returns nobody');

    // A LIKE wildcard bound straight in would let an unauthenticated caller enumerate the node,
    // which is exactly what the rate limit on this route exists to bound.
    assert(findRecoveryCandidates('%').length === 0, 'a bare % is a literal, not a wildcard');
    assert(findRecoveryCandidates('_').length === 0, 'a bare _ is a literal, not a wildcard');
    assert(findRecoveryCandidates('rip%').length === 0, 'a trailing % does not widen the match');

    // The response must stay public-safe: this endpoint is unauthenticated.
    //
    // Widened deliberately to six. The two additions are BOOLEANS — whether guardian recovery and
    // whether sign-in recovery are possible — and they exist so the picker can offer only the
    // routes that will actually work; a member who taps a provider they never enrolled gets a dead
    // end and reads it as their account being gone.
    //
    // What must NOT appear here is which provider. That an account is recoverable is a far weaker
    // fact than that a named person uses Google, and this endpoint hands its answer to anyone who
    // can guess a callsign. Note also that the old shape already leaked the guardian fact by
    // presence — an account only appeared at all once it had enough guardians.
    assert(
        Object.keys(hits[0] ?? {}).sort().join(',')
            === 'avatarUrl,callsign,canRecoverByGuardians,canRecoverBySso,joinedAt,publicKey',
        'the candidate exposes exactly the six public fields and nothing else',
    );

    // ── 2. The lookup can still use the partial index ──
    // The correctness assertions above pass on a mismatched predicate too — this is the one
    // that catches the public endpoint quietly degrading to a full scan.
    const LOOKUP_SQL = `
        SELECT public_key FROM members
        WHERE lower(callsign) = ? AND status NOT IN ('migrated', 'pruned')`;
    assert(
        usesCallsignIndex(LOOKUP_SQL, 'ripple'),
        'that status predicate reaches members through idx_members_callsign_unique, not a table scan',
    );
    assert(
        !usesCallsignIndex(
            `SELECT 1 FROM members WHERE lower(callsign) = ? AND status != 'migrated'`,
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
