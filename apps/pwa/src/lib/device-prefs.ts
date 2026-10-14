/**
 * Device-level preferences that must survive signing out.
 *
 * Signing out clears localStorage wholesale, which is right for identity material — but it
 * also destroyed things that are properties of the *browser*, not the account. The install
 * banner's dismissal was one: sign out, sign back in, and the banner returned, which read as
 * "dismissing it does nothing".
 *
 * Keys listed here are snapshotted and restored around a wipe. Only add a key if it holds no
 * account data and no secret — this survives sign-out by design.
 */
import { clearHomeCache } from './home-cache';
import { clearGroupChatLocks } from './group-chat-lock-store';
import { forgetGroupKeys } from './group-chat-keys';
import { ACCOUNT_EPOCH_KEY } from './account-epoch';

const DEVICE_KEYS = [
    'beanpool-install-dismissed',
    'beanpool-install-dismissed-forever',
] as const;

/**
 * Clear this browser's storage of the account the way sign-out needs, without taking device preferences with it.
 * Everything else — identity, keys, cached account state — still goes: localStorage, and the account state kept in
 * IndexedDB besides the key (lib/identity.ts `wipeIdentity` takes the key): Home's last answer (lib/home-cache.ts),
 * which holds the member's Beans, who wrote to them, their groups and their layout; and the group chats' lock rows
 * (lib/group-chat-lock-store.ts: which groups this identity held locked, and their highest epochs), with every opened
 * group key in memory (Force Clear & Re-Sync keeps the lock rows, as the phone keeps its tables). Every sign-out and
 * delete runs this one routine, so a new store of account state belongs here, not beside a caller.
 *
 * First of all, the account's epoch ends (lib/account-epoch.ts, inside clearHomeCache before its first wait): no page of
 * this web address, another tab still on Home among them, writes the account's state back after this. Its value is
 * kept across the wipe, as the device preferences are, so every tab can still tell.
 */
export async function clearAccountStorage(): Promise<void> {
    const home = clearHomeCache('signed-out');
    forgetGroupKeys();
    const locks = clearGroupChatLocks();
    const keep = new Map<string, string>();
    for (const key of [...DEVICE_KEYS, ACCOUNT_EPOCH_KEY]) {
        const value = localStorage.getItem(key);
        if (value !== null) keep.set(key, value);
    }
    localStorage.clear();
    for (const [key, value] of keep) {
        try { localStorage.setItem(key, value); } catch { /* quota/private mode — not worth failing sign-out over */ }
    }
    await Promise.all([home, locks]);
}
