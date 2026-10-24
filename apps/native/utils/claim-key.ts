/**
 * The claim's key (DESIGN-account-without-global-fable.md §2.2): the key rule every door shares (utils/door-key.ts), at
 * the claimed community's own address. A self-hosted community's first owner needs nothing of ours: no global community,
 * no key vault, no registrar. The claim itself is utils/node-claim.ts; the screen is app/claim-community.tsx.
 *
 * - A phone with an account claims with it, as it always has: nothing is written to the phone for it, and it never comes
 *   off. A mark another door left on that key goes first (door-key.ts `adoptJoinKey`): the key is about to go to this
 *   community.
 * - A phone with none claims with a key made for it in memory (identity.ts `draftIdentity`), signed into the claim, and
 *   written to the phone with the wizard's record (flow `claim`, step `claim`) just before the POST: once the request
 *   is out the node may hold that key as its owner while the answer is lost, and the phone must never have thrown away
 *   the only copy of an owner key.
 * - That key comes off the phone again only when no claim by it can ever land: the node has another owner, and the
 *   owner check says so ({@link claimWithKey}); or every claim it signed was refused and the member leaves the screen
 *   ({@link releaseClaimKey}). A lost answer keeps it, and the record brings the next launch back to the claim screen,
 *   where the node says whether the claim landed.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    adoptJoinKey, commitDoorKey, countDoorJoinOut, countDoorJoinRefused, keepJoinedIdentity, keyForThisPhone, madeByTheDoor,
    releaseDoorKey, type JoinKey, type KeyDoor,
} from './door-key';
import { loadIdentity, type BeanPoolIdentity } from './identity';
import { claimAndHear, confirmLostClaim, type ClaimOutcome, type OwnerCheck } from './node-claim';
import { claimInFlight, getPendingOnboarding, setPendingOnboarding } from './onboarding-state';
import { communitySwitched } from './community-switch';
import { addSavedNode, clearGuestNode } from './nodes';

/** The claim, as a door: its record's flow, at the community's own address (an origin, claim-link.ts `claimNodeOrigin`). */
export function claimDoor(origin: string): KeyDoor {
    return { flow: 'claim', url: origin };
}

/** The key this phone claims `origin` with: its own account, else the key the claim made (`held`), else a new one in memory. */
export function claimKeyForThisPhone(origin: string, held: JoinKey | null = null): Promise<JoinKey> {
    return keyForThisPhone(claimDoor(origin), held);
}

/**
 * What the claim screen draws for this phone at `origin`, read from the phone (the app's identity is set only once the
 * join wizard ends, so it can't say):
 * - `account`: the phone's own account claims, as it always has;
 * - `claims`: the claim's own key, written by a claim at `origin` whose answer is not in yet (`joinsOut` of them out) or
 *   that was refused; the screen makes the account with it, under the name kept in the record;
 * - `none`: no key on the phone: the claim makes one at the tap.
 */
export type ClaimKeyState =
    | { kind: 'account'; identity: BeanPoolIdentity }
    | { kind: 'claims'; key: JoinKey; joinsOut: number; callsign: string }
    | { kind: 'none' };

export async function claimKeyState(origin: string | null): Promise<ClaimKeyState> {
    const stored = await loadIdentity();
    if (!stored) return { kind: 'none' };
    if (origin) {
        const record = await getPendingOnboarding();
        if (record && claimInFlight(record) && madeByTheDoor(record, stored.publicKey, claimDoor(origin))) {
            return { kind: 'claims', key: { identity: stored, createdHere: true }, joinsOut: record.joinsOut ?? 0, callsign: record.callsign || stored.callsign };
        }
    }
    return { kind: 'account', identity: stored };
}

export interface ClaimWithKey {
    origin: string;
    key: JoinKey;
    code: string;
    codeId: string;
    salt: string;
    /**
     * The name the claim sends. For a key the claim made, the member's own (it is also that key's callsign on the phone);
     * for the phone's account, the name typed when the screen asked for one (a key not yet a member there), else ''.
     */
    callsign: string;
    isOwner: OwnerCheck;
    fetchImpl?: typeof fetch;
    /** The key is on the phone and the claim is about to go: from here the screen says "Claiming…". */
    onSending?: () => void;
}

export interface ClaimedWithKey {
    outcome: ClaimOutcome;
    /** The identity the claim was signed with: for a key the claim made, under the member's name, on the phone by now. */
    identity: BeanPoolIdentity;
    /** The key is the claim's own (made for this phone by the claim), not the phone's account. */
    madeHere: boolean;
    /** The claim's own key came off the phone again, with its record: another key owns the community. */
    released: boolean;
}

/**
 * The claim, with the key rule (DESIGN §2.2 "The tap", steps 2 to 5). After the phone's unlock: the proof signed by
 * `key` (Checking the code…); for a key the claim made, the key and the wizard's record written and the claim counted
 * out; then the POST. Never throws: every outcome is the screen's.
 *
 * - A refusal of this POST (a wrong or changed code, no code, another server, the brake): no longer counted. The key
 *   stays, for another try with the right code; leaving the screen takes it off ({@link releaseClaimKey}).
 * - Another key owns the community: asked of the node's owner check first, because the POST's 409 alone is not enough
 *   to take a key off (a node whose names changed after an earlier claim by this key landed answers a retry signed for
 *   the old host 409 too). Owner: in. Not owner: the key comes off with its record. No answer: check again.
 * - No clear answer: the key and the record stay.
 */
