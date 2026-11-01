/**
 * What goes with an account when it leaves this phone, beyond its key and its app storage (identity.ts
 * `wipeIdentityScopedStorage`): its push alerts, and the communities it saved with their cached copies.
 *
 * - Push alerts. The phone registered its push token for the account with every community it keeps, and recorded each
 *   one (push-registrations.ts). The node sends that token the account's chat, escrow and recovery alerts, whose
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
 *   One community going while the key stays (Forget Community, Wipe Connection, alerts off) sends that community alone
 *   the same DELETE and a statement that survives the key being on the phone: {@link unregisterPushTokenAt}.
 * - BeanPool's key vault, in a build that has one: the push token this phone gave it for the account comes out of the
 *   account's copies there, so its recovery notices stop too (utils/vault.ts `withdrawVaultPushToken`), within the
 *   same time and never holding up the leave.
 * - Communities. The list the community switcher shows (`beanpool_saved_nodes`) and each one's cached copy
 *   (community-cache.ts).
 *
 * Sign Out, the self-delete purge at the member's last community on the phone ({@link signOutOfThisPhone},
 * settings.tsx) and Replace (restore-account.ts `saveRestoredAccount`) take both, through
 * {@link releaseAccountFromPhone}. A self-delete at a community while another saved one keeps the key takes neither:
 * only that community leaves the phone, and the key stays (delete-here.ts). The node-mismatch delete
 * ({@link deleteAccountFromThisPhone}, node-mismatch.tsx), offered only when no saved community keeps the key, stops
 * the push alerts and takes every cached copy (the identity leaves, so its group key memory goes, as at Sign Out:
 * director, #1815 review finding 2); the saved list stays, so the member can pick theirs to recover on (welcome.tsx).
 * Restoring the same account, or onto an empty phone, takes nothing (#1183's rule).
 *
 * Every caller runs this BEFORE the key, the push record, the community address or the guest markers are wiped: the
 * unregister and the statements need the key and the record, and the cached copies need the addresses. The statements
 * themselves outlive the wipe.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { communitySwitched } from './community-switch';
import { buildSignedHeaders } from './crypto';
import { wipeIdentity, type BeanPoolIdentity } from './identity';
import { namesPinAddresses, saveNamesCopiesBeforeLeaving, type NamesCopyUnconfirmed, type NamesPinStore } from './names-list';
import { confirmLeave, leaveStatementsSettled, leaveWrittenDown, recordLeave } from './push-leave';
import { markAlertsOff, markAlertsOn } from './push-alerts-off';
import {
    communitiesForAlerts, communityAddress, dropFromRecord, forgetPushRegistrations, leaveNoLongerOwed, leavesOwed, oweLeave,
    pushRegisteredCommunities, resumeRegisteringAt, stopRegistering, stopRegisteringAt,
} from './push-registrations';
import { PUSH_TOKEN_STORE_KEY, SAVED_NODES_STORE_KEY } from './storage-keys';
import { withdrawVaultPushToken } from './vault';

/** How long the whole unregister may take. The requests go out together, so this is also each one's limit. */
export const UNREGISTER_TIMEOUT_MS = 4000;

const PUSH_TOKENS_PATH = '/api/push-tokens';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** The communities this key visited as a guest (nodes.ts `markGuestNode`). */
const GUEST_NODES_STORE_KEY = 'beanpool_guest_nodes';

type LeavingAccount = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

interface WipeStorage {
    getAllKeys(): Promise<readonly string[]>;
}

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
 * The full-screen "Update required"'s "Leave this community" while other communities keep the key
 * (utils/update-block-escape.ts `leaveFromUpdateBlock`): `community` alone is asked to drop this phone's push token
 * for `account`, by the signed DELETE without a leave's stamp (the account stays on the phone, so no leave statement is
 * written: its next sign-in would take one back). Best effort and never awaited by the leave: the community is the one
 * that put the block up, and may be hostile or down. True only when it answered that it took it, or when this phone
 * holds no token (nothing was sent there). Never throws; gives up at `timeoutMs`.
 */
export async function stopPushAlertsAt(
    account: LeavingAccount, community: string, timeoutMs: number = UNREGISTER_TIMEOUT_MS,
): Promise<boolean> {
    const base = communityAddress(community);
    if (!base || !account.publicKey || !account.privateKey) return false;
    let token: string | null = null;
    try {
        token = await SecureStore.getItemAsync(PUSH_TOKEN_STORE_KEY);
    } catch {
        return false;
    }
    if (!token) return true;
    return unregisterAt(base, JSON.stringify({ publicKey: account.publicKey, token }), account, timeoutMs);
}

