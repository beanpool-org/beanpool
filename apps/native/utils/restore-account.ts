/**
 * Restoring an account onto this phone, with 12 words or a sign-in, never writes another account over the one it
 * holds without asking.
 *
 * One identity per device: a phone holds one key, so restoring a DIFFERENT account replaces it, and the account that
 * goes comes back only with its own 12 words. The likeliest victim is a key an invite join has just redeemed at a
 * local node, its words not shown yet: that community would keep a member nobody can use (G7 follow-up, 4106492051).
 * So every restore passes {@link clearToRestore} before it writes anything, and the member sees "Replace this phone's
 * account?" (welcome.tsx), with that account's 12 words one tap away when the phone has them. Cancel keeps everything:
 * the key, the onboarding record, and the community the phone is set to. Replace takes all of it, and the rest of what
 * that account kept in app storage, its saved communities and its push alerts, before the restored account is written
 * ({@link saveRestoredAccount}).
 *
 * The other paths that write the phone's identity never put a different key over it:
 * - an invite join reuses the phone's key and makes one only when there is none (welcome.tsx `handleCreate`);
 * - the global community's door joins with the phone's key, and refuses rather than replaces a different one
 *   (global-join.ts `commitJoinKey`, `keepJoinedIdentity`);
 * - a name change and "Add your 12 words" keep the key (identity.ts `updateCallsign`, `addMnemonicToIdentity`);
 * - pairing sends this phone's account to a computer (pair-device.tsx) and writes nothing here.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { recoveryWordsMatchPublicKey } from '@beanpool/core';
import { mnemonicToKeypair } from './crypto';
import {
    importIdentity, loadIdentity, removeStoredIdentity, wipeIdentityScopedStorage, type BeanPoolIdentity,
} from './identity';
import { clearPendingOnboarding } from './onboarding-state';
import { communitiesOnThisPhone, forgetCommunities, releaseAccountFromPhone } from './account-leaves-phone';

/**
 * Asked before a restore writes another account over the one this phone holds: the "Replace this phone's account?"
 * screen. Resolves true only when the member has said to replace `outgoing`.
 */
export type ConfirmReplace = (outgoing: BeanPoolIdentity) => Promise<boolean>;

/**
 * A restore that stopped because the account on this phone stays. Nothing was written. `cancelled` is the member's
 * Cancel, and reads as a sign-in's cancel does (no error shown); `no_consent` is a caller that had no way to ask.
 */
export class RestoreStopped extends Error {
    readonly reason: 'cancelled' | 'no_consent';

    constructor(reason: 'cancelled' | 'no_consent', message: string) {
        super(message);
        this.name = 'RestoreStopped';
        this.reason = reason;
    }
}

/**
 * A replace the member said yes to that this phone then could not save ({@link saveRestoredAccount}). The account it
 * replaced is gone, as "Replace this phone's account?" said it would be, and so is anything the restore had written:
 * the phone holds no account, and the restore can be tried again. Only if even the old key could not be removed does it
 * stay, alone, and trying again asks about it again. Either way its app storage and join wizard are gone, so the app
 * must not go on as that account (welcome.tsx). The message is the failure's own.
 */
export class ReplaceNotSaved extends Error {
    constructor(failure: unknown) {
        super(failure instanceof Error ? failure.message : String(failure));
        this.name = 'ReplaceNotSaved';
    }
}

/** What {@link clearToRestore} lets a restore write. */
export interface ClearedRestore {
    identity: BeanPoolIdentity;
    /** The member said to replace a different account this phone holds. False onto an empty phone or the same account. */
    replacesAnother: boolean;
}

/**
 * The gate every restore passes before it writes anything. Writes nothing itself: returns the identity to write, and
 * whether it replaces another account, for {@link saveRestoredAccount}.
 * - No account on the phone: `incoming`, as always.
 * - The same account (the same key): `incoming`, never asking. The phone's 12 words stay when `incoming` has none
 *   (a sign-in copy made before copies carried them) and they make this key: restoring a key never loses its words.
 * - Another account: `confirmReplace` is asked first, with the phone's account. Only a yes goes on. Cancel, or no
 *   way to ask, throws {@link RestoreStopped} with nothing changed.
 */
export async function clearToRestore(incoming: BeanPoolIdentity, confirmReplace?: ConfirmReplace): Promise<ClearedRestore> {
    const current = await loadIdentity();
    if (!current) return { identity: incoming, replacesAnother: false };
    if (current.publicKey === incoming.publicKey) {
        const keepPhoneWords = !incoming.mnemonic?.length && !!current.mnemonic?.length
            && recoveryWordsMatchPublicKey(current.mnemonic, incoming.publicKey);
        return { identity: keepPhoneWords ? { ...incoming, mnemonic: current.mnemonic } : incoming, replacesAnother: false };
    }
    if (!confirmReplace) {
        throw new RestoreStopped('no_consent', 'This phone holds a different BeanPool account, so it was not replaced.');
    }
    if (!(await confirmReplace(current))) {
        throw new RestoreStopped('cancelled', 'The account on this phone was kept.');
    }
    // The member agreed to replace the account the screen showed. If another has been stored since, ask again.
    const now = await loadIdentity();
    if (now && now.publicKey !== current.publicKey) return clearToRestore(incoming, confirmReplace);
    return { identity: incoming, replacesAnother: true };
}

