/**
 * Which key a join signs with, and when it is written to the phone or taken off it: the one rule for every door that lets
 * a key join a community (DESIGN-account-without-global-fable.md §2.1). The phone makes the key; a community grants a
 * membership.
 *
 * The phone's own key when it has one, never a second; otherwise a new one, in memory, written only when the join is
 * about to be sent, and taken off again only if no community can hold it.
 *
 * A door is a {@link KeyDoor}: the flow its wizard record carries (utils/onboarding-state.ts) and the address of the
 * community the key joins. Nothing here names a community. The doors so far:
 * - the global community's open door (utils/global-join.ts), at GLOBAL_NODE_URL;
 * - a community's claim (utils/claim-key.ts), at that community's own address, which needs nothing of ours;
 * - any other community's open door (utils/open-door-key.ts, app/join-open-door.tsx), at that community's own address: a
 *   self-hoster's node with the global profile, listed nowhere of ours ({@link openDoorAt}).
 *
 * ## A key any node may hold is never taken off the phone
 *
 * The phone takes a key off only when all of these hold, each read from the saved record, never from memory:
 * - the door made it (`freshKey`, in a record of that door's flow at that door's address), and no other join has used it
 *   since. An invite join that reuses the key takes that mark away before it sends it ({@link adoptJoinKey}), and
 *   replaces the record once it has redeemed;
 * - every join it signed was refused by the node (`joinsOut` is 0). A join counts from just before it is sent until the
 *   node refuses it ({@link countDoorJoinOut}, {@link countDoorJoinRefused}). No answer, an unclear one or a 2xx leaves
 *   it counted;
 * - the refusal is the join's own: the door's screen decides that, and never calls {@link releaseDoorKey} for a refusal
 *   that says nothing about who is in.
 * When in doubt, the key stays with the door's record, and the next launch comes back to the door with it.
 */

import { importIdentity, loadIdentity, draftIdentity, discardUnjoinedIdentity, type BeanPoolIdentity } from './identity';
import { getPendingOnboarding, setPendingOnboarding, clearPendingOnboarding, type OnboardingStep, type PendingOnboarding } from './onboarding-state';

/** The key the join signs with, and whether this door made it. */
export interface JoinKey {
    identity: BeanPoolIdentity;
    /**
     * True: made by this door, only in memory or with the door's own record saying so (`freshKey`). False: the
     * phone already had it, or an invite join has taken it over since. What the screen shows and checks; nothing
     * is written or taken off on it alone (`commitDoorKey` and `releaseDoorKey` read the record again).
     */
    createdHere: boolean;
}

/**
 * A door a key joins by: its wizard record's flow, and the community's address (the record's `anchorUrl`). Flow `global` is
 * an open door, the global community's or any other community's ({@link openDoorAt}): the address says whose.
 */
export interface KeyDoor {
    flow: 'global' | 'claim';
    url: string;
}

/**
 * The open door of the community at `url`, as a key door: the flow the global community's door has always written (`global`,
 * read as "an open door"), at that address (DESIGN-account-without-global-fable.md §2.3). The global community's door is
 * `openDoorAt(GLOBAL_NODE_URL)`.
 */
export function openDoorAt(url: string): KeyDoor {
    return { flow: 'global', url };
}

/** The record's step while a door's join is out: the door's own screen, which the next launch comes back to. */
const STEP_AT_THE_DOOR: Record<KeyDoor['flow'], OnboardingStep> = { global: 'globalJoin', claim: 'claim' };

/** The saved record is this door's: its flow, at its address. */
function doorsRecord(record: PendingOnboarding | null | undefined, door: KeyDoor): record is PendingOnboarding {
    return record?.flow === door.flow && record.anchorUrl === door.url;
}

/** The saved record says this door made this key and no other join has used it ({@link adoptJoinKey} takes the mark away). */
export function madeByTheDoor(record: PendingOnboarding | null | undefined, publicKey: string, door: KeyDoor): boolean {
    return doorsRecord(record, door) && typeof record.freshKey === 'string' && record.freshKey === publicKey;
}

