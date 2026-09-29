/**
 * What goes with an account when it leaves this phone, beyond its key and its app storage (identity.ts
 * `wipeIdentityScopedStorage`): its push alerts, and the communities it saved with their cached copies.
 *
 * - Push alerts. The phone registered its push token for the account with the community it was set to, and recorded
 *   each one (push-registrations.ts). The node sends that token the account's chat, escrow and recovery alerts, whose
 *   text can carry names and message previews. Left registered, the phone goes on getting them after Sign Out and after
 *   "Replace this phone's account". So each community on the record is asked to drop the token, signed by the account's
 *   own key while the phone still holds it, and no other: a community this phone never sent the token to is never sent
 *   it. First nothing more registers for the key, and a registration already on its way is waited for
 *   (push-registrations.ts `stopRegistering`), so it can't land after the leave. Then the phone signs a leave statement
 *   for each of those communities and writes it down (push-leave.ts), and sends each the signed DELETE with the leave's
 *   stamp, with a short timeout: a node that can't be reached never holds up or fails the member's Sign Out or Replace.
 *   A community that took the DELETE has its statement crossed off; every other one is presented later, when the app
 *   starts or comes back, until it is confirmed. The node never drops a key's row because another key registered the
 *   same token: any community that holds the token could then silence a member's recovery alerts (server
 *   state-engine.ts `registerPushToken`, #1184 review 4110460184).
 * - Communities. The list the community switcher shows (`beanpool_saved_nodes`) and each one's cached copy
 *   (community-cache.ts).
 *
 * Sign Out, the self-delete purge at the member's last community on the phone ({@link signOutOfThisPhone},
 * settings.tsx) and Replace (restore-account.ts `saveRestoredAccount`) take both, through
 * {@link releaseAccountFromPhone}. A self-delete at a community while another saved one keeps the key takes neither:
 * only that community leaves the phone, and the key stays (delete-here.ts). The node-mismatch delete
 * ({@link deleteAccountFromThisPhone}, node-mismatch.tsx), offered only when no saved community keeps the key, stops
 * the push alerts only: there the communities stay, as before, so the member can pick theirs to recover on
 * (welcome.tsx). Restoring the same account, or onto an empty phone, takes nothing (#1183's rule).
 *
 * Every caller runs this BEFORE the key, the push record, the community address or the guest markers are wiped: the
 * unregister and the statements need the key and the record, and the cached copies need the addresses. The statements
 * themselves outlive the wipe.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { buildSignedHeaders } from './crypto';
import { wipeIdentity, type BeanPoolIdentity } from './identity';
import { confirmLeave, leaveStatementsSettled, recordLeave } from './push-leave';
import { communityAddress, forgetPushRegistrations, pushRegisteredCommunities, stopRegistering } from './push-registrations';
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

/**
 * One community's DELETE /api/push-tokens, signed by the leaving key. Never throws; gives up at the deadline. True when
 * the community answered that it took it, in the route's own words (`{ success: true }`): any other 2xx, a captive
 * portal's sign-in page on a plain-http address say, never reached it.
 */
async function unregisterAt(community: string, body: string, account: LeavingAccount, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(false);
        }, timeoutMs);
    });
    const attempt = (async () => {
        try {
            const url = `${community}${PUSH_TOKENS_PATH}`;
            const headers = await buildSignedHeaders('DELETE', url, body, account.privateKey, account.publicKey);
            const res = await fetch(url, { method: 'DELETE', headers, body, signal: controller.signal });
            const answer: { success?: unknown } | undefined = await res.json().catch(() => undefined);
            const took = res.ok && answer?.success === true;
            if (!took) console.warn(`[Push] ${community} did not unregister this phone (${res.status})`);
            return took;
        } catch (e) {
            console.warn(`[Push] Could not reach ${community} to unregister this phone:`, e instanceof Error ? e.message : e);
            return false;
        }
    })();
    try {
        return await Promise.race([attempt, deadline]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Unregister this phone's push token for `account` on each of `communities`, signed by that account's key. First no
 * registration goes out for the key any more and one on its way is waited for; then the leave statements are written
 * down (push-leave.ts `recordLeave`), then each community is sent the signed DELETE with the leave's stamp, and its
 * statement is crossed off if it took it. Nothing to do when the phone never got a token (a simulator, Expo Go,
 * permission refused). All together, and done within `timeoutMs` of the DELETEs going out whatever the nodes do (a
 * registration already on its way first finishes within its own timeout). Never throws.
 */
export async function unregisterPushToken(
    account: LeavingAccount,
    communities: readonly string[],
    timeoutMs: number = UNREGISTER_TIMEOUT_MS,
): Promise<void> {
    if (!account.publicKey) return;
    await stopRegistering(account.publicKey);
    let token: string | null = null;
    try {
        token = await SecureStore.getItemAsync(PUSH_TOKEN_STORE_KEY);
    } catch (e) {
        console.warn('[Push] Could not read this phone\'s push token to unregister it', e);
    }
    if (!token || !account.privateKey) return;

    const statements = await recordLeave(account, token, communities);
    const leftAt = statements[0]?.leftAt;
    const body = JSON.stringify({ publicKey: account.publicKey, token, ...(leftAt ? { leftAt } : {}) });
    await Promise.all(communities.map(async (community) => {
        if (!await unregisterAt(community, body, account, timeoutMs)) return;
        const statement = statements.find((s) => s.community === communityAddress(community));
        if (statement) await confirmLeave(statement);
    }));
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
    // Before the record is read, so that no registration can put another community on it afterwards.
    if (account.publicKey) await stopRegistering(account.publicKey);
    // And after the account's sign-in has taken back its old statements, whose communities that puts back on it.
    await leaveStatementsSettled();
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
 * An account leaves this phone (Sign Out, the self-delete purge at its last community, Replace): its push alerts stop,
 * then its communities and their cached copies go. `account` is the leaving account, whose key is still on the phone;
 * with none, only the communities go. The caller then wipes the key and the rest of the account's app storage.
 */
export async function releaseAccountFromPhone(account: LeavingAccount | null, storage: Storage = AsyncStorage): Promise<void> {
    await stopPushAlerts(account, storage);
    await forgetCommunities(await communitiesOnThisPhone(storage), storage);
}

/**
 * "Sign Out (Device Only)", and the phone's half of the self-delete purge at the member's last community on the phone
 * once the node has answered (settings.tsx, delete-here.ts `planDelete`):
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
 * "Delete this account from this phone" (node-mismatch.tsx), once no saved community keeps the key (delete-here.ts
 * `otherCommunitiesKeeping`): its push alerts stop, then its key and app storage go. The saved communities stay, so
 * the member can pick theirs to recover on.
 */
export async function deleteAccountFromThisPhone(account: LeavingAccount | null): Promise<void> {
    await stopPushAlerts(account);
    await wipeIdentity();
}
