import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BeanPoolIdentity } from './identity';
import type { KeeperEnrolmentResult } from './keeper-enrolment';
import { offeredProviders } from './sso-providers';
import { CLAIM_CODE_ID, cleanClaimName, claimNodeOrigin } from './claim-link';

/**
 * Mid-wizard onboarding state.
 *
 * The keypair is created (and saved to SecureStore) at Step 1 of the join wizard, and the
 * invite is redeemed there too — so the member exists on the node from Step 1 onwards,
 * before the avatar, the words or the guide. If the app dies mid-wizard, the next launch
 * loads a valid identity whose wizard is unfinished; without this record the root
 * gatekeeper would read that as a wrong-node problem and strand a brand-new user on the
 * node-mismatch screen. While a record exists the gatekeeper routes back into the wizard
 * and the welcome screen restores the saved step.
 *
 * (This used to say the member was only created at the final step. That stopped being true
 * when redemption moved to Step 1, and the stale comment is most of why a redundant second
 * redeem survived at the end of the wizard for so long — see `redeemed` below.)
 */
export type OnboardingStep = 'create' | 'globalJoin' | 'claim' | 'profileSetup' | 'seedBackup' | 'onboardingGuide' | 'ownerCard';

/**
 * Which door the wizard came in by. Absent is `invite`: every record written before the global
 * community existed.
 *
 * - `invite`: an invite to a community (step `create`).
 * - `global`: the global community's open door (step `globalJoin`, utils/global-join.ts). Its
 *   `inviteCode` is '' and its `anchorUrl` is the global community.
 * - `claim`: a community's claim made this account (step `claim` while the claim is out, utils/claim-key.ts and
 *   app/claim-community.tsx). Its `inviteCode` is '' and its `anchorUrl` is the community claimed, at its own address.
 *   After the claim: Your Photo, Safety Backup, How it Works, then the owner's card (step `ownerCard`).
 */
export type OnboardingFlow = 'invite' | 'global' | 'claim';

export interface PendingOnboarding {
    step: OnboardingStep;
    inviteCode: string;
    anchorUrl: string;
    callsign: string;
    avatar?: string | null;
    flow?: OnboardingFlow;
    /**
     * Global and claim flows only: the public key the door made, which has never been offered to any other community.
     * An invite join that reuses the key takes this away before it sends it (door-key.ts `adoptJoinKey`),
     * and replaces the whole record once it has redeemed. Survives a restart so a door that refuses for good
     * can take that key off the phone again (identity.ts `discardUnjoinedIdentity`), but only while
     * `joinsOut` is 0. A key, not a flag: only that exact key is ever taken, never one the phone already had
     * or holds instead.
     */
    freshKey?: string;
    /**
     * Global and claim flows only, with `freshKey`: how many joins signed by that key went out without the node answering
     * that it refused them. Counted up on the phone before each join is sent, and down when the node refuses
     * it (door-key.ts `countDoorJoinOut`, `countDoorJoinRefused`). A join with no answer, an unclear one (a 5xx) or a 2xx
     * stays counted, as does one the app was stopped in the middle of. The key comes off the phone only at 0: no join it
     * signed can have put it on the node.
     */
    joinsOut?: number;
    /**
     * Claim flow only, at step `claim`: the claim code's public id (GET /api/local/claim `codeId`), so the next launch
     * comes back to the claim screen for that code ({@link resumePlan}). Never the code itself: it is typed again, from
     * the server's QR or its claim-code.txt.
     */
    claimCodeId?: string;
    /**
     * Claim flow only, once the claim is in: the community's name as its server said it, cleaned (claim-link.ts
     * `cleanClaimName`), for the owner's card at the wizard's end ("You own ‹name›").
     */
    communityName?: string;
    /**
     * Global and claim flows only: what the join's sign-in left protecting the account (the recovery copy the join
     * carried, or the sign-in Safety Backup added), so Safety Backup shows it after a restart too. Provider names and
     * counts, nothing secret.
     */
    joinEnrolment?: KeeperEnrolmentResult | null;
    /**
     * Global and claim flows only: the member came in with 12 words alone (the global community's 12-words door,
     * two-doors design §2, or a claim, which makes the account with its words), so Safety Backup says what the words are
     * for them and offers a sign-in as a second way back, after a restart too. Absent: a sign-in.
     */
    joinDoor?: 'words';
    /**
     * Global flow only, at the door: the record this phone had before it (an invite join part-way through,
     * with the key the global join now uses), given back if the door refuses for good (global-join.ts
     * `releaseJoinKey`).
     */
    before?: PendingOnboarding | null;
    /**
     * The public key this join made on this phone, when it made one (the invite wizard's `createIdentity`, or the global
     * door's own key). Its 12 words are the member's own new ones, and Safety Backup shows them as it always has. Absent,
     * or another key: the phone already had this key (an established account joining another community), and Safety
     * Backup reads its words only once the phone's lock has passed (words-behind-lock.ts; PR #1205 review 4112404374).
     * A key, not a flag, as `freshKey` is: it never vouches for any key but that one. The invite wizard writes it as soon
     * as its key is on the phone, before the redeem ({@link recordJoinKeyMade}). A door's key that a claim takes over keeps
     * it in place of the door's `freshKey` (door-key.ts `adoptJoinKey`, `keepNewKey`): its words are still new.
     */
    newKey?: string;
    /**
     * Whether the invite has been redeemed on the node for this identity.
     *
     * Persisted rather than kept in memory because it has to survive the app being killed
     * mid-wizard, which is the one case where the final step genuinely cannot assume the
     * member already exists.
     *
     * Optional, and absent means "not known to be redeemed" — so a record written by the
     * previous build simply gets the old behaviour of attempting again, which the server
     * answers with `alreadyMember`. Erring that way round is deliberate: a redundant
     * redeem is a wasted round trip, while a skipped one would leave somebody mid-wizard
     * unregistered on the node with no second chance.
     */
    redeemed?: boolean;
}