export async function claimWithKey(req: ClaimWithKey): Promise<ClaimedWithKey> {
    const door = claimDoor(req.origin);
    const madeHere = req.key.createdHere;
    let identity: BeanPoolIdentity = madeHere ? { ...req.key.identity, callsign: req.callsign } : req.key.identity;
    const beforePost = async () => {
        if (madeHere) {
            // Whether the key is the claim's is read again from the phone (door-key.ts): a key this screen made and never
            // wrote gives way to one the phone stored since, and is never written over it.
            identity = await commitDoorKey(door, req.key, req.callsign, { claimCodeId: req.codeId });
            if (!(await countDoorJoinOut(door, identity.publicKey))) {
                throw new Error("The claim couldn't be saved on this phone, so it was not sent. Try again.");
            }
        } else {
            await adoptJoinKey(identity.publicKey);
        }
        req.onSending?.();
    };
    const { outcome, heard } = await claimAndHear({
        origin: req.origin, identity, code: req.code, codeId: req.codeId, salt: req.salt, callsign: req.callsign,
        isOwner: req.isOwner, fetchImpl: req.fetchImpl, beforePost,
    });
    const answered = (out: ClaimOutcome, released = false): ClaimedWithKey => ({ outcome: out, identity, madeHere, released });
    if (!madeHere) return answered(outcome);
    switch (heard) {
        case 'refused':
            await countDoorJoinRefused(door, identity.publicKey);
            return answered(outcome);
        case 'another-owner': {
            const who = await req.isOwner(req.origin, identity).catch(() => null);
            if (who === 'owner') return answered({ kind: 'owner', callsign: null });
            if (who !== 'not-owner') return answered({ kind: 'check-again' });
            return answered(outcome, await settleForGood(door, req.key));
        }
        case 'not-owner':
            return answered(outcome, await settleForGood(door, req.key));
        default:
            return answered(outcome);
    }
}

/**
 * Another key owns the community, so no claim this key signed can ever land: none is counted any more, and the claim's
 * own key comes off the phone with its record (door-key.ts `releaseDoorKey`). Returns whether it came off. Only while the
 * record is the claim's own, still out: never once the claim has moved on to the wizard.
 */
async function settleForGood(door: KeyDoor, key: JoinKey): Promise<boolean> {
    const record = await getPendingOnboarding();
    if (!record || !claimInFlight(record) || !madeByTheDoor(record, key.identity.publicKey, door)) return false;
    if (record.joinsOut) await setPendingOnboarding({ ...record, joinsOut: 0 });
    return releaseDoorKey(door, key);
}

/**
 * "Check again" (DESIGN §2.2, check-again), and the claim screen coming back after a restart to a server that has an
 * owner now: did a claim by the claim's own key land? Asked of the node (node-claim.ts `confirmLostClaim`). Owner: in.
 * Another key's: the key comes off the phone with its record. No answer, or a server that still has no owner: the key
 * and the record stay.
 */
export async function checkOwnClaim(
    origin: string, key: JoinKey, isOwner: OwnerCheck, fetchImpl?: typeof fetch,
): Promise<{ outcome: ClaimOutcome; released: boolean }> {
    const outcome = await confirmLostClaim(origin, key.identity, isOwner, fetchImpl);
    if (outcome.kind !== 'already-claimed') return { outcome, released: false };
    return { outcome, released: await settleForGood(claimDoor(origin), key) };
}

/**
 * Leaving the claim screen: the claim's own key comes off the phone, with its record, only when no claim it signed can
 * have landed (`joinsOut` 0, door-key.ts `releaseDoorKey`). A key a claim may have made the owner stays, and the next
 * launch comes back to the claim screen with it. The phone's own account never comes off. Returns whether a key came off.
 */
export async function releaseClaimKey(origin: string, key: JoinKey): Promise<boolean> {
    // Only a claim still out: once it has moved on to the wizard, its record is the wizard's (door-key.ts would clear it).
    if (!claimInFlight(await getPendingOnboarding())) return false;
    return releaseDoorKey(claimDoor(origin), key);
}

/**
 * The claim is in, by a key the claim made: the phone is this community's from here (its anchor and its saved list), and
 * the wizard's record moves on to Your Photo, which the welcome screen resumes: Your Photo, Safety Backup with the 12
 * words, How it Works, then the owner's card. As the global door's finish does for its own key (welcome.tsx
 * `finishGlobalJoin`), at the community's own address. Nothing goes to us: no copy at the key vault (Marty, 24 Oct).
 *
 * Under the name the node kept when it said one (`keptName`, the claim's answer): the phone must hold the node's.
 * Returns the identity the phone holds.
 */
export async function finishClaim(
    origin: string, claimed: BeanPoolIdentity, communityName: string | null, keptName: string | null = null,
): Promise<BeanPoolIdentity> {
    // On the phone first, under the name the node kept: the record below means nothing without it.
    const identity = await keepJoinedIdentity(keptName ? { ...claimed, callsign: keptName } : claimed);
    await AsyncStorage.setItem('beanpool_anchor_url', origin);
    // The update screen asks the community now in use (utils/community-switch.ts).
    communitySwitched();
    await addSavedNode(origin, communityName ?? undefined).catch(() => {});
    await clearGuestNode(origin);
    await setPendingOnboarding({
        step: 'profileSetup',
        flow: 'claim',
        inviteCode: '',
        anchorUrl: origin,
        callsign: identity.callsign,
        redeemed: true,
        newKey: identity.publicKey,
        joinDoor: 'words',
        ...(communityName ? { communityName } : {}),
    });
    return identity;
}