/** Any door's mark on this key: the record's `freshKey`, whichever door wrote it. */
function markedByADoor(record: PendingOnboarding | null, publicKey: string): boolean {
    return (record?.flow === 'global' || record?.flow === 'claim') && typeof record.freshKey === 'string' && record.freshKey === publicKey;
}

/**
 * The phone's own key when it has one (never a second), otherwise `held` when it is a key this door made,
 * otherwise a new one in memory, not yet saved.
 *
 * Asked again at every try, with the key the door already holds. A key made on an earlier visit and never
 * written never outranks one the phone has stored since (an invite join started in between): `commitDoorKey`
 * would write it over that account. Whether a stored key is the door's comes from the saved record, never from
 * `held`: an invite join that took the key over has replaced that record, and the key is its now.
 */
export async function keyForThisPhone(door: KeyDoor, held: JoinKey | null = null): Promise<JoinKey> {
    const stored = await loadIdentity();
    if (stored) {
        return { identity: stored, createdHere: madeByTheDoor(await getPendingOnboarding(), stored.publicKey, door) };
    }
    if (held?.createdHere) return held;
    return { identity: await draftIdentity(), createdHere: true };
}

/**
 * A join signed by the door's own key is about to go out: count it on the phone first, so a join that lands
 * with its answer lost, or with the app stopped, is never forgotten (`joinsOut`). False when the count could
 * not be written; the join is then not sent. True when there is nothing to count (not the door's key).
 */
export async function countDoorJoinOut(door: KeyDoor, publicKey: string): Promise<boolean> {
    const record = await getPendingOnboarding();
    if (!record || !madeByTheDoor(record, publicKey, door)) return true;
    const joinsOut = (record.joinsOut ?? 0) + 1;
    await setPendingOnboarding({ ...record, joinsOut });
    return (await getPendingOnboarding())?.joinsOut === joinsOut;
}

/** The node refused a join signed by the door's own key: it no longer counts. */
export async function countDoorJoinRefused(door: KeyDoor, publicKey: string): Promise<void> {
    const record = await getPendingOnboarding();
    if (!record || !madeByTheDoor(record, publicKey, door) || !record.joinsOut) return;
    await setPendingOnboarding({ ...record, joinsOut: record.joinsOut - 1 });
}

/**
 * Write the join's key to the phone (when this join made it) and the wizard's record, just before the
 * join is sent: an app killed while the join is in flight comes back to the door with the same key, and
 * the node then says whether it landed.
 *
 * A phone that already had a key may be part-way through an invite join. That record is kept inside this
 * one (`before`), so a door that then refuses can give it back, even after a restart.
 *
 * Whether the key is the door's is read again here, from what the phone holds, never taken from `key`: a key
 * only in memory is the door's; a stored one is the door's only while the door's record says so (`freshKey`).
 * The count of joins that key has signed (`joinsOut`) carries over from the door's earlier tries. `extra`: the
 * door's own fields in the record (a claim's code id), never a key or a code.
 */
export async function commitDoorKey(
    door: KeyDoor, key: JoinKey, callsign: string, extra: Partial<PendingOnboarding> = {},
): Promise<BeanPoolIdentity> {
    const identity = { ...key.identity, callsign };
    const stored = await loadIdentity();
    if (stored && stored.publicKey !== identity.publicKey) {
        throw new Error('This phone holds a different BeanPool account, so the join was not sent.');
    }
    const current = await getPendingOnboarding();
    const doorsOwn = madeByTheDoor(current, identity.publicKey, door);
    const madeHere = stored ? doorsOwn : key.createdHere;
    // A record with no key behind it describes nothing; only a key the phone already had has a wizard to keep.
    const before = !stored ? null : doorsRecord(current, door) ? current.before ?? null : current;
    if (!stored || madeHere) await importIdentity(identity);
    await setPendingOnboarding({
        step: STEP_AT_THE_DOOR[door.flow],
        flow: door.flow,
        inviteCode: '',
        anchorUrl: door.url,
        callsign,
        redeemed: false,
        ...extra,
        ...(madeHere ? { freshKey: identity.publicKey, joinsOut: doorsOwn ? current?.joinsOut ?? 0 : 0 } : {}),
        ...(before ? { before } : {}),
    });
    return identity;
}

