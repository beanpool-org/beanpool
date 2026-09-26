/**
 * What goes with an account when it leaves this phone, beyond its key and its app storage (identity.ts
 * `wipeIdentityScopedStorage`): its push alerts, and the communities it saved with their cached copies.
 *
 * - Push alerts. The phone registered its push token for the account with the community it was set to, and recorded
 *   each one (push-registrations.ts). The node sends that token the account's chat, escrow and recovery alerts, whose
 *   text can carry names and message previews. Left registered, the phone goes on getting them after Sign Out and after
 *   "Replace this phone's account". So each community on the record is asked to drop the token, signed by the account's
 *   own key while the phone still holds it, and no other: a community this phone never sent the token to is never sent
 *   it. Best effort, with a short timeout: a node that can't be reached never holds up or fails the member's Sign Out or
 *   Replace, and keeps the old account's row until that key is used there again or the account is closed or re-keyed
 *   there. The node never drops a key's row because another key registered the same token: any community that holds
 *   the token could then silence a member's recovery alerts (server state-engine.ts `registerPushToken`, #1184 review
 *   4110460184).
 * - Communities. The list the community switcher shows (`beanpool_saved_nodes`) and each one's cached copy
 *   (community-cache.ts).
 *
 * Sign Out and the self-delete purge ({@link signOutOfThisPhone}, settings.tsx) and Replace (restore-account.ts
 * `saveRestoredAccount`) take both, through {@link releaseAccountFromPhone}. The node-mismatch delete
 * ({@link deleteAccountFromThisPhone}, node-mismatch.tsx) stops the push alerts only: there the communities stay, as
 * before, so the member can pick theirs to recover on (welcome.tsx). Restoring the same account, or onto an empty
 * phone, takes nothing (#1183's rule).
 *
 * Every caller runs this BEFORE the key, the push record, the community address or the guest markers are wiped: the
 * unregister needs the key and the record, and the cached copies need the addresses.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { buildSignedHeaders } from './crypto';
import { wipeIdentity, type BeanPoolIdentity } from './identity';
import { communityAddress, forgetPushRegistrations, pushRegisteredCommunities } from './push-registrations';
import { PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from './storage-keys';

/** How long the whole unregister may take. The requests go out together, so this is also each one's limit. */
export const UNREGISTER_TIMEOUT_MS = 4000;

const PUSH_TOKENS_PATH = '/api/push-tokens';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** The communities this key visited as a guest (nodes.ts `markGuestNode`). */
const GUEST_NODES_STORE_KEY = 'beanpool_guest_nodes';

type LeavingAccount = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

interface Storage {
    getItem(key: string): Promise<string | null>;
    removeItem(key: string): Promise<void>;
}

