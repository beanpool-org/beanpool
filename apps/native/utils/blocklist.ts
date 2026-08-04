import * as SecureStore from 'expo-secure-store';
import { DeviceEventEmitter } from 'react-native';
import { reportAbuse } from './db';

const BLOCKLIST_STORAGE_KEY = 'beanpool_blocked_users';
export const BLOCKLIST_UPDATED_EVENT = 'beanpool_blocklist_updated';

let cachedBlocklist: string[] | null = null;

/**
 * Retrieves the current array of blocked user public keys.
 */
export async function getBlockedUsers(): Promise<string[]> {
    try {
        const data = await SecureStore.getItemAsync(BLOCKLIST_STORAGE_KEY);
        if (data) {
            cachedBlocklist = JSON.parse(data);
            return cachedBlocklist || [];
        }
    } catch (e) {
        console.error('[blocklist] Failed to read blocked users from SecureStore', e);
    }
    cachedBlocklist = [];
    return [];
}

/**
 * Returns whether a given user public key is in the local blocklist synchronously (from cache).
 */
export function isUserBlockedSync(pubkey: string): boolean {
    if (!cachedBlocklist) return false;
    return cachedBlocklist.includes(pubkey);
}

/**
 * Asynchronously checks if a given user is blocked.
 */
export async function isUserBlocked(pubkey: string): Promise<boolean> {
    const list = await getBlockedUsers();
    return list.includes(pubkey);
}

/**
 * Blocks a user, saves to SecureStore, notifies server moderation (per Apple Guideline 1.2),
 * and dispatches a global event for immediate UI updates.
 */
export async function blockUser(
    targetPubkey: string,
    reporterPubkey?: string,
    reason: string = 'User Blocked by Member',
    postId?: string
): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const list = await getBlockedUsers();
        if (!list.includes(targetPubkey)) {
            const newList = [...list, targetPubkey];
            await SecureStore.setItemAsync(BLOCKLIST_STORAGE_KEY, JSON.stringify(newList));
            cachedBlocklist = newList;
            
            // Apple Guideline 1.2: Blocking must notify developer of inappropriate content
            if (reporterPubkey) {
                try {
                    await reportAbuse(reporterPubkey, targetPubkey, reason, postId);
                } catch (err) {
                    console.warn('[blocklist] Failed to send reportAbuse to server on block:', err);
                }
            }

            DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to block user', e);
    }
    return false;
}

/**
 * Unblocks a user, updates SecureStore, and dispatches a global event.
 */
export async function unblockUser(targetPubkey: string): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const list = await getBlockedUsers();
        if (list.includes(targetPubkey)) {
            const newList = list.filter(pk => pk !== targetPubkey);
            await SecureStore.setItemAsync(BLOCKLIST_STORAGE_KEY, JSON.stringify(newList));
            cachedBlocklist = newList;
            DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to unblock user', e);
    }
    return false;
}
