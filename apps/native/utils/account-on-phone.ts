/**
 * Which account this phone holds, announced each time its key is written or taken off, for what the phone keeps per
 * account (blocklist.ts).
 *
 * identity.ts is the only code that writes or removes the phone's key, and it announces the key the phone holds after
 * each write: a join (a fresh key, or the door's), a restore with 12 words or a sign-in, Replace, Sign Out, the
 * node-mismatch delete, the door taking back a key it made. A name change or added words announce the same key again,
 * so a listener acts only when the key differs from the one it knows.
 *
 * Import-free, so identity.ts and its tests load it without React Native.
 */

/** Called with the public key the phone now holds, or null when it holds none. */
export type AccountOnPhoneListener = (publicKey: string | null) => void;

const listeners = new Set<AccountOnPhoneListener>();

/** Listen for the phone's account being written or taken off. Returns the way to stop listening. */
export function onAccountOnPhone(listener: AccountOnPhoneListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** identity.ts, after it has written the phone's key (`publicKey`) or taken it off (null). Never throws. */
export function announceAccountOnPhone(publicKey: string | null): void {
    for (const listener of [...listeners]) {
        try {
            listener(publicKey || null);
        } catch (e) {
            console.warn('[Account] A listener failed on an account change', e);
        }
    }
}