function parseList(raw: string | null): unknown[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Every community this phone keeps a copy of: the one it is set to, the ones it saved, the ones it visited as a guest.
 * Each address once. Reads only: nodes.ts `getSavedNodes` would write the anchor back into the saved list. Not where the
 * push token goes: that is the record push-registrations.ts keeps.
 */
export async function communitiesOnThisPhone(storage: Storage = AsyncStorage): Promise<string[]> {
    const read = async (key: string) => {
        try {
            return await storage.getItem(key);
        } catch {
            return null;
        }
    };
    const saved = parseList(await read(SAVED_NODES_STORE_KEY))
        .map((n) => (n && typeof n === 'object' ? (n as { url?: unknown }).url : undefined));
    const guests = parseList(await read(GUEST_NODES_STORE_KEY));
    const urls = [await read(ANCHOR_STORE_KEY), ...saved, ...guests]
        .map(communityAddress)
        .filter((u): u is string => u !== null);
    return [...new Set(urls)];
}

/** One community's DELETE /api/push-tokens, signed by the leaving key. Never throws; gives up at the deadline. */
async function unregisterAt(community: string, body: string, account: LeavingAccount, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve();
        }, timeoutMs);
    });
    const attempt = (async () => {
        try {
            const headers = await buildSignedHeaders('DELETE', PUSH_TOKENS_PATH, body, account.privateKey, account.publicKey);
            const res = await fetch(`${community}${PUSH_TOKENS_PATH}`, { method: 'DELETE', headers, body, signal: controller.signal });
            if (!res.ok) console.warn(`[Push] ${community} did not unregister this phone (${res.status})`);
        } catch (e) {
            console.warn(`[Push] Could not reach ${community} to unregister this phone:`, e instanceof Error ? e.message : e);
        }
    })();
    try {
        await Promise.race([attempt, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Unregister this phone's push token for `account` on each of `communities`, signed by that account's key. Nothing to
 * do when the phone never got a token (a simulator, Expo Go, permission refused). All together, and done within
 * `timeoutMs` whatever the nodes do. Never throws.
 */
export async function unregisterPushToken(
    account: LeavingAccount,
    communities: readonly string[],
    timeoutMs: number = UNREGISTER_TIMEOUT_MS,
): Promise<void> {
    let token: string | null = null;
    try {
        token = await SecureStore.getItemAsync(PUSH_TOKEN_STORE_KEY);
    } catch (e) {
        console.warn('[Push] Could not read this phone\'s push token to unregister it', e);
    }
    if (!token || !account.privateKey || !account.publicKey) return;

    const body = JSON.stringify({ publicKey: account.publicKey, token });
    await Promise.all(communities.map((community) => unregisterAt(community, body, account, timeoutMs)));
    // The next account fetches the token again when it registers (push-notifications.ts).
    try {
        await SecureStore.deleteItemAsync(PUSH_TOKEN_STORE_KEY);
    } catch (e) {
        console.warn('[Push] Could not forget this phone\'s push token', e);
    }
}

/**
 * Stop the push alerts of the account leaving this phone, on the communities the phone sent its token to (see the file
 * comment), then forget that record: the next account starts its own. Never throws.
 */
export async function stopPushAlerts(account: LeavingAccount | null, storage: Storage = AsyncStorage): Promise<void> {
    if (!account) return;
    await unregisterPushToken(account, await pushRegisteredCommunities(storage));
    await forgetPushRegistrations(storage);
}

/**
 * The communities the leaving account saved, and their cached copies, go from this phone. Removing the list can throw,
 * and a caller decides what that means (Replace: ReplaceNotSaved). A cached copy that can't be removed is logged.
 */
export async function forgetCommunities(communities: readonly string[], storage: Storage = AsyncStorage): Promise<void> {
    try {
        const { removeCommunityCaches } = await import('./community-cache');
        await removeCommunityCaches(communities);
    } catch (e) {
        console.warn('[Account] The cached community copies could not all be removed', e);
    }
    await storage.removeItem(SAVED_NODES_STORE_KEY);
}

/**
 * An account leaves this phone (Sign Out, the self-delete purge, Replace): its push alerts stop, then its communities
 * and their cached copies go. `account` is the leaving account, whose key is still on the phone; with none, only the
 * communities go. The caller then wipes the key and the rest of the account's app storage.
 */
export async function releaseAccountFromPhone(account: LeavingAccount | null, storage: Storage = AsyncStorage): Promise<void> {
    await stopPushAlerts(account, storage);
    await forgetCommunities(await communitiesOnThisPhone(storage), storage);
}

/**
 * "Sign Out (Device Only)", and the phone's half of the self-delete purge once the node has answered (settings.tsx):
 * the open community's tables are dropped, the account is released ({@link releaseAccountFromPhone}), then its key and
 * app storage go (identity.ts `wipeIdentity`).
 */
export async function signOutOfThisPhone(account: LeavingAccount | null): Promise<void> {
    const { clearDB } = await import('./db');
    await clearDB();
    await releaseAccountFromPhone(account);
    await wipeIdentity();
}

/**
 * "Delete this account from this phone" (node-mismatch.tsx): its push alerts stop, then its key and app storage go.
 * The saved communities stay, so the member can pick theirs to recover on.
 */
export async function deleteAccountFromThisPhone(account: LeavingAccount | null): Promise<void> {
    await stopPushAlerts(account);
    await wipeIdentity();
}
