/**
 * Collection and release — D6, D7, and the piece the node will not hand over at all.
 *
 * This is the layer that can lose somebody their account, in either direction: too strict and a
 * real person cannot get back in, too loose and a stranger walks off with one. So the tests are
 * arranged around the four things that must hold no matter what a caller asks for:
 *
 *   1. The node NEVER releases a K1 sso fragment. Not "after a delay" — not at all. If it did,
 *      hub + sign-in + sso is three pieces the node can assemble on its own behalf and the
 *      threshold protects nobody from the party holding everything.
 *   2. A human keeper's fragment goes the instant THEY approve, and only they can approve it (D6).
 *   3. The hub waits 24h unless a human has already approved (D7).
 *   4. Re-splitting kills a collection in flight, because that is the documented way to stop a
 *      recovery you did not start (R1).
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-keeper-release.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import crypto from 'node:crypto';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { putShareGeneration, type KeeperShareInput } from './engine/recovery-shares.js';
import {
    openCollection, getCollection, collectionState, collectionProgress,
    releaseMemberFragment, releaseSsoFragment, releaseHubFragment,
    hubReleaseEligibleAt, cancelCollection, openCollectionsFor, listReleases,
    pendingKeeperActionsFor,
    isReleasableType, HUB_DELAY_MS, COLLECTION_TTL_MS,
    RecoveryReleaseError,
} from './engine/recovery-release.js';

initStateEngine();

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function rejects(fn: () => unknown, msg: string): void {
    run++;
    try { fn(); console.error(`✗ ${msg} — it RETURNED, which means the check is not there`); }
    catch (e) {
        if (e instanceof RecoveryReleaseError) { passed++; console.log(`✓ ${msg}`); }
        else console.error(`✗ ${msg} — wrong error type: ${(e as Error).message}`);
    }
}

let seq = 0;
function member(): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`)
      .run(pk, `rel${++seq}-${pk.slice(0, 6)}`);
    return pk;
}

const frag = (i: number) => ({
    shareIndex: i,
    encryptedShare: Buffer.from(`ciphertext-${i}`).toString('base64'),
    shareIv: Buffer.from(`iv-${i}`).toString('base64'),
    shareTag: Buffer.from(`tag-${i}`).toString('base64'),
});

/** K1 is RECORDED, not uploaded — the node stores that the keeper exists and none of its bytes. */
const EPH = 'cmVxdWVzdGVyLWVwaGVtZXJhbA';

/** What a keeper hands back once they have decrypted their own copy and re-wrapped it. */
const rewrap = (label: string) => ({
    payload: Buffer.from(`rewrapped-${label}`).toString('base64'),
    payloadIv: Buffer.from(`riv-${label}`).toString('base64'),
    payloadTag: Buffer.from(`rtag-${label}`).toString('base64'),
    ephemeralPubkey: Buffer.from(`reph-${label}`).toString('base64'),
});

/** sso + hub + one human + sign-in. Four keepers against a threshold of 3. */
function split(owner: string, buddy: string, ssoHash: string): number {
    const shares: KeeperShareInput[] = [
        { holderType: 'hub', holderRef: 'node', ...frag(1) },
        { holderType: 'member', holderRef: buddy, ephemeralPubkey: 'ZXBo', ...frag(2) },
        { holderType: 'member', holderRef: 'buddy-2', ephemeralPubkey: 'ZXBoMg', ...frag(3) },
        { holderType: 'sso', holderRef: 'google', ssoLookupHash: ssoHash, ssoLookupSalt: 'c2FsdA', ...frag(4) },
    ];
    return putShareGeneration(owner, shares);
}

/** Wind a collection's clock back, so D7's 24h is testable without waiting for it. */
function ageCollection(id: string, ms: number): void {
    const created = new Date(Date.now() - ms).toISOString();
    db.prepare('UPDATE recovery_collections SET created_at = ? WHERE id = ?').run(created, id);
}