/**
 * An invite join, or a door other than the one that made it, is about to send this key to a community (handleCreate
 * reuses the phone's key): from here no door ever takes it off the phone. Its record loses `freshKey` now, before the key
 * is sent, so a join that lands with its answer lost is covered too; a join that works replaces the record anyway. Leaves
 * any other record alone.
 *
 * The door's mark also said that the key's 12 words are new, never shown (onboarding-state.ts `keyMadeForThisJoin`), and
 * the record keeps that half as `newKey`, which never takes a key off. Whichever join takes the key over, one refused, or
 * whose answer was lost, or that never finished, leaves the next try knowing: a claim by the key (claim-key.ts
 * `claimWithKey`), and an invite's redeem that the app was stopped in, after which the door's record comes back to its door
 * (open-door-key.ts `openDoorKeyIsNew`; PR #2564 review).
 */
export async function adoptJoinKey(publicKey: string): Promise<void> {
    const record = await getPendingOnboarding();
    if (!record || !markedByADoor(record, publicKey)) return;
    const adopted: PendingOnboarding = { ...record, newKey: publicKey };
    delete adopted.freshKey;
    delete adopted.joinsOut;
    await setPendingOnboarding(adopted);
}

/**
 * After the node refused a join for good, put the phone back as it was before the door. Returns whether a key
 * came off it. Only for the join's own refusal: the door's screen never calls it for one that says nothing about
 * who is in, which leaves every key and record where it is.
 *
 * Decided from the saved record alone, never from `key.createdHere`:
 * - A key the door made (`freshKey`) comes off, with the door's record, only when no join it signed can have
 *   landed (`joinsOut` is 0): every one was refused by the node. It was never offered to another community
 *   ({@link adoptJoinKey}), so no node holds it.
 * - A key the door made that a join may have put on the node stays, and so does the door's record: the next
 *   launch comes back to the door with it.
 * - A key the phone already had, or one an invite join has taken over, stays. The record the join wrote gives
 *   way to the one the phone had before (`before`), or to none if it had none.
 * - With no record of this door's on the phone (nothing was written for the door), nothing changes and nothing comes off.
 */
export async function releaseDoorKey(door: KeyDoor, key: JoinKey): Promise<boolean> {
    const current = await getPendingOnboarding();
    if (!doorsRecord(current, door)) return false;
    const publicKey = key.identity.publicKey;
    if (madeByTheDoor(current, publicKey, door)) {
        if ((current.joinsOut ?? 0) > 0) return false;
        const removed = await discardUnjoinedIdentity(publicKey);
        await clearPendingOnboarding();
        return removed;
    }
    if (current.before) {
        await setPendingOnboarding(current.before);
    } else {
        await clearPendingOnboarding();
    }
    return false;
}

/**
 * In: the key the node has just accepted is this phone's, under the name the node kept. Returns the identity
 * the phone now holds, which the rest of the wizard carries on with (the global door's finish, welcome.tsx
 * `finishGlobalJoin`, and the claim's, claim-key.ts `finishClaim`).
 *
 * Written here as well as at Join, for two reasons:
 * - The node may have kept a different name (it makes a taken one unique). The phone must hold that one,
 *   or a restart reads the old name back and the phone and the node disagree about who this is.
 * - A phone that learns at the sign-in that it is in already (`already_member`) never passes through
 *   `commitDoorKey`. Its key has to be on the phone before the wizard's record says it joined: a record
 *   with no key behind it is dropped on the next launch (onboarding-state.ts `resumePlan`).
 *
 * A key the phone already holds keeps everything but its name. Never writes over a different key: one
 * identity per device, and a phone that somehow holds another account refuses rather than replaces it.
 */
export async function keepJoinedIdentity(identity: BeanPoolIdentity): Promise<BeanPoolIdentity> {
    const stored = await loadIdentity();
    if (stored && stored.publicKey !== identity.publicKey) {
        throw new Error('This phone holds a different BeanPool account, so the join was not saved here.');
    }
    if (!stored) {
        await importIdentity(identity);
        return identity;
    }
    const callsign = identity.callsign || stored.callsign;
    if (stored.callsign === callsign) return stored;
    const kept = { ...stored, callsign };
    await importIdentity(kept);
    return kept;
}
