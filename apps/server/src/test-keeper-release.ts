/**
 * Collection and release — D7, SSO, and the piece the node will not hand over at all.
 *
 * This is the layer that can lose somebody their account, in either direction: too strict and a
 * real person cannot get back in, too loose and a stranger walks off with one. So the tests are
 * arranged around the things that must hold no matter what a caller asks for:
 *
 *   1. The node NEVER releases a K1 sso fragment. Not "after a delay" — not at all.
 *   2. The hub waits 24h unless verified sign-in has already approved (D7).
 *   3. Re-splitting kills a collection in flight, because that is the documented way to stop a
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
    releaseSsoFragment, releaseHubFragment,
    hubReleaseEligibleAt, cancelCollection, openCollectionsFor, listReleases,
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

const EPH = 'cmVxdWVzdGVyLWVwaGVtZXJhbA';

/** hub + sso. Two keepers against a threshold of 2. */
function split(owner: string, ssoHash: string): number {
    const shares: KeeperShareInput[] = [
        { holderType: 'hub', holderRef: 'node', ...frag(1) },
        { holderType: 'sso', holderRef: 'google', ssoLookupHash: ssoHash, ssoLookupSalt: 'c2FsdA', ...frag(2) },
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
    const ssoHash = crypto.randomBytes(32).toString('base64url');
    assert(split(owner, ssoHash) === 1, 'a member is split across two keepers (hub + sso)');

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

    assert(isReleasableType('hub') && isReleasableType('sso') && !isReleasableType('member'),
        'hub and sso are releasable types, member is not');

    // ── 2. D7: the hub waits, unless verified sign-in goes first ──────────────────────────────
    console.log('\n── D7: the hub ──────────────────────────────────────────');

    // A fresh session with NO sign-in approval: the hub must wait.
    const cold = openCollection(owner, EPH);
    const eligibility = hubReleaseEligibleAt(cold.id);
    assert(eligibility.reason === 'delay', 'a session with no sign-in approval puts the hub on the delay path');
    assert(Math.abs(eligibility.eligibleAt - (Date.parse(cold.createdAt) + HUB_DELAY_MS)) < 2000,
        '...of 24 hours from when the session opened');
    rejects(() => releaseHubFragment(cold.id),
        'and the hub refuses until then — automated recovery cannot happen without verified credentials');
    assert(listReleases(cold.id).length === 0, '...having released nothing');

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

    // ── 3. K4, scoped to this account and generation ──────────────────────────────────────────
    console.log('\n── K4: sign-in release ──────────────────────────────────');

    const sso = releaseSsoFragment(c.id, ssoHash);
    assert(sso.holderType === 'sso' && sso.releasedBy === null,
        'a verified sign-in releases the K4 fragment, with no human named');
    assert(sso.payload === frag(2).encryptedShare,
        '...as stored ciphertext the sso opens with HKDF(sub, salt) — the node never holds that key');

    // Now release the hub into c as well
    assert(releaseHubFragment(c.id).holderType === 'hub', 'hub releases now that sso is released');

    const other = member();
    const otherHash = crypto.randomBytes(32).toString('base64url');
    split(other, otherHash);
    const mine = openCollection(owner, EPH);
    rejects(() => releaseSsoFragment(mine.id, otherHash),
        "somebody else's sign-in keeper cannot release into this account's session");
    rejects(() => releaseSsoFragment(mine.id, 'no-such-hash'), 'and an unknown lookup hash releases nothing');
    rejects(() => releaseSsoFragment(mine.id, ''), 'as does an empty one');

    // ── the threshold ─────────────────────────────────────────────────────────────────────────
    console.log('\n── progress ─────────────────────────────────────────────');

    const p = collectionProgress(c.id)!;
    assert(p.collected === 2 && p.threshold === 2 && p.enough === true,
        'two released fragments (hub + sso) is enough to rebuild the phrase');
    assert(p.releasedTypes.includes('hub') && p.releasedTypes.includes('sso'),
        '...only which kinds of keeper have answered');
    assert(collectionProgress(mine.id)!.enough === false, 'a session with nothing collected is not enough');
    assert(collectionProgress('not-a-session') === null, 'and an unknown session has no progress');

    // ── 4. re-splitting is the stop button ────────────────────────────────────────────────────
    console.log('\n── stopping a recovery ──────────────────────────────────');

    const inFlight = openCollection(owner, EPH);
    assert(collectionState(inFlight.id)!.live === true, 'a fresh session is live');
    const newHash = crypto.randomBytes(32).toString('base64url');
    split(owner, newHash);   // generation 2
    const stale = collectionState(inFlight.id)!;
    assert(stale.live === false && stale.reason === 'stale-generation',
        'RE-SPLIT: the owner re-splitting kills a collection in flight (R1)');
    rejects(() => releaseSsoFragment(inFlight.id, ssoHash),
        '...and nothing more can be released into it');
    rejects(() => releaseHubFragment(inFlight.id), '...including the hub');
    assert(collectionProgress(inFlight.id)!.live === false, '...and it reports itself dead rather than silently stalling');

    // A re-split must survive having released fragments already, because `recovery_releases` keeps
    // a share_id whose row the re-split DELETES.
    const fkOwner = member();
    const fkHash = crypto.randomBytes(32).toString('base64url');
    split(fkOwner, fkHash);
    const fkSession = openCollection(fkOwner, EPH);
    const heldShareId = releaseSsoFragment(fkSession.id, fkHash).shareId;
    assert(!!heldShareId, 'a fragment is released, so a release row now points at a share row');

    const priorFk = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = ON');
    let resplitSurvived = true;
    try {
        split(fkOwner, crypto.randomBytes(32).toString('base64url'));
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
    rejects(() => cancelCollection(toCancel.id, other),
        'another member cannot cancel somebody else\'s recovery');
    rejects(() => cancelCollection('not-a-session', owner), 'and an unknown session cannot be cancelled');
    assert(cancelCollection(toCancel.id, owner) === true, 'the account owner can cancel a recovery they did not start');
    assert(collectionState(toCancel.id)!.reason === 'cancelled', '...and it reads as cancelled');
    assert(cancelCollection(toCancel.id, owner) === false, '...and cancelling twice is a no-op, not an error');
    rejects(() => releaseSsoFragment(toCancel.id, newHash),
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

    const misfiled = member();
    assert(putShareGeneration(misfiled, [
        { holderType: 'hub', holderRef: 'whatever-the-client-calls-it', ...frag(1) },
        { holderType: 'sso', holderRef: 'google', ssoLookupHash: 'h', ssoLookupSalt: 's', ...frag(2) },
    ]) === 1, 'a hub fragment may be filed under any ref — the name carries no meaning');

    for (const dup of ['hub'] as const) {
        let refused = false;
        try {
            putShareGeneration(misfiled, [
                { holderType: 'hub', holderRef: 'node', ...frag(1) },
                { holderType: dup, holderRef: 'a-second-one', ...frag(2) },
            ]);
        } catch { refused = true; }
        assert(refused,
            `SINGLETON: two ${dup} fragments in one split are refused — "which is THE ${dup}" has no answer`);
    }

    // A row that predates that check — written straight to the table, as a legacy node would have.
    // The release path must still find it, because it looks up by holder_type.
    const legacy = member();
    const legacyHash = crypto.randomBytes(32).toString('base64url');
    split(legacy, legacyHash);
    db.prepare(`UPDATE recovery_shares SET holder_ref = 'legacy-hub-name'
                WHERE owner_pubkey = ? AND holder_type = 'hub'`).run(legacy);
    const legacySession = openCollection(legacy, EPH);
    releaseSsoFragment(legacySession.id, legacyHash);
    assert(releaseHubFragment(legacySession.id).holderType === 'hub',
        'LEGACY: a hub fragment stored under an old name is still releasable — the lookup is by type');

    // Two hub rows in one generation is permitted by UNIQUE(owner, generation, type, ref) but
    // cannot be resolved. Refusing beats picking: releasing one of two would hand over a piece
    // whose twin stays behind, and the sso would collect fragments that do not fit together.
    const twin = member();
    const twinHash = crypto.randomBytes(32).toString('base64url');
    split(twin, twinHash);
    const twinGen = db.prepare(`SELECT MAX(generation) g FROM recovery_shares WHERE owner_pubkey = ?`)
        .get(twin) as { g: number };
    db.prepare(`INSERT INTO recovery_shares
        (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag, generation)
        VALUES (?, 'hub', 'second-hub', 9, 'x', 'y', 'z', ?)`).run(twin, twinGen.g);
    const twinSession = openCollection(twin, EPH);
    releaseSsoFragment(twinSession.id, twinHash);
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
    const tidyHash = crypto.randomBytes(32).toString('base64url');
    split(tidy, tidyHash);

    // An empty, dead session is noise: somebody opened a screen. It goes.
    const noise = openCollection(tidy, EPH);
    db.prepare('UPDATE recovery_collections SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), noise.id);

    // A session that released something is EVIDENCE, whatever its state. It stays, because it is
    // what tells an owner an attempt happened.
    const evidence = openCollection(tidy, EPH);
    releaseSsoFragment(evidence.id, tidyHash);
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
    split(flooded, crypto.randomBytes(32).toString('base64url'));
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

    // An EVICTED session must be dead (CR).
    const victimOwner = member();
    const victimHash = crypto.randomBytes(32).toString('base64url');
    split(victimOwner, victimHash);
    const evictedId = openCollection(victimOwner, EPH).id;
    releaseSsoFragment(evictedId, victimHash);
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
    rejects(() => releaseSsoFragment(evictedId, victimHash),
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
    rejects(() => releaseSsoFragment(old.id, newHash), '...and releases nothing');
    assert(COLLECTION_TTL_MS > HUB_DELAY_MS,
        'and the TTL outlasts the hub delay, so D7 never expires the session it is holding');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Recovery release checks PASSED.');
}

try { main(); process.exit(0); } catch (e) { console.error(e); process.exit(1); }