/**
 * Write what {@link clearToRestore} let through: the community's address, the key, and the end of any half-finished
 * join wizard, in that order. Both restores call this once they have everything they need from a node or a provider,
 * and neither reads the phone's old address, key or sync cursors after the gate: the 12-word restore asks the node the
 * member typed for the account's name, and a sign-in restore has already fetched and opened its copy.
 *
 * Replacing another account, that account goes first, as the screen said, and the restored account inherits none of
 * it (#1179 review 4109902595). Its push alerts stop: the phone's token is unregistered on each community the phone
 * sent it to, signed by its key while the phone still holds it (account-leaves-phone.ts `releaseAccountFromPhone`).
 * That is the one node call after the gate, best effort with a short timeout, and it never fails the restore. Then its saved communities and
 * their cached copies go, and what it kept in app storage (identity.ts `wipeIdentityScopedStorage`: its community's
 * address, its guest markers, the communities it asked to join, its sync cursors). Only this phone's own storage can
 * fail from here. If it does, the old key goes too, with whatever the restore had written, and {@link ReplaceNotSaved}
 * is thrown: the member said that account goes, nothing reports success, and trying again restores onto an empty phone.
 * Onto an empty phone, or over the same account, nothing is removed, and a failed write throws as it is.
 */
export async function saveRestoredAccount({ identity, replacesAnother }: ClearedRestore, anchorUrl: string): Promise<void> {
    try {
        if (replacesAnother) {
            await releaseAccountFromPhone(await leavingAccount(identity));
            await wipeIdentityScopedStorage(AsyncStorage);
        }
        await AsyncStorage.setItem('beanpool_anchor_url', anchorUrl);
        await importIdentity(identity);
    } catch (e) {
        if (!replacesAnother) throw e;
        throw await removeUnsavedReplace(e);
    }
    // Recovering an existing account supersedes any half-finished join wizard on this phone: the gatekeeper must not
    // bounce the member back into onboarding.
    await clearPendingOnboarding();
}

/** The account a replace takes off this phone: the key it holds now, unless that is the restored one. */
async function leavingAccount(restored: BeanPoolIdentity): Promise<BeanPoolIdentity | null> {
    const current = await loadIdentity().catch(() => null);
    return current && current.publicKey !== restored.publicKey ? current : null;
}

/**
 * The phone after a replace it could not save: neither account, nor any of the old one's app storage or saved
 * communities, nor the new community's address. Returns the {@link ReplaceNotSaved} to throw. It is one even when the
 * key could not be removed (the old key is still here, and a retry asks about it again): the join wizard is gone by
 * then, so an app still holding the old account would route it, with none of its app storage, into the app
 * (_layout.tsx, PR #1183 review 4110094956).
 */
async function removeUnsavedReplace(failure: unknown): Promise<ReplaceNotSaved> {
    try {
        await removeStoredIdentity();
    } catch (e) {
        console.error('[Restore] The replaced account\'s key could not be removed after a failed save', e);
    }
    try {
        await forgetCommunities(await communitiesOnThisPhone());
    } catch (e) {
        console.error('[Restore] The saved communities could not be cleared after a failed save', e);
    }
    try {
        await wipeIdentityScopedStorage(AsyncStorage);
    } catch (e) {
        console.error('[Restore] App storage could not be cleared after a failed save', e);
    }
    await clearPendingOnboarding();
    return new ReplaceNotSaved(failure);
}

/**
 * Restore the account these 12 words make ("Recover with 12 Words"), through {@link clearToRestore}.
 *
 * The words ARE the identity. The name is profile data the node holds, so it is asked of the node (`nameOnNode`),
 * never typed, and only once the member has said to go ahead. A node that can't say leaves it empty, as before.
 * Then {@link saveRestoredAccount}.
 */
export async function restoreFromWords(
    words: string[],
    anchorUrl: string,
    options: { confirmReplace?: ConfirmReplace; nameOnNode: (publicKey: string) => Promise<string | null> },
): Promise<BeanPoolIdentity> {
    const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(words);
    const incoming: BeanPoolIdentity = {
        publicKey: publicKeyHex,
        privateKey: privateKeyHex,
        callsign: '',
        createdAt: new Date().toISOString(),
        mnemonic: words,
    };
    const cleared = await clearToRestore(incoming, options.confirmReplace);
    const callsign = (await options.nameOnNode(publicKeyHex).catch(() => null)) || '';
    const identity: BeanPoolIdentity = { ...cleared.identity, callsign };
    await saveRestoredAccount({ ...cleared, identity }, anchorUrl);
    return identity;
}