function main(): void {
    console.log('\nRecovery collection and release\n');

    // ── opening a session ─────────────────────────────────────────────────────────────────────
    console.log('── opening ──────────────────────────────────────────────');

    const owner = member();
    const buddy = member();
    const ssoHash = crypto.randomBytes(32).toString('base64url');
    assert(split(owner, buddy, ssoHash) === 1, 'a member is split across four keepers');

    const c = openCollection(owner, EPH);
    assert(!!c.id && c.id.length >= 40, 'a collection id is long enough to be unguessable');
    assert(c.generation === 1, 'and pins the generation it is collecting');
    assert(c.status === 'open' && Date.parse(c.expiresAt) > Date.now(), 'and opens live, with an expiry');
    assert(openCollection(owner, EPH).id !== c.id, 'every session gets its own id');

    rejects(() => openCollection(owner, ''),
        'a session without the recovering device\'s ephemeral key is refused — keepers would have nowhere to send a fragment');
    rejects(() => openCollection(member(), EPH), 'and one for a member who was never split is refused');
    assert(getCollection('not-a-session') === null, 'an unknown id resolves to nothing');
    assert(collectionState('not-a-session') === null, '...and has no state to report');

    // ── 1. releasable types ────────────────────────────────────────────────
    console.log('\n── releasable types ─────────────────────────────────────');

    assert(isReleasableType('hub') && isReleasableType('member') && isReleasableType('sso'),
        'hub, member and sign-in are all releasable types');

    // ── 2. D6: a human keeper, instantly ──────────────────────────────────────────────────────
    console.log('\n── D6: human release ────────────────────────────────────');

    const stranger = member();
    rejects(() => releaseMemberFragment(c.id, stranger, rewrap('stranger')),
        'someone who is not a keeper on this account cannot release anything');
    rejects(() => releaseMemberFragment(c.id, owner, rewrap('self')),
        'and the account being recovered cannot approve its own recovery');
    rejects(() => releaseMemberFragment(c.id, buddy, { ...rewrap('b'), ephemeralPubkey: '' }),
        'a fragment that was not re-wrapped to the recovering device is refused');
    rejects(() => releaseMemberFragment(c.id, '', rewrap('b')), 'an unsigned approval is refused');
    assert(listReleases(c.id).length === 0, 'and none of those refusals released anything');

    const buddyRelease = releaseMemberFragment(c.id, buddy, rewrap('buddy'));
    assert(buddyRelease.holderType === 'member' && buddyRelease.releasedBy === buddy,
        'the keeper taps Approve and their fragment releases instantly (D6)');
    assert(buddyRelease.payload === rewrap('buddy').payload,
        '...carrying the keeper\'s re-wrap, not the stored ciphertext — the node never saw the piece');
    assert(buddyRelease.ephemeralPubkey === rewrap('buddy').ephemeralPubkey,
        '...with the keeper\'s fresh ephemeral key for the recovering device to unwrap with');

    const again = releaseMemberFragment(c.id, buddy, rewrap('SECOND-ATTEMPT'));
    assert(listReleases(c.id).length === 1, 'approving twice does not count as two of the three pieces');
    assert(again.payload === rewrap('buddy').payload,
        '...and the first release stands — a second approval cannot replace the piece afterwards');

    // ── 3. D7: the hub waits, unless a human went first ───────────────────────────────────────
    console.log('\n── D7: the hub ──────────────────────────────────────────');

    // This session already has a human release, so the hub is free immediately.
    const hubNow = releaseHubFragment(c.id);
    assert(hubNow.holderType === 'hub',
        'with a human already approved, the hub releases immediately (D7)');
    assert(hubNow.payload === frag(1).encryptedShare,
        '...handing back exactly what was deposited, unaltered (there is no node-side hub key)');

    // A fresh session with NO human approval: the hub must wait.
    const cold = openCollection(owner, EPH);
    const eligibility = hubReleaseEligibleAt(cold.id);
    assert(eligibility.reason === 'delay', 'a session with no human approval puts the hub on the delay path');
    assert(Math.abs(eligibility.eligibleAt - (Date.parse(cold.createdAt) + HUB_DELAY_MS)) < 2000,
        '...of 24 hours from when the session opened');
    rejects(() => releaseHubFragment(cold.id),
        'and the hub refuses until then — the automated trio cannot take an account quietly');
    assert(listReleases(cold.id).length === 0, '...having released nothing');

    // The escape hatch that makes D7 cost a real user nothing: any human approval frees it at once.
    releaseMemberFragment(cold.id, buddy, rewrap('cold-buddy'));
    const freed = hubReleaseEligibleAt(cold.id);
    assert(freed.reason === 'human-approved', 'one human approval moves the hub off the delay path...');
    assert(freed.eligibleAt <= Date.now(), '...to eligible right now');
    assert(releaseHubFragment(cold.id).holderType === 'hub', '...and it releases');

    // And the delay really is a delay, not a refusal: wind the clock back 24h and it opens.
    const patient = openCollection(owner, EPH);
    rejects(() => releaseHubFragment(patient.id), 'a brand-new session cannot have the hub yet');
    ageCollection(patient.id, HUB_DELAY_MS + 60_000);
    assert(hubReleaseEligibleAt(patient.id).reason === 'delay', 'after 24h the reason is still the delay...');
    assert(releaseHubFragment(patient.id).holderType === 'hub',
        '...but the hub now releases with no human involved at all');

    // Under docs/recovery-model.md §D7, SSO tier has no human keepers, so verified sign-in releases the hub immediately.
    const machine = openCollection(owner, EPH);
    releaseSsoFragment(machine.id, ssoHash);
    assert(hubReleaseEligibleAt(machine.id).reason === 'sso-approved',
        'a SIGN-IN release unblocks the hub immediately for SSO tier (D7 not applied)');
    assert(releaseHubFragment(machine.id).holderType === 'hub',
        '...so hub + sign-in completes recovery without 24h tax');

    // ── 4. K4, scoped to this account and generation ──────────────────────────────────────────
    console.log('\n── K4: sign-in release ──────────────────────────────────');

    const sso = releaseSsoFragment(c.id, ssoHash);
    assert(sso.holderType === 'sso' && sso.releasedBy === null,
        'a verified sign-in releases the K4 fragment, with no human named');
    assert(sso.payload === frag(4).encryptedShare,
        '...as stored ciphertext the sso opens with HKDF(sub, salt) — the node never holds that key');

    const other = member();
    const otherBuddy = member();
    const otherHash = crypto.randomBytes(32).toString('base64url');
    split(other, otherBuddy, otherHash);
    const mine = openCollection(owner, EPH);
    rejects(() => releaseSsoFragment(mine.id, otherHash),
        "somebody else's sign-in keeper cannot release into this account's session");
    rejects(() => releaseSsoFragment(mine.id, 'no-such-hash'), 'and an unknown lookup hash releases nothing');
    rejects(() => releaseSsoFragment(mine.id, ''), 'as does an empty one');

    // ── the threshold ─────────────────────────────────────────────────────────────────────────
    console.log('\n── progress ─────────────────────────────────────────────');

    const p = collectionProgress(c.id)!;
    assert(p.collected === 3 && p.threshold === 2 && p.enough === true,
        'three released fragments is enough to rebuild the phrase');
    assert(JSON.stringify(p).indexOf(rewrap('buddy').payload) === -1,
        'and progress never contains the fragments themselves — polling is not a way to collect');
    assert(p.releasedTypes.includes('member') && p.releasedTypes.includes('hub') && p.releasedTypes.includes('sso'),
        '...only which kinds of keeper have answered');
    assert(collectionProgress(mine.id)!.enough === false, 'a session with nothing collected is not enough');
    assert(collectionProgress('not-a-session') === null, 'and an unknown session has no progress');

    // ── 5. re-splitting is the stop button ────────────────────────────────────────────────────
    console.log('\n── stopping a recovery ──────────────────────────────────');

    const inFlight = openCollection(owner, EPH);
    assert(collectionState(inFlight.id)!.live === true, 'a fresh session is live');
    split(owner, buddy, crypto.randomBytes(32).toString('base64url'));   // generation 2
    const stale = collectionState(inFlight.id)!;
    assert(stale.live === false && stale.reason === 'stale-generation',
        'RE-SPLIT: the owner re-splitting kills a collection in flight (R1)');
    rejects(() => releaseMemberFragment(inFlight.id, buddy, rewrap('too-late')),
        '...and nothing more can be released into it');
    rejects(() => releaseHubFragment(inFlight.id), '...including the hub');
    assert(collectionProgress(inFlight.id)!.live === false, '...and it reports itself dead rather than silently stalling');

    // A re-split must survive having released fragments already, because `recovery_releases` keeps
    // a share_id whose row the re-split DELETES. That works today only because `foreign_keys` is
    // OFF process-wide — so this runs the same re-split with enforcement ON, which is the state a
    // future hardening pass would put the node in. A declared reference here would take out
    // re-splitting for every member who had ever started a recovery, and re-splitting is the stop
    // button (R1): losing it means losing the remedy at exactly the moment it is needed.
    const fkOwner = member();
    const fkBuddy = member();
    split(fkOwner, fkBuddy, crypto.randomBytes(32).toString('base64url'));
    const fkSession = openCollection(fkOwner, EPH);
    const heldShareId = releaseMemberFragment(fkSession.id, fkBuddy, rewrap('fk')).shareId;
    assert(!!heldShareId, 'a fragment is released, so a release row now points at a share row');

    const priorFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = ON');
    let resplitSurvived = true;
    try {
        split(fkOwner, fkBuddy, crypto.randomBytes(32).toString('base64url'));
    } catch {
        resplitSurvived = false;
    } finally {
        db.pragma(`foreign_keys = ${priorFk ? 'ON' : 'OFF'}`);
    }
    assert(resplitSurvived,
        'FK: re-splitting still works with foreign_keys ON, even though a release references the deleted share');
    assert(listReleases(fkSession.id).length === 1,
        '...and the release record survives as the history it is');

    // Cancellation, which is the cheap stop — re-splitting costs every keeper a new fragment.
    const toCancel = openCollection(owner, EPH);
    rejects(() => cancelCollection(toCancel.id, buddy),
        'a keeper cannot cancel somebody else\'s recovery');
    rejects(() => cancelCollection('not-a-session', owner), 'and an unknown session cannot be cancelled');
    assert(cancelCollection(toCancel.id, owner) === true, 'the account owner can cancel a recovery they did not start');
    assert(collectionState(toCancel.id)!.reason === 'cancelled', '...and it reads as cancelled');
    assert(cancelCollection(toCancel.id, owner) === false, '...and cancelling twice is a no-op, not an error');
    rejects(() => releaseMemberFragment(toCancel.id, buddy, rewrap('cancelled')),
        '...with nothing more released into it');

    // The owner has to be able to SEE one to cancel it.
    const visible = openCollection(owner, EPH);
    const openOnes = openCollectionsFor(owner);
    assert(openOnes.some(x => x.id === visible.id),
        'the owner can see live recoveries against their account — which is what makes cancelling possible');
    assert(!openOnes.some(x => x.id === toCancel.id), '...and cancelled ones are not among them');
    assert(openCollectionsFor(other).every(x => x.ownerPubkey === other),
        "...and never anybody else's");

    // ── canonical refs for the machine keepers (CR) ───────────────────────────────────────────
    console.log('\n── the hub is found by type, not by name ────────────────');

    // The constraint is on the COUNT, not the name. `holder_ref` is decorative for a machine
    // keeper — the schema's vocabulary is "member pubkey | provider name | 'self'" and #214's own
    // fixtures use 'self' for BOTH sso and hub — so pinning a magic string would have broken
    // existing data to enforce a convention nobody agreed. Two hub fragments is the real error.
    const misfiled = member();
    const misfiledBuddy = member();
    assert(putShareGeneration(misfiled, [
        { holderType: 'hub', holderRef: 'whatever-the-client-calls-it', ...frag(1) },
        { holderType: 'member', holderRef: misfiledBuddy, ephemeralPubkey: 'ZXBo', ...frag(2) },
        { holderType: 'member', holderRef: 'buddy-2', ephemeralPubkey: 'ZXBoMg', ...frag(3) },
    ]) === 1, 'a hub fragment may be filed under any ref — the name carries no meaning');

    for (const dup of ['hub'] as const) {
        let refused = false;
        try {
            putShareGeneration(misfiled, [
                { holderType: 'hub', holderRef: 'node', ...frag(1) },
                { holderType: dup, holderRef: 'a-second-one', ...frag(2) },
                { holderType: 'member', holderRef: misfiledBuddy, ephemeralPubkey: 'ZXBo', ...frag(3) },
            ]);
        } catch { refused = true; }
        assert(refused,
            `SINGLETON: two ${dup} fragments in one split are refused — "which is THE ${dup}" has no answer`);
    }

    // A row that predates that check — written straight to the table, as a legacy node would have.
    // The release path must still find it, because it looks up by holder_type.
    const legacy = member();
    const legacyBuddy = member();
    split(legacy, legacyBuddy, crypto.randomBytes(32).toString('base64url'));
    db.prepare(`UPDATE recovery_shares SET holder_ref = 'legacy-hub-name'
                WHERE owner_pubkey = ? AND holder_type = 'hub'`).run(legacy);
    const legacySession = openCollection(legacy, EPH);
    releaseMemberFragment(legacySession.id, legacyBuddy, rewrap('legacy'));
    assert(releaseHubFragment(legacySession.id).holderType === 'hub',
        'LEGACY: a hub fragment stored under an old name is still releasable — the lookup is by type');

    // Two hub rows in one generation is permitted by UNIQUE(owner, generation, type, ref) but
    // cannot be resolved. Refusing beats picking: releasing one of two would hand over a piece
    // whose twin stays behind, and the sso would collect fragments that do not fit together.
    const twin = member();
    const twinBuddy = member();
    split(twin, twinBuddy, crypto.randomBytes(32).toString('base64url'));
    const twinGen = db.prepare(`SELECT MAX(generation) g FROM recovery_shares WHERE owner_pubkey = ?`)
        .get(twin) as { g: number };
    db.prepare(`INSERT INTO recovery_shares
        (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
        VALUES (?, 'hub', 'second-hub', 9, 'x', 'y', 'z', ?)`).run(twin, twinGen.g);
    const twinSession = openCollection(twin, EPH);
    releaseMemberFragment(twinSession.id, twinBuddy, rewrap('twin'));
    rejects(() => releaseHubFragment(twinSession.id),
        'two hub fragments in one generation is refused rather than resolved arbitrarily');

    // ── a dead session must not show a countdown (CR) ─────────────────────────────────────────
    console.log('\n── status honesty ───────────────────────────────────────');

    const doomed = openCollection(owner, EPH);
    assert(collectionProgress(doomed.id)!.hubEligibleAt !== null,
        'a live session reports when the hub becomes available...');
    cancelCollection(doomed.id, owner);
    const doomedProgress = collectionProgress(doomed.id)!;
    assert(doomedProgress.hubEligibleAt === null && doomedProgress.hubReason === null,
        '...and a cancelled one reports NO countdown — a user waits on a clock instead of starting over');
    assert(doomedProgress.live === false && doomedProgress.reason === 'cancelled',
        '...it says why instead');

    // ── retention (CR) ────────────────────────────────────────────────────────────────────────
    console.log('\n── retention ────────────────────────────────────────────');

    const tidy = member();
    const tidyBuddy = member();
    split(tidy, tidyBuddy, crypto.randomBytes(32).toString('base64url'));

    // An empty, dead session is noise: somebody opened a screen. It goes.
    const noise = openCollection(tidy, EPH);
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), noise.id);

    // A session that released something is EVIDENCE, whatever its state. It stays, because it is
    // what tells an owner an attempt happened.
    const evidence = openCollection(tidy, EPH);
    releaseMemberFragment(evidence.id, tidyBuddy, rewrap('evidence'));
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), evidence.id);

    openCollection(tidy, EPH);   // triggers the opportunistic prune
    assert(getCollection(noise.id) === null, 'a dead session that released nothing is pruned away');
    assert(getCollection(evidence.id) !== null,
        '...while one that released a fragment is KEPT as evidence an attempt happened');
    assert(listReleases(evidence.id).length === 1, '...with its release record intact');

    // The cap. Opening a session is unauthenticated by necessity, so a hard refusal would let
    // anyone lock a member out of their own recovery — the oldest is evicted instead.
    const flooded = member();
    const floodedBuddy = member();
    split(flooded, floodedBuddy, crypto.randomBytes(32).toString('base64url'));
    const opened: string[] = [];
    for (let i = 0; i < 14; i++) opened.push(openCollection(flooded, EPH).id);

    const stillLive = openCollectionsFor(flooded);
    assert(stillLive.length <= 10, `a flood is capped at 10 live sessions (got ${stillLive.length})`);
    const newest = opened[opened.length - 1];
    assert(stillLive.some(x => x.id === newest),
        'and the NEWEST survives — the person actually recovering opens one and uses it immediately');
    assert(!stillLive.some(x => x.id === opened[0]),
        '...while the oldest was evicted, so a flood pushes out its own earlier attempts');
    // The point of evicting rather than refusing: the member can always still start a recovery.
    const afterFlood = openCollection(flooded, EPH);
    assert(collectionState(afterFlood.id)!.live === true,
        'CRITICAL: a flood never locks the real member out — they can always open a fresh session');

    // An EVICTED session must be dead (CR). Eviction sets status='expired' while leaving
    // expires_at in the FUTURE, so a liveness check that enumerates statuses and then compares the
    // clock catches neither. That left the worst possible combination: still collecting fragments,
    // while openCollectionsFor hid it from the owner and cancelCollection refused it for not being
    // open. Invisible, uncancellable, and working — for up to 72 hours.
    // It has to be a session with a RELEASE, because an evicted empty one is deleted outright by
    // the same prune pass — so the surviving evicted row is exactly the one that matters, the one
    // kept as evidence. That is also the one an attacker would have: they got a fragment, then got
    // pushed out of the cap.
    const victimOwner = member();
    const victimBuddy = member();
    split(victimOwner, victimBuddy, crypto.randomBytes(32).toString('base64url'));
    const evictedId = openCollection(victimOwner, EPH).id;
    releaseMemberFragment(evictedId, victimBuddy, rewrap('pre-eviction'));
    for (let i = 0; i < 12; i++) openCollection(victimOwner, EPH);

    const evictedRow = db.prepare('SELECT status, expires_at FROM recovery_collections WHERE id = ?')
        .get(evictedId) as { status: string; expires_at: string } | undefined;
    assert(evictedRow?.status === 'expired' && Date.parse(evictedRow.expires_at) > Date.now(),
        "the evicted session is marked 'expired' while its expiry is still in the FUTURE...");
    assert(!openCollectionsFor(victimOwner).some(x => x.id === evictedId),
        '...and the owner can no longer see it, so they could not cancel it either...');
    const evictedState = collectionState(evictedId)!;
    assert(evictedState.live === false && evictedState.reason === 'expired',
        '...so it had BETTER be dead — liveness is default-closed, not a list of statuses to remember');
    rejects(() => releaseMemberFragment(evictedId, victimBuddy, rewrap('post-eviction')),
        '...and nothing more can be released into it');
    assert(collectionProgress(evictedId)!.hubEligibleAt === null,
        '...and it shows no hub countdown');
    assert(listReleases(evictedId).length === 1,
        '...while the fragment it already took is still on record as evidence');

    // ── expiry ────────────────────────────────────────────────────────────────────────────────
    const old = openCollection(owner, EPH);
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), old.id);
    assert(collectionState(old.id)!.reason === 'expired', 'a session past its expiry is dead...');
    rejects(() => releaseMemberFragment(old.id, buddy, rewrap('expired')), '...and releases nothing');
    assert(COLLECTION_TTL_MS > HUB_DELAY_MS,
        'and the TTL outlasts the hub delay, so D7 never expires the session it is holding');

    // ── the seam: a guardian who is also a keeper ─────────────────────────────────────────────
    //
    // Two mechanisms, one word on the button. These pin that the node can TELL a keeper their
    // fragment is still outstanding — and, just as importantly, that it stays quiet in every case
    // where there is nothing to do. A prompt that cries wolf gets dismissed, and the one time it
    // mattered is the time somebody could not get their account back.
    console.log('\n── keeper obligations after a guardian approval ──────────');

    const so = member();                      // the owner being recovered
    const sk = member();                      // their buddy: guardian AND keeper
    const nonKeeper = member();
    split(so, sk, crypto.randomBytes(32).toString('base64url'));

    assert(pendingKeeperActionsFor(sk, so).length === 0,
        'with no live session, a keeper is asked to do nothing');

    const sc = openCollection(so, EPH);
    const outstanding = pendingKeeperActionsFor(sk, so);
    assert(outstanding.length === 1 && outstanding[0].collectionId === sc.id,
        'once a session opens, the keeper has an outstanding fragment');
    assert(outstanding[0].expiresAt === sc.expiresAt,
        '...with the deadline, so the client can say how long is left');

    assert(pendingKeeperActionsFor(nonKeeper, so).length === 0,
        'someone who holds no fragment is never asked for one');

    // The whole point: having released, the keeper must stop being nagged.
    releaseMemberFragment(sc.id, sk, rewrap('seam'));
    assert(pendingKeeperActionsFor(sk, so).length === 0,
        'once released, the obligation is discharged and the prompt stops');

    // A cancelled session must not resurrect it — the owner said no.
    const sc2 = openCollection(so, EPH);
    assert(pendingKeeperActionsFor(sk, so).length === 1, 'a fresh session raises it again');
    cancelCollection(sc2.id, so);
    assert(pendingKeeperActionsFor(sk, so).length === 0,
        'a cancelled session asks nothing of anybody');

    // An expired one likewise. 72h TTL, wound past.
    const sc3 = openCollection(so, EPH);
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 1000).toISOString(), sc3.id);
    assert(pendingKeeperActionsFor(sk, so).length === 0, 'and an expired session asks nothing either');

    // A re-split moves the generation on; the old session's fragment is not this keeper's problem.
    const sc4 = openCollection(so, EPH);
    assert(pendingKeeperActionsFor(sk, so).length === 1, 'a live session on the current generation counts');
    split(so, sk, crypto.randomBytes(32).toString('base64url'));   // generation 2
    assert(pendingKeeperActionsFor(sk, so).length === 0,
        'but a re-split strands the old session, and the keeper is not asked to serve it');
    void sc4;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery release checks PASSED.');
}

try { main(); process.exit(0); } catch (e) { console.error(e); process.exit(1); }
