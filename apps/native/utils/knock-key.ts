/**
 * The key "Ask to join" signs with, on a phone with no account yet (DESIGN-account-without-global-fable.md §2.4, slice
 * S3): the one rule every door uses (§2.1, utils/door-key.ts), here for a knock. The phone makes the key; a community
 * grants a membership.
 *
 * - The phone's own key when it has one, never a second.
 * - Otherwise a new one, drafted in memory when the form opens ({@link knockKeyForThisPhone}), and written to the phone
 *   only when Send is tapped, before the knock goes out ({@link commitKnockKey}): a knock is a signed write the community
 *   keeps under that key. It is never taken off again on its own. From then on the phone holds an account that is a
 *   member nowhere, waiting for an answer: welcome's waiting mode, where the root guard holds it
 *   (utils/waiting-to-join.ts).
 * - A phone that was only looking around the global community as a visitor (utils/look-around.ts) stops looking when
 *   the key is written: the guest marks and the community in use were the look's, not this account's (as a restore's
 *   `forgetTheLook`). A key that is a member nowhere has no community in use.
 *
 * ## Its 12 words
 *
 * They have never been shown. The phone marks the key as the knock's ({@link knockKeyIsNew}), so the join that lets it
 * in (an invite, or the invite a member's yes sends) shows them at Safety Backup as a new account's words, with no lock
 * first, as every door's new key does (onboarding-state.ts `newKey`). The mark names that exact key and nothing else, and
 * it goes as soon as the key is in a community (welcome.tsx handleCreate once its record says so, and the root guard
 * whenever the phone has a community and no wizard part-way: app/_layout.tsx). So an established account's words always
 * stay behind the phone's lock: a key that has joined anywhere is never read as new again, even after a wipe that keeps it.
 * The mark is app storage beside the account, and goes with it (identity.ts `wipeIdentityScopedStorage`).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { draftIdentity, importIdentity, loadIdentity, type BeanPoolIdentity } from './identity';
import type { JoinKey } from './door-key';
import { forgetTheLook } from './look-around';
import { communitySwitched } from './community-switch';
import { KNOCK_KEY_STORE_KEY } from './storage-keys';

/** What a phone holding another account is told: the request was not sent, and nothing was written. */
export const KNOCK_KEY_DIFFERS = 'This phone holds a different BeanPool account, so the request was not sent.';

/**
 * The key the knock will be signed with: the phone's own when it has one (`createdHere` false), else `held` when the
 * form already drafted one, else a new one in memory, not saved. Asked again at Send, with the key the form holds: a key
 * drafted before the phone stored one (an invite join in between) never outranks it.
 */
export async function knockKeyForThisPhone(held: JoinKey | null = null): Promise<JoinKey> {
    const stored = await loadIdentity();
    if (stored) return { identity: stored, createdHere: false };
    if (held?.createdHere) return held;
    return { identity: await draftIdentity(), createdHere: true };
}

export interface CommitDeps {
    loadIdentity(): Promise<BeanPoolIdentity | null>;
    importIdentity(identity: BeanPoolIdentity): Promise<void>;
    forgetTheLook(): Promise<void>;
    removeAnchor(): Promise<void>;
}

const defaultDeps: CommitDeps = {
    loadIdentity,
    importIdentity: (identity) => importIdentity(identity),
    forgetTheLook: () => forgetTheLook(),
    removeAnchor: async () => {
        if (!(await AsyncStorage.getItem('beanpool_anchor_url'))) return;
        await AsyncStorage.removeItem('beanpool_anchor_url');
        // No community on the phone: the update screen's block comes down (utils/community-switch.ts).
        communitySwitched();
    },
};

/**
 * Send was tapped: the key the knock signs with, on the phone before the knock goes out.
 *
 * - The phone's own key: nothing is written, and it is returned as stored.
 * - A key the form drafted, on a phone with no account: the look (if any) ends first, while the phone still holds no key
 *   ({@link forgetTheLook} only clears a phone with none), then the mark, then the key with the name typed. The mark
 *   first: an app stopped in between leaves a mark naming a key the phone does not hold, which reads as nothing.
 * - The phone holds another key by now, or the account the form was opened with is gone: nothing is written, and the
 *   knock is not sent ({@link KNOCK_KEY_DIFFERS}). An unreadable stored key is never written over (identity.ts KEY-04:
 *   importIdentity refuses).
 */
export async function commitKnockKey(key: JoinKey, callsign: string, deps: CommitDeps = defaultDeps): Promise<BeanPoolIdentity> {
    const stored = await deps.loadIdentity();
    if (stored) {
        if (stored.publicKey !== key.identity.publicKey) throw new Error(KNOCK_KEY_DIFFERS);
        return stored;
    }
    if (!key.createdHere) throw new Error(KNOCK_KEY_DIFFERS);
    const identity: BeanPoolIdentity = { ...key.identity, callsign: callsign.replace(/\s+/g, ' ').trim() };
    await deps.forgetTheLook();
    await deps.removeAnchor();
    await markKnockKey(identity.publicKey);
    await deps.importIdentity(identity);
    return identity;
}

async function markKnockKey(publicKey: string): Promise<void> {
    await AsyncStorage.setItem(KNOCK_KEY_STORE_KEY, publicKey);
}

/** Whether `publicKey` is the key a knock made on this phone, whose 12 words have never been shown (see above). */
export async function knockKeyIsNew(publicKey: string | null | undefined): Promise<boolean> {
    if (!publicKey) return false;
    try {
        return (await AsyncStorage.getItem(KNOCK_KEY_STORE_KEY)) === publicKey;
    } catch {
        return false;
    }
}

/** The knock's key is in a community now (or the phone holds another): it is never read as new again. */
export async function forgetKnockKey(): Promise<void> {
    try {
        await AsyncStorage.removeItem(KNOCK_KEY_STORE_KEY);
    } catch {}
}