/**
 * One community lets this phone's push token go while `account` stays on the phone: that community alone, and never
 * {@link stopRegistering}, which would stop the key's registrations everywhere (design R2). No registration goes out
 * there from now until {@link resumeRegisteringAt}, and one on its way is waited for; a statement that survives the key
 * being on the phone is written down (push-leave.ts, `keyStays`); the signed DELETE goes with its stamp, and the statement
 * is crossed off if the community took it, or else presented until it does. The community then comes off the record: the
 * statement speaks for it, and a later Sign Out need not ask again. It stays on the record only when nothing will speak
 * for it, the DELETE having failed with no statement written down: each later return tries again
 * ({@link retryLeavesOwed}), and a later Sign Out asks it. The phone's token stays: every other community still holds it.
 * Nothing is sent to a community that isn't on the record: the DELETE carries the token, and a community this phone never
 * sent it to is never sent it (#1184 review 4110460184; one only looked at as a guest, say). Nor when the phone never got
 * a token. True once the community is dealt with. Never throws; the DELETE gives up at `timeoutMs`, and one registration
 * already on its way first finishes within its own timeout.
 */
export async function unregisterPushTokenAt(
    account: LeavingAccount, community: string, timeoutMs: number = UNREGISTER_TIMEOUT_MS,
): Promise<boolean> {
    const base = communityAddress(community);
    if (!base || !account.publicKey || !account.privateKey) return false;
    await stopRegisteringAt(account.publicKey, base);
    // After the wait: a registration on its way recorded its community before it went out.
    if (!(await pushRegisteredCommunities()).includes(base)) return true;
    let token: string | null = null;
    try {
        token = await SecureStore.getItemAsync(PUSH_TOKEN_STORE_KEY);
    } catch (e) {
        console.warn(`[Push] Could not read this phone's push token to unregister it at ${base}`, e);
        await oweLeave(base);
        return false;
    }
    if (!token) {
        await dropFromRecord([base]);
        return true;
    }
    const [statement] = await recordLeave(account, token, [base], AsyncStorage, true);
    const body = JSON.stringify({ publicKey: account.publicKey, token, ...(statement ? { leftAt: statement.leftAt } : {}) });
    const took = await unregisterAt(base, body, account, timeoutMs);
    if (took && statement) await confirmLeave(statement);
    if (!took && !(statement && await leaveWrittenDown(statement))) {
        await oweLeave(base);
        return false;
    }
    await dropFromRecord([base]);
    return true;
}

/**
 * The app comes back (push-registrations.ts `registerWhereMissing`): each community {@link unregisterPushTokenAt} could
 * not reach is tried again with `account`, the one on the phone, unless it is wanted again by now (the member rejoined it,
 * or turned its alerts back on). That one owes nothing, and stays on the record, where its registration still is.
 * Never throws.
 */
export async function retryLeavesOwed(account: LeavingAccount): Promise<void> {
    try {
        const wanted = await communitiesForAlerts(AsyncStorage);
        await Promise.all((await leavesOwed()).map(async (base) => {
            if (wanted.includes(base)) {
                await leaveNoLongerOwed(base);
                return;
            }
            try {
                if (await unregisterPushTokenAt(account, base)) await leaveNoLongerOwed(base);
            } finally {
                resumeRegisteringAt(account.publicKey, base);
            }
        }));
    } catch (e) {
        console.warn('[Push] Could not try the communities still owed a leave again', e);
    }
}

/**
 * The member lets `community` go from this phone (Forget Community, Wipe Connection, the sheet's Remove, the deep link's
 * Wipe & Join Fresh): it is told to drop this phone's token first ({@link unregisterPushTokenAt}), then
 * `removeFromPhone` takes its row and its copy, as ever, and its alerts choice goes, so a rejoin starts from the default.
 * No registration goes out there until that is done, however long the removal takes: the phone may stay set to it until
 * the removal moves it on. A phone with no account just removes. Throws what `removeFromPhone` throws.
 */