const KEY = 'beanpool_pending_onboarding';
const listeners = new Set<() => void>();

export async function getPendingOnboarding(): Promise<PendingOnboarding | null> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export async function setPendingOnboarding(state: PendingOnboarding): Promise<void> {
    try {
        await AsyncStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
        console.warn('[Onboarding] Failed to persist wizard state', e);
    }
    notify();
}

/** Merge a patch into the existing record; no-op when no wizard is pending. */
export async function updatePendingOnboarding(patch: Partial<PendingOnboarding>): Promise<void> {
    const current = await getPendingOnboarding();
    if (!current) return;
    await setPendingOnboarding({ ...current, ...patch });
}

export async function clearPendingOnboarding(): Promise<void> {
    try {
        await AsyncStorage.removeItem(KEY);
    } catch {}
    notify();
}

/**
 * The invite wizard's Next has just made a key and saved it (welcome.tsx handleCreate's createIdentity): the record says
 * so now, before the invite is redeemed. A redeem that fails (offline, a 5xx, a captive portal, a node that doesn't
 * confirm), or an app stopped before its answer, then still knows at the next Next, or after a restart, that the key is
 * the member's own new one, and Safety Backup shows its words with no lock (PR #1205 review 4112501801). The key is on the
 * phone first and the record after, as everywhere in this wizard: a record with no key behind it is dropped at the next
 * start ({@link resumePlan}'s `clear`).
 *
 * - At `create`, not redeemed: a restart comes back to Next with the name and invite, and Next redeems. The redeem's own
 *   write replaces the record, as before.
 * - Only for the key that Next made. The caller never passes a key the phone already had.
 * - Written over no record, or an invite join's (which then has no key behind it: Next made a key because the phone had
 *   none). A record of the global door's, and the invite join it holds in `before`, is left as it is: a retry then asks
 *   the phone's lock, never anything ungated that the record doesn't name.
 * - It ends where the wizard's record always has: the wizard's finish, a wipe, a restore.
 */
export async function recordJoinKeyMade(
    join: { inviteCode: string; anchorUrl: string; callsign: string },
    publicKey: string,
): Promise<void> {
    if (!publicKey) return;
    if ((await getPendingOnboarding())?.flow === 'global') return;
    await setPendingOnboarding({
        step: 'create',
        inviteCode: join.inviteCode,
        anchorUrl: join.anchorUrl,
        callsign: join.callsign,
        redeemed: false,
        newKey: publicKey,
    });
}

