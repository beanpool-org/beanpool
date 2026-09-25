/**
 * Restoring an account onto this phone, with 12 words or a sign-in, never writes another account over the one it
 * holds without asking.
 *
 * One identity per device: a phone holds one key, so restoring a DIFFERENT account replaces it, and the account that
 * goes comes back only with its own 12 words. The likeliest victim is a key an invite join has just redeemed at a
 * local node, its words not shown yet: that community would keep a member nobody can use (G7 follow-up, 4106492051).
 * So every restore passes {@link clearToRestore} before it writes anything, and the member sees "Replace this phone's
 * account?" (welcome.tsx), with that account's 12 words one tap away when the phone has them. Cancel keeps everything:
 * the key, the onboarding record, and the community the phone is set to.
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
import { importIdentity, loadIdentity, type BeanPoolIdentity } from './identity';
import { clearPendingOnboarding } from './onboarding-state';

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
 * The gate every restore passes before it writes anything. Writes nothing itself: returns the identity to write.
 * - No account on the phone: `incoming`, as always.
 * - The same account (the same key): `incoming`, never asking. The phone's 12 words stay when `incoming` has none
 *   (a sign-in copy made before copies carried them) and they make this key: restoring a key never loses its words.
 * - Another account: `confirmReplace` is asked first, with the phone's account. Only a yes goes on. Cancel, or no
 *   way to ask, throws {@link RestoreStopped} with nothing changed.
 */
export async function clearToRestore(incoming: BeanPoolIdentity, confirmReplace?: ConfirmReplace): Promise<BeanPoolIdentity> {
    const current = await loadIdentity();
    if (!current) return incoming;
    if (current.publicKey === incoming.publicKey) {
        const keepPhoneWords = !incoming.mnemonic?.length && !!current.mnemonic?.length
            && recoveryWordsMatchPublicKey(current.mnemonic, incoming.publicKey);
        return keepPhoneWords ? { ...incoming, mnemonic: current.mnemonic } : incoming;
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
    return incoming;
}

/**
 * Restore the account these 12 words make ("Recover with 12 Words"), through {@link clearToRestore}.
 *
 * The words ARE the identity. The name is profile data the node holds, so it is asked of the node (`nameOnNode`),
 * never typed, and only once the member has said to go ahead. A node that can't say leaves it empty, as before.
 * Then the community's address, the key, and the end of any half-finished join wizard, in that order.
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
    const identity: BeanPoolIdentity = { ...cleared, callsign };
    await AsyncStorage.setItem('beanpool_anchor_url', anchorUrl);
    await importIdentity(identity);
    // Recovering an existing account supersedes any half-finished join wizard on this phone: the gatekeeper must not
    // bounce the member back into onboarding.
    await clearPendingOnboarding();
    return identity;
}
