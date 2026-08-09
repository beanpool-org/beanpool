/**
 * Keyholder fragment storage — generation semantics regression test.
 *
 * Proves:
 *   1. An initial split stores a whole generation and reports it as generation 1.
 *   2. A re-split bumps the generation and DROPS the previous one, so a member never has two
 *      half-generations and collection can never mix them.
 *   3. Every read is scoped to the current generation — including the SSO lookup, which reaches
 *      the table by hash rather than by owner and is the easiest one to get wrong.
 *   4. A removed keeper's fragment is gone after the re-split that removes them.
 *   5. Batches that could never be recombined are refused on the way in: too few fragments,
 *      duplicate keepers, colliding x-coordinates, unusable keeper material.
 *   6. `listKeeperTypes` exposes types and counts and never an identity.
 *   7. Removal is refused when it would take the member to the threshold floor.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-shares.ts
 */
import { RECOVERY_THRESHOLD } from '@beanpool/core';
import {
    canRemoveKeeper,
    countCurrentShares,
    deleteAllShares,
    findShareBySsoLookup,
    getCurrentGeneration,
    getCurrentShares,
    getShareForHolder,
    listKeeperTypes,
    putShareGeneration,
    type KeeperShareInput,
} from './engine/recovery-shares.js';
import { initStateEngine } from './state-engine.js';
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