/** What the welcome screen does with a record it finds on arrival. */
export type ResumePlan =
    /** Nothing to resume, or a fresh invite outranks the record: leave the record alone. */
    | { action: 'none' }
    /** The keypair never made it to storage: nothing to resume, drop the record. */
    | { action: 'clear' }
    | {
        action: 'resume';
        mode: OnboardingStep;
        flow: OnboardingFlow;
        callsign: string;
        inviteCode: string;
        redeemed: boolean;
        anchorUrl: string;
        avatar: string | null;
        /** The stored key the wizard carries on with. Null only for an invite join still at `create`. */
        identity: BeanPoolIdentity | null;
        /**
         * Global and claim flows: the stored key was made by that join and never offered to another community (see
         * `freshKey`). Only a hint for the screen: door-key.ts reads the record again before it writes or takes off a key.
         */
        freshKey: boolean;
        /** The stored key is one this join made ({@link keyMadeForThisJoin}): Safety Backup shows its words with no lock. */
        newKey: boolean;
        joinEnrolment: KeeperEnrolmentResult | null;
        /** Global and claim flows: the member came in with 12 words alone (`joinDoor`). */
        joinDoor: 'words' | null;
        /** Claim flow at step `claim`: the code's id, for the claim screen's route; null otherwise. */
        claimCodeId: string | null;
        /** Claim flow: the community's name for the owner's card, cleaned again as it is read; null when none was kept. */
        communityName: string | null;
    };

/**
 * Whether `publicKey` is a key this join made on this phone: the wizard's own (`newKey`), or a door's (the global door's, a
 * claim's) while its record says so (`freshKey`), in `record` or in the invite join the door holds (`before`). False for a
 * key the phone already had, and for no record: then Safety Backup asks the phone's lock before the words.
 */
export function keyMadeForThisJoin(record: PendingOnboarding | null | undefined, publicKey: string): boolean {
    if (!record || !publicKey) return false;
    if (record.newKey === publicKey) return true;
    if ((record.flow === 'global' || record.flow === 'claim') && record.freshKey === publicKey) return true;
    return keyMadeForThisJoin(record.before, publicKey);
}

/**
 * Decide the welcome screen's resume, apart from the screen so it can be tested.
 *
 * `incomingInvite` is any invite that arrived with the screen (a param or a link); `paramsInvite` is the
 * param alone. A fresh invite outranks a half-done wizard unless it is that wizard's own invite, so a
 * global or claim record (no invite of its own) always gives way to one: the invite join reuses the stored key
 * (one identity per device) and takes the door's mark off it first (door-key.ts `adoptJoinKey`), so no key the
 * node may hold is ever lost.
 *
 * A claim at step `claim` resumes as mode `claim`: the welcome screen hands it to the claim screen at the record's
 * address and code id, where the node says whether the claim landed (app/claim-community.tsx). A claim record whose
 * address is not one the app would claim at, or a step that is not a claim's, is nothing to resume: it is dropped.
 *
 * So is a claim at step `claim` whose record no longer marks the stored key as the claim's own (`freshKey`): another join
 * has taken that key over (door-key.ts `adoptJoinKey`: an invite join, or a claim at another address with it), or the
 * phone holds another key. Such a key never comes off the phone, and the claim screen would read it as an account, which
 * never asks the node whose it is: handed back there, the phone would come back to it at every launch (#2433 review).
 * The record goes; the key stays.
 */