export async function forgetCommunityPush(
    account: LeavingAccount | null | undefined, community: string, removeFromPhone: () => Promise<void>,
): Promise<void> {
    const base = communityAddress(community);
    if (!account?.publicKey || !account.privateKey || !base) {
        await removeFromPhone();
        return;
    }
    try {
        await unregisterPushTokenAt(account, base);
        await removeFromPhone();
        await markAlertsOn(base).catch((e) => console.warn(`[Push] Could not clear the alerts choice for ${base}`, e));
    } finally {
        resumeRegisteringAt(account.publicKey, base);
    }
}

/**
 * The per-community switch turned off (design R8; the sheet's switch is its own slice): `community` goes on the alerts-off
 * list, then it is told to drop this phone's token ({@link unregisterPushTokenAt}). Throws, with nothing sent, when the
 * list can't be written. Turning it on again is `markAlertsOn`, then a registration where it is missing
 * (services/push-notifications.ts `turnAlertsOnAt`).
 */
export async function turnAlertsOffAt(account: LeavingAccount, community: string): Promise<void> {
    const base = communityAddress(community);
    if (!base) return;
    await markAlertsOff(base);
    try {
        await unregisterPushTokenAt(account, base);
    } finally {
        resumeRegisteringAt(account.publicKey, base);
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
    const communities = await pushRegisteredCommunities(storage);
    // BeanPool's key vault sends the account's recovery notices to the phones in its copies: this phone comes out too,
    // alongside the communities and within the same time (utils/vault.ts `withdrawVaultPushToken`).
    await Promise.all([
        unregisterPushToken(account, communities),
        withdrawVaultPushToken(account, UNREGISTER_TIMEOUT_MS),
    ]);
    await forgetPushRegistrations(storage);
}

/**
 * The communities the leaving account saved, and their cached copies, go from this phone, with every other community copy
 * on it (a community a Wipe left is no longer listed, and its file keeps that identity's group key memory: community-
 * cache.ts `everyCopy`). Removing the list can throw, and a caller decides what that means (Replace: ReplaceNotSaved). A
 * cached copy that can't be removed is logged.
 */
export async function forgetCommunities(communities: readonly string[], storage: Storage = AsyncStorage, opts: LeaveOptions = {}): Promise<void> {
    await removeEveryCommunityCopy(communities, opts.keepDmMemoryOf);
    await storage.removeItem(SAVED_NODES_STORE_KEY);
}

/**
 * `keepDmMemoryOf`: Sign Out's leaving key, while it is still on the phone. The DM pins kept for it (dm-peer-pins.ts, kept
 * when the account leaves, pick 2) first take what this phone held in each community file never seeded since the update
 * (§3.4 amendment 6 §5), so signing in again doesn't meet those DMs as first sight. Replace and the purge leave it out.
 */
interface LeaveOptions { keepDmMemoryOf?: string | null }

/**
 * Every community copy on this phone goes, listed or not (community-cache.ts `everyCopy`); one that can't is logged.
 * `keepDmMemoryOf`: {@link LeaveOptions}; a seed that throws is logged and never holds up the leave.
 */
async function removeEveryCommunityCopy(communities: readonly string[], keepDmMemoryOf?: string | null): Promise<void> {
    try {
        const { removeCommunityCaches } = await import('./community-cache');
        const beforeRemoving = keepDmMemoryOf
            ? async (copies: string[]) => { const { seedDmPinsBeforeLeaving } = await import('./db'); await seedDmPinsBeforeLeaving(keepDmMemoryOf, copies); }
            : undefined;
        await removeCommunityCaches(communities, { everyCopy: true, beforeRemoving });
    } catch (e) {
        console.warn('[Account] The cached community copies could not all be removed', e);
    }
}

/**
 * An account leaves this phone (Sign Out, the self-delete purge at its last community, Replace): its push alerts stop,
 * every tool's data goes ({@link wipeToolData}), then its communities and their cached copies go. `account` is the
 * leaving account, whose key is still on the phone; with none, only the tools' data and the communities go. The caller
 * then wipes the key and the rest of the account's app storage.
 */
export async function releaseAccountFromPhone(account: LeavingAccount | null, storage: Storage = AsyncStorage, opts: LeaveOptions = {}): Promise<void> {
    await stopPushAlerts(account, storage);
    await wipeToolData();
    await forgetCommunities(await communitiesOnThisPhone(storage), storage, opts);
}

/**
 * Every tool's documents, photos, reminders and settings (tools/store.ts `wipeToolDataOnThisPhone`): no row, no file,
 * and no reminder that fires for an account that has gone. Here for Replace, which never reaches identity.ts
 * `wipeIdentity` (Sign Out does that too, and a second time finds nothing). Before the communities, whose removal can
 * throw. Never throws.
 */
async function wipeToolData(): Promise<void> {
    try {
        const { wipeToolDataOnThisPhone } = await import('../tools/store');
        await wipeToolDataOnThisPhone();
    } catch (e) {
        console.error('Failed to wipe the tools\' data on this phone', e);
    }
}

/**
 * Before Sign Out wipes them (identity.ts `wipeIdentityScopedStorage`): each names-list pin this key keeps on the phone has
 * its locked copy saved on the node and confirmed (names-list.ts `saveNamesCopiesBeforeLeaving`, design §5). Returns the
 * ones not confirmed, for the words (a store that fails counts as one); never throws and never blocks.
 */
export async function namesCopiesBeforeSignOut(
    account: LeavingAccount | null, storage: Pick<WipeStorage, 'getAllKeys'> = AsyncStorage, store?: NamesPinStore,
): Promise<NamesCopyUnconfirmed[]> {
    if (!account?.publicKey || !account.privateKey) return [];
    try {
        const anchors = namesPinAddresses(await storage.getAllKeys(), account.publicKey);
        if (!anchors.length) return [];
        return await saveNamesCopiesBeforeLeaving(account as BeanPoolIdentity, anchors, store);
    } catch (e) {
        console.warn('[Names] The names-list copies could not be saved before Sign Out', e instanceof Error ? e.message : e);
        return [{ anchor: '', onlyKey: null }];
    }
}

/**
 * "Sign Out (Device Only)", and the phone's half of the self-delete purge at the member's last community on the phone
 * once the node has answered (settings.tsx, delete-here.ts `planDelete`):
 * the open community's tables are dropped, the account is released ({@link releaseAccountFromPhone}), then its key and
 * app storage go (identity.ts `wipeIdentity`).
 */
export async function signOutOfThisPhone(account: LeavingAccount | null, opts: { namesCopiesSaved?: boolean; purge?: boolean } = {}): Promise<void> {
    // The names list's pins go with the wipe: their locked copies are saved on the node first (best effort; Settings asks
    // before this and passes `namesCopiesSaved`, so the copies aren't saved twice).
    if (!opts.namesCopiesSaved) await namesCopiesBeforeSignOut(account);
    const db = await import('./db');
    // Sign Out keeps the account's DM pins (pick 2): the open community's are seeded before its tables go, and every other
    // file's before it is deleted (§3.4 amendment 6 §5). Never a reason Sign Out stops. The purge (`purge`) skips it.
    const keepDmMemoryOf = !opts.purge ? account?.publicKey ?? null : null;
    if (keepDmMemoryOf) {
        try {
            await db.seedDmPinsHere(keepDmMemoryOf);
        } catch (e) {
            console.warn('[Account] The open community\'s DM memory could not be kept', e);
        }
    }
    const { clearDB } = db;
    // The identity leaves this phone: what it knew of its groups' keys goes with it (utils/db.ts clearDB).
    await clearDB({ identityLeaves: true });
    await releaseAccountFromPhone(account, AsyncStorage, { keepDmMemoryOf });
    await wipeIdentity();
    // No community and no account on the phone now: the update screen's block, if one was up, comes down
    // (utils/community-switch.ts).
    communitySwitched();
}

/**
 * "Delete this account from this phone" (node-mismatch.tsx), once no saved community keeps the key (delete-here.ts
 * `otherCommunitiesKeeping`): its push alerts stop; the identity leaves this phone, so, as at Sign Out, the open
 * community's tables are dropped and every cached copy goes, and with them what it knew of its groups' keys in every
 * community file (director, #1815 review finding 2); then its key and app storage go. The saved communities stay, so
 * the member can pick theirs to recover on.
 */
export async function deleteAccountFromThisPhone(account: LeavingAccount | null): Promise<void> {
    await stopPushAlerts(account);
    const { clearDB } = await import('./db');
    await clearDB({ identityLeaves: true });
    await removeEveryCommunityCopy(await communitiesOnThisPhone());
    await wipeIdentity();
    communitySwitched();
}