function seedMember(pk: string) {
    db.prepare(
        `INSERT OR IGNORE INTO members (public_key, callsign, avatar_url, joined_at)
         VALUES (?, ?, 'a.png', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(pk, pk.slice(0, 8));
}

/** A fragment with sane defaults, so each test only states what it actually cares about. */
function share(over: Partial<KeeperShareInput> & Pick<KeeperShareInput, 'holderType' | 'holderRef' | 'shareIndex'>): KeeperShareInput {
    return {
        // K1 is recorded, never uploaded — the phone keeps its own bytes (see putShareGeneration).
        encryptedShare: over.holderType === 'device' ? '' : `ct-${over.holderType}-${over.holderRef}`,
        shareIv: over.holderType === 'device' ? '' : 'iv',
        shareTag: over.holderType === 'device' ? '' : 'tag',
        ephemeralPubkey: over.holderType === 'member' ? 'eph-x25519' : null,
        ssoLookupHash: over.holderType === 'sso' ? `hash-${over.holderRef}` : null,
        ssoLookupSalt: over.holderType === 'sso' ? 'salt' : null,
        kdfParams: null,
        ...over,
    };
}

/** The shape at signup: phone, hub, inviter — exactly the threshold. */
function baseTrio(inviter = 'inviterPK'): KeeperShareInput[] {
    return [
        share({ holderType: 'device', holderRef: 'self', shareIndex: 11 }),
        share({ holderType: 'hub', holderRef: 'self', shareIndex: 22 }),
        share({ holderType: 'member', holderRef: inviter, shareIndex: 33 }),
    ];
}

function main() {
    console.log('Running keyholder fragment storage test...\n');
    initStateEngine();

    seedMember('ownerPK');
    seedMember('inviterPK');
    seedMember('buddyPK');

    // ── 1. Initial split ──
    assert(getCurrentGeneration('ownerPK') === 0, 'a member with no split reports generation 0');
    assert(getCurrentShares('ownerPK').length === 0, '...and has no fragments');
    assert(listKeeperTypes('ownerPK').length === 0, '...and no keeper types');

    const gen1 = putShareGeneration('ownerPK', baseTrio());
    assert(gen1 === 1, 'the first split is generation 1');
    assert(getCurrentGeneration('ownerPK') === 1, 'the current generation reads back as 1');
    assert(countCurrentShares('ownerPK') === 3, 'all three fragments were stored');

    // ── 2. Re-split replaces, never accumulates ──
    const withBuddy = [...baseTrio(), share({ holderType: 'member', holderRef: 'buddyPK', shareIndex: 44 })];
    const gen2 = putShareGeneration('ownerPK', withBuddy);
    assert(gen2 === 2, 'adding a keeper bumps the generation');
    assert(countCurrentShares('ownerPK') === 4, 'the new generation has four fragments');

    const total = db.prepare('SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ?')
        .get('ownerPK') as { n: number };
    assert(total.n === 4, 'the previous generation was DROPPED, not kept alongside');
    assert(
        getCurrentShares('ownerPK').every(s => s.generation === 2),
        'every fragment returned belongs to the current generation',
    );

    // ── 3. Reads are generation-scoped ──
    assert(getShareForHolder('ownerPK', 'member', 'buddyPK') !== null, 'a current keeper can be found');
    const staleLookup = db.prepare(
        `SELECT COUNT(*) AS n FROM recovery_shares WHERE owner_pubkey = ? AND generation = 1`
    ).get('ownerPK') as { n: number };
    assert(staleLookup.n === 0, 'nothing from generation 1 survives to be served');

    // ── 4. Removing a keeper ──
    const gen3 = putShareGeneration('ownerPK', baseTrio());
    assert(gen3 === 3, 'removing a keeper is just another re-split');
    assert(
        getShareForHolder('ownerPK', 'member', 'buddyPK') === null,
        'the removed keeper\'s fragment is gone from the current generation',
    );
    assert(countCurrentShares('ownerPK') === 3, 'the member is back to three fragments');

    // ── 5. Removal guard ──
    assert(canRemoveKeeper('ownerPK') === false, 'cannot remove a keeper while at the threshold floor');
    putShareGeneration('ownerPK', withBuddy);
    assert(canRemoveKeeper('ownerPK') === true, '...but can once there is one to spare');

    // ── 6. SSO lookup by hash, scoped to the current generation ──
    seedMember('ssoOwnerPK');
    const withSso = [
        ...baseTrio(),
        share({ holderType: 'sso', holderRef: 'facebook', shareIndex: 55, ssoLookupHash: 'sso-hash-v1' }),
    ];
    putShareGeneration('ssoOwnerPK', withSso);
    const found = findShareBySsoLookup('sso-hash-v1');
    assert(found !== null && found.ownerPubkey === 'ssoOwnerPK', 'a sign-in fragment is findable by its lookup hash');
    assert(found?.holderType === 'sso', '...and comes back as a sign-in fragment');

    // Re-split with a different hash: the old hash must stop resolving. This is the read most
    // likely to leak across generations, because it finds a row without ever naming an owner.
    const withNewSso = [
        ...baseTrio(),
        share({ holderType: 'sso', holderRef: 'facebook', shareIndex: 66, ssoLookupHash: 'sso-hash-v2' }),
    ];
    putShareGeneration('ssoOwnerPK', withNewSso);
    assert(findShareBySsoLookup('sso-hash-v1') === null, 'a superseded sign-in hash no longer resolves');
    assert(findShareBySsoLookup('sso-hash-v2') !== null, '...and the current one does');

    // ── 7. Batches that could never be recombined are refused ──
    seedMember('rejectPK');
    throws(
        () => putShareGeneration('rejectPK', baseTrio().slice(0, RECOVERY_THRESHOLD - 1)),
        'at least 3 fragments',
        'refuses a batch below the threshold',
    );
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 1 }),
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 2 }),
            share({ holderType: 'hub', holderRef: 'self', shareIndex: 3 }),
        ]),
        'Duplicate keeper',
        'refuses the same keeper twice in one generation',
    );
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'device', holderRef: 'self', shareIndex: 7 }),
            share({ holderType: 'hub', holderRef: 'self', shareIndex: 7 }),
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 9 }),
        ]),
        'x-coordinate',
        'refuses two fragments at the same x-coordinate (a 3-set that is really a 2-set)',
    );
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'device', holderRef: 'self', shareIndex: 0 }),
            share({ holderType: 'hub', holderRef: 'self', shareIndex: 2 }),
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 3 }),
        ]),
        'out-of-range share index',
        'refuses x-coordinate 0, which Shamir cannot evaluate',
    );
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'device', holderRef: 'self', shareIndex: 1 }),
            share({ holderType: 'hub', holderRef: 'self', shareIndex: 2 }),
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 3, ephemeralPubkey: null }),
        ]),
        'no ephemeral public key',
        'refuses a member fragment its keeper could never unwrap',
    );
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'device', holderRef: 'self', shareIndex: 1 }),
            share({ holderType: 'hub', holderRef: 'self', shareIndex: 2 }),
            share({ holderType: 'sso', holderRef: 'google', shareIndex: 3, ssoLookupHash: null }),
        ]),
        'sso_lookup_hash',
        'refuses a sign-in fragment nothing could ever find',
    );
    assert(getCurrentGeneration('rejectPK') === 0, 'no rejected batch left a partial write behind');

    // ── 7a. At most two human keepers — this is what closes R1 ──
    //
    // R1 sat in the risk register as High and Accepted, on the reasoning that no server rule can
    // reach it: keepers must decrypt to approve, so nothing at release time distinguishes a
    // conspiracy from a genuine recovery. Still true, and beside the point — three people cannot
    // collude to reach a threshold of three if a member can never have three human keepers.
    seedMember('thirdHumanPK');
    seedMember('fourthHumanPK');
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'device', holderRef: 'self', shareIndex: 1 }),
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 2 }),
            share({ holderType: 'member', holderRef: 'buddyPK', shareIndex: 3 }),
            share({ holderType: 'member', holderRef: 'thirdHumanPK', shareIndex: 4 }),
        ]),
        'at most 2 human keepers',
        'refuses a split where three people could agree to take the account',
    );
    throws(
        () => putShareGeneration('rejectPK', [
            share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 1 }),
            share({ holderType: 'member', holderRef: 'buddyPK', shareIndex: 2 }),
            share({ holderType: 'member', holderRef: 'thirdHumanPK', shareIndex: 3 }),
            share({ holderType: 'member', holderRef: 'fourthHumanPK', shareIndex: 4 }),
        ]),
        'at most 2 human keepers',
        '...and refuses an all-human split however many keepers it has',
    );
    assert(getCurrentGeneration('rejectPK') === 0, 'a refused human-keeper split wrote nothing');

    // Two humans is the ceiling, not one below it — the doc's own nudge fires at "<2 human
    // keepers", so a member being pushed TO two must not then be refused for reaching it.
    seedMember('twoHumansPK');
    const atTheCap = putShareGeneration('twoHumansPK', [
        share({ holderType: 'device', holderRef: 'self', shareIndex: 1 }),
        share({ holderType: 'member', holderRef: 'inviterPK', shareIndex: 2 }),
        share({ holderType: 'member', holderRef: 'buddyPK', shareIndex: 3 }),
    ]);
    assert(atTheCap === 1, 'exactly two human keepers is allowed — the cap is a ceiling, not a limit below it');

    // The arrangement the cap is designed to leave open: nobody has to answer their phone.
    seedMember('noHumansPK');
    const machinesOnly = putShareGeneration('noHumansPK', [
        share({ holderType: 'device', holderRef: 'self', shareIndex: 1 }),
        share({ holderType: 'hub', holderRef: 'self', shareIndex: 2 }),
        share({ holderType: 'sso', holderRef: 'apple', shareIndex: 3, ssoLookupHash: 'hash-no-humans' }),
    ]);
    assert(machinesOnly === 1, 'a split needing no human at all is still allowed');

    // ── 7b. Two owners cannot share a sign-in lookup hash ──
    // The hash is SHA-256(sub ‖ per-split random salt), so a collision means the salt is not doing
    // its job. Failing here is the point: the alternative is findShareBySsoLookup quietly serving
    // one arbitrary row of two, at recovery, to the wrong person.
    seedMember('collidePK');
    throws(
        () => putShareGeneration('collidePK', [
            ...baseTrio(),
            share({ holderType: 'sso', holderRef: 'apple', shareIndex: 77, ssoLookupHash: 'sso-hash-v2' }),
        ]),
        'UNIQUE',
        'refuses a sign-in lookup hash already claimed by another member',
    );

    // ── 8. Keeper summary exposes types, never identities ──
    const summary = listKeeperTypes('ssoOwnerPK');
    const serialised = JSON.stringify(summary);
    assert(summary.length === 4, 'four keeper types are reported (device, hub, member, sso)');
    assert(
        summary.reduce((n, s) => n + s.count, 0) === 4,
        'the counts add up to the fragments actually held',
    );
    assert(!serialised.includes('inviterPK'), 'the summary does NOT leak the inviter\'s public key');
    assert(!serialised.includes('facebook'), 'the summary does NOT leak which provider was used');
    assert(!serialised.includes('sso-hash-v2'), 'the summary does NOT leak the sign-in lookup hash');

    // ── 9. Wholesale deletion, for account removal ──
    const removed = deleteAllShares('ssoOwnerPK');
    assert(removed === 4, 'deleting a member\'s fragments removes all of them');
    assert(getCurrentGeneration('ssoOwnerPK') === 0, '...and the member reads as never-split again');

    console.log(`\n${passed}/${run} passed`);
    // Explicit, like every other test here: initStateEngine leaves timers and handles open, so
    // returning normally hangs the runner instead of reporting a pass.
    process.exit(passed === run ? 0 : 1);
}

main();