export function resumePlan(
    pending: PendingOnboarding | null,
    stored: BeanPoolIdentity | null,
    arrival: { incomingInvite?: string | null; paramsInvite?: string | null } = {},
): ResumePlan {
    if (!pending) return { action: 'none' };
    if (arrival.incomingInvite && pending.inviteCode !== arrival.paramsInvite) return { action: 'none' };
    if (!stored) return { action: 'clear' };
    const flow: OnboardingFlow = pending.flow === 'global' ? 'global' : pending.flow === 'claim' ? 'claim' : 'invite';
    // A claim's address is checked as a link's is (claim-link.ts): the record is read back from storage, like any input.
    const anchorUrl = flow === 'claim' ? claimNodeOrigin(pending.anchorUrl) : pending.anchorUrl || '';
    if (anchorUrl === null) return { action: 'clear' };
    // A claim's own two steps and the three every door shares; the claim's two belong to no other flow.
    const claimOnly: readonly OnboardingStep[] = ['claim', 'ownerCard'];
    const fits = flow === 'claim' ? pending.step !== 'create' && pending.step !== 'globalJoin' : !claimOnly.includes(pending.step);
    if (!fits) return { action: 'clear' };
    if (flow === 'claim' && pending.step === 'claim' && pending.freshKey !== stored.publicKey) return { action: 'clear' };
    const doorFlow = flow === 'global' || flow === 'claim';
    return {
        action: 'resume',
        mode: pending.step,
        flow,
        callsign: pending.callsign || stored.callsign,
        inviteCode: pending.inviteCode || '',
        redeemed: pending.redeemed === true,
        anchorUrl,
        avatar: pending.avatar ?? null,
        // An invite join at `create` has not committed to the key yet (handleCreate reuses it on Next);
        // every later step, the global door and the claim carry on with the stored one.
        identity: pending.step === 'create' ? null : stored,
        freshKey: doorFlow && typeof pending.freshKey === 'string' && pending.freshKey === stored.publicKey,
        newKey: keyMadeForThisJoin(pending, stored.publicKey),
        joinEnrolment: doorFlow ? savedJoinEnrolment(pending.joinEnrolment) : null,
        joinDoor: doorFlow && pending.joinDoor === 'words' ? 'words' : null,
        claimCodeId: flow === 'claim' && pending.step === 'claim' && typeof pending.claimCodeId === 'string' && CLAIM_CODE_ID.test(pending.claimCodeId)
            ? pending.claimCodeId : null,
        communityName: flow === 'claim' ? cleanClaimName(pending.communityName) : null,
    };
}

/**
 * A claim whose answer the phone has not had yet (step `claim`): its key is on the phone, and the node may hold it as
 * owner. The root guard leaves the claim screen alone for it (auth-return.ts `setupRedirect`, `claimOut`), so the node
 * can say whether the claim landed; every other screen goes to welcome, which hands it back to the claim screen.
 *
 * Read from the step alone, the mark too once another join has taken the key over (door-key.ts `adoptJoinKey`): that
 * join may be a claim at another address, by this key, on the claim screen the guard must not take away while its POST
 * is out. Welcome, where every other screen goes, drops such a record ({@link resumePlan}), and the phone is held no more.
 */
export function claimInFlight(record: PendingOnboarding | null | undefined): boolean {
    return record?.flow === 'claim' && record.step === 'claim';
}

/**
 * The join's enrolment as the record kept it, naming only sign-ins this app offers (utils/sso-providers.ts): the
 * record is read back from storage, like any input. Its keepers are its sign-ins (keeper-enrolment.ts
 * `enrolmentFromVault` for a copy the door's sign-in left at the key vault, or `enrolmentFromJoin` for one the join
 * carried, in a build without a vault), so they are counted again from what is left. Null when none is: Safety Backup
 * then offers the ordinary connect rather than saying a sign-in protects the member.
 */
function savedJoinEnrolment(saved: KeeperEnrolmentResult | null | undefined): KeeperEnrolmentResult | null {
    if (!saved || !Array.isArray(saved.enrolledSso)) return saved ?? null;
    const enrolledSso = offeredProviders(saved.enrolledSso);
    if (enrolledSso.length === saved.enrolledSso.length) return saved;
    if (enrolledSso.length === 0) return null;
    return { ...saved, enrolledSso, enrolled: enrolledSso.map(() => 'sso' as const), available: enrolledSso.length };
}

/**
 * Where a build of 23 Oct 2026 (#2412) kept a claim for an account made elsewhere, the one-time claim code with it. That
 * detour is gone: the claim makes the account (app/claim-community.tsx). Taken off at every start (app/_layout.tsx) and
 * by a wipe, so no claim code stays at rest on a phone that had that build.
 */
const OLD_PENDING_CLAIM_KEY = 'beanpool_pending_claim';

export async function forgetOldPendingClaim(): Promise<void> {
    try {
        await AsyncStorage.removeItem(OLD_PENDING_CLAIM_KEY);
    } catch {}
}

/** Subscribe to changes made through this module (used by the root gatekeeper). */
export function subscribePendingOnboarding(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function notify() {
    listeners.forEach(fn => {
        try { fn(); } catch {}
    });
}
