/**
 * Delete account leaves only the community the phone is set to (Marty, 2026-09-29): "delete here, keep your key for
 * your other communities; the key is wiped only when you delete at your last one."
 *
 * One key serves every community on the phone (single identity per device). Before, Settings' Permanently Delete Account
 * deleted the account at the community the phone is set to and then wiped the phone as Sign Out does, so a member of
 * several communities lost the key for all of them. Now:
 *
 * - The phone first asks each other community it saved whether the key is a member there ({@link planDelete}), as the
 *   phone asks its own community (app/NodeStatusContext.tsx). A community that can't be reached, or answers oddly,
 *   counts as one the key is still a member of: a poor connection never costs the member their key.
 * - Some other community keeps the key: the node deletes the account here (unchanged, server `purgeMemberSelf`), then
 *   this community leaves the phone ({@link leaveThisCommunity}) and the phone moves to one of the others. The key and
 *   the 12 words stay.
 * - None does: this is the member's last community on the phone, and the delete wipes it as before
 *   (account-leaves-phone.ts `signOutOfThisPhone`).
 *
 * The node-mismatch screen asks the same question ({@link otherCommunitiesKeeping}): its delete takes the key off the
 * phone only when no saved community keeps it.
 *
 * Only a saved community whose address is plain (node-url.ts) is asked: the phone never connects to any other, nor
 * switches to one.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signOutOfThisPhone } from './account-leaves-phone';
import { communityName } from './community-name';
import type { BeanPoolIdentity } from './identity';
import { PURGE_TIMEOUT_MS, anchorUrl, purgeAccountOnNode } from './node-post';
import { assertPlainNodeAddress, isPlainNodeAddress } from './node-url';
import { communityAddress, dropFromRecord } from './push-registrations';
import { SAVED_NODES_STORE_KEY } from './storage-keys';

/** How long each community has to answer, as the phone's own membership check (NodeStatusContext). */
export const MEMBERSHIP_TIMEOUT_MS = 8000;

const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** The communities this key visited as a guest (nodes.ts `markGuestNode`). */
const GUEST_NODES_STORE_KEY = 'beanpool_guest_nodes';

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * What a community answered about the key. 'stranger' only when it said so plainly (`isMember: false` and not
 * recovering); no answer, an error, a timeout or an answer that isn't the membership route's is 'unreachable'.
 */
export type Membership = 'member' | 'stranger' | 'unreachable';

/** Another community on the phone that keeps the key: it said the key is a member, or it could not be asked. */
export interface KeptCommunity {
    /** The address as the phone saved it. */
    url: string;
    name: string;
    membership: 'member' | 'unreachable';
}

export type DeletePlan =
    /** Other communities keep the key: the delete leaves this one and the phone moves to `next`. */
    | { kind: 'this-one'; here: string; hereName: string; keeps: KeptCommunity[]; next: KeptCommunity }
    /** The member's last community on this phone: the delete wipes the phone. */
    | { kind: 'last'; here: string; hereName: string };

/**
 * GET /api/community/membership/<key> at `community`, as NodeStatusContext asks it. Never throws; gives up at
 * `timeoutMs`.
 */
export async function membershipAt(community: string, publicKey: string, timeoutMs: number = MEMBERSHIP_TIMEOUT_MS): Promise<Membership> {
    const base = communityAddress(community);
    if (!base) return 'unreachable';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/api/community/membership/${publicKey}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!res.ok) return 'unreachable';
        const data: unknown = await res.json();
        if (!data || typeof data !== 'object') return 'unreachable';
        const { isMember, isRecovering } = data as { isMember?: unknown; isRecovering?: unknown };
        if (isMember === true || isRecovering === true) return 'member';
        return isMember === false ? 'stranger' : 'unreachable';
    } catch {
        return 'unreachable';
    } finally {
        clearTimeout(timer);
    }
}

interface SavedEntry {
    url: string;
    alias?: string;
}

/** The phone's saved list, read only (nodes.ts `getSavedNodes` writes the anchor back into it). Throws when unreadable. */
async function savedCommunities(storage: Pick<Storage, 'getItem'>): Promise<SavedEntry[]> {
    const raw = await storage.getItem(SAVED_NODES_STORE_KEY);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? '[]');
    } catch {
        // A list that can't be parsed is none, as the community switcher shows it.
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((n): SavedEntry[] => {
        if (!n || typeof n !== 'object') return [];
        const { url, alias } = n as { url?: unknown; alias?: unknown };
        return typeof url === 'string' ? [{ url, alias: typeof alias === 'string' ? alias : undefined }] : [];
    });
}

/**
 * The saved communities other than `here` that keep the key, each asked once and all together, in the saved list's
 * order: the ones where it is a member, and the ones that could not be asked. Only plain addresses (node-url.ts).
 * Throws when the phone's storage can't be read, so a caller never takes an unread list for an empty one.
 */
export async function otherCommunitiesKeeping(
    here: string | null,
    publicKey: string,
    storage: Pick<Storage, 'getItem'> = AsyncStorage,
    timeoutMs: number = MEMBERSHIP_TIMEOUT_MS,
): Promise<KeptCommunity[]> {
    const hereAddress = communityAddress(here);
    const seen = new Set<string>(hereAddress ? [hereAddress] : []);
    const others: SavedEntry[] = [];
    for (const n of await savedCommunities(storage)) {
        const address = communityAddress(n.url);
        if (!address || seen.has(address) || !isPlainNodeAddress(n.url)) continue;
        seen.add(address);
        others.push(n);
    }
    const answers = await Promise.all(others.map((n) => membershipAt(n.url, publicKey, timeoutMs)));
    return others.flatMap((n, i): KeptCommunity[] => {
        const membership = answers[i];
        return membership === 'stranger' ? [] : [{ url: n.url, name: communityName(n), membership }];
    });
}

/**
 * What Delete account will do on this phone, asked before the member confirms so the confirmation can say it. Throws
 * when the phone isn't set to a community or its storage can't be read: nothing is deleted then.
 */
export async function planDelete(
    publicKey: string,
    storage: Pick<Storage, 'getItem'> = AsyncStorage,
    timeoutMs: number = MEMBERSHIP_TIMEOUT_MS,
): Promise<DeletePlan> {
    const here = await storage.getItem(ANCHOR_STORE_KEY);
    if (!here || !communityAddress(here)) throw new Error('This phone is not set to a community.');
    const saved = await savedCommunities(storage);
    const hereAddress = communityAddress(here);
    const hereName = communityName(saved.find((n) => communityAddress(n.url) === hereAddress) ?? { url: here });
    const keeps = await otherCommunitiesKeeping(here, publicKey, storage, timeoutMs);
    if (keeps.length === 0) return { kind: 'last', here, hereName };
    // A community that said the key is a member before one that couldn't be asked.
    const next = keeps.find((c) => c.membership === 'member') ?? keeps[0];
    return { kind: 'this-one', here, hereName, keeps, next };
}

/** `names` as one phrase: "A", "A and B", "A, B and C". */
export function listNames(names: readonly string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ── What the app says ───────────────────────────────────────────────────────────────────────────────────────────

/** Settings' Permanently Delete Account card, before the other communities are asked. */
export const DELETE_CARD_LINE =
    'Permanently deletes your account at this community. Cancels your posts there, clears its push alerts, and settles ' +
    'your balance with its Commons Pool. If this phone has other communities you are a member of, it keeps your key ' +
    'for them. At your last one, it clears this phone.';

/** While the other communities are asked. */
export const DELETE_CHECKING_LINE = 'Checking your other communities on this phone…';

/** The way to take the key off the phone without deleting anything, which stays where it was. */
export const SIGN_OUT_INSTEAD_LINE = 'To take BeanPool off this phone altogether, use Sign Out (Device Only).';

/** The asking failed (Settings, and the not-recognised screen): nothing has been deleted. */
export function deletePlanFailedLine(reason: string): string {
    return `Couldn't check your other communities on this phone (${reason}). Nothing has been deleted. Try again.`;
}

/** The communities that couldn't be asked, said as kept: empty when every one answered. */
function unaskedLine(keeps: readonly KeptCommunity[]): string[] {
    const unasked = keeps.filter((c) => c.membership === 'unreachable').map((c) => c.name);
    if (unasked.length === 0) return [];
    return [unasked.length === 1
        ? `${unasked[0]} couldn't be reached, so it counts as a community you are still in.`
        : `${listNames(unasked)} couldn't be reached, so they count as communities you are still in.`];
}

/** What stays when other communities keep the key: under the purge warning, and in its confirmation. */
export function keepsKeyLine(plan: Extract<DeletePlan, { kind: 'this-one' }>, hasWords: boolean): string {
    const what = hasWords ? 'Your key and 12 words stay' : 'Your key stays';
    return [
        `${what} on this phone, for ${listNames(plan.keeps.map((c) => c.name))}.`,
        `${plan.hereName} goes from this phone's list, with its copy on this phone, and the app opens ${plan.next.name}.`,
        ...unaskedLine(plan.keeps),
    ].join(' ');
}

/**
 * The not-recognised screen (node-mismatch.tsx), when another saved community keeps the key: the delete isn't offered,
 * and the screen says why and where to go.
 */
export function stillKeptLine(keeps: readonly KeptCommunity[]): string {
    const members = keeps.filter((c) => c.membership === 'member').map((c) => c.name);
    return [
        ...(members.length > 0 ? [`You are still a member of ${listNames(members)}.`] : []),
        ...unaskedLine(keeps),
        'Deleting this account from this phone would lose it there too, so this phone keeps it.',
        `Switch to ${keeps.length === 1 ? 'it' : 'one of them'} instead.`,
    ].join(' ');
}

/** The not-recognised screen's confirmation, once no saved community keeps the key. */
export const NO_OTHER_COMMUNITY_LINE =
    "No other community saved on this phone has you as a member. This still erases the key for every community, " +
    "including any this phone doesn't list.";

/** Under {@link stillKeptLine}: the way to take the key off the phone anyway, which stays in Settings. */
export const SIGN_OUT_FROM_SETTINGS_LINE =
    'To take BeanPool off this phone altogether, switch, then use Settings → Account Deletion & Sign Out → Sign Out (Device Only).';

/** The last community on the phone: the key goes too. */
export function lastCommunityLine(plan: Extract<DeletePlan, { kind: 'last' }>, hasWords: boolean): string {
    return hasWords
        ? `${plan.hereName} is the last community on this phone where you are a member, so this phone's key and 12 ` +
          'words go too. Only go ahead if you have written your 12 words down: they are the way back into any other ' +
          'community you belong to.'
        : `${plan.hereName} is the last community on this phone where you are a member, so this phone's key goes too.`;
}

const keyAnd = (hasWords: boolean) => (hasWords ? "This phone's key and 12 words" : "This phone's key");

/** The node deleted the account, but the phone could not finish (delete-here.ts, or the wipe at the last one). */
export function deletedButLine(hereName: string, reason: string, keyStays: boolean, hasWords: boolean): string {
    return keyStays
        ? `Your account at ${hereName} was deleted, but this phone couldn't finish moving on (${reason}). ` +
          `${keyAnd(hasWords)} ${hasWords ? 'are' : 'is'} still on it.`
        : `Your account at ${hereName} was deleted, but this phone couldn't be cleared (${reason}). Use Sign Out ` +
          '(Device Only) to finish.';
}

/** The node did not delete the account: nothing on the phone changed. */
export function deleteFailedLine(reason: string, hasWords: boolean): string {
    return `${reason}\n\n${keyAnd(hasWords)} ${hasWords ? 'were' : 'was'} not touched.`;
}

/**
 * The phone's half of a delete that leaves the key ({@link DeletePlan} 'this-one'), once `here` has deleted the account:
 * - `here` comes off the push record. Its node dropped the key's push tokens with the account, so the phone never
 *   asks it again (push-registrations.ts `dropFromRecord`).
 * - Its cached copy goes (community-cache.ts, which closes the open copy first).
 * - The phone is set to `next`, then `here` leaves the saved list and the guest markers. In that order: the saved list,
 *   read through nodes.ts `getSavedNodes`, puts the community the phone is set to back into it.
 *
 * The key, its 12 words and the rest of the account's app storage stay. The caller opens `next`'s copy (db.ts `initDB`)
 * and moves the screen. Throws, before anything changes, for a `next` whose address isn't plain (node-url.ts; the plan
 * never picks one), and when the phone can't be set to `next`; everything else is logged.
 */
export async function leaveThisCommunity(here: string, next: string, storage: Storage = AsyncStorage): Promise<void> {
    assertPlainNodeAddress(next);
    await dropFromRecord([here], storage);
    try {
        const { removeCommunityCaches } = await import('./community-cache');
        await removeCommunityCaches([here]);
    } catch (e) {
        console.warn('[Account] The cached copy of the community left could not be removed', e);
    }
    await storage.setItem(ANCHOR_STORE_KEY, next);

    const hereAddress = communityAddress(here);
    const isHere = (url: unknown) => communityAddress(url) === hereAddress;
    try {
        const raw = await storage.getItem(SAVED_NODES_STORE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed)) {
            const kept = parsed.filter((n) => !(n && typeof n === 'object' && isHere((n as { url?: unknown }).url)));
            await storage.setItem(SAVED_NODES_STORE_KEY, JSON.stringify(kept));
        }
    } catch (e) {
        console.warn('[Account] The community left could not be taken off the saved list', e);
    }
    try {
        const raw = await storage.getItem(GUEST_NODES_STORE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (Array.isArray(parsed) && parsed.some(isHere)) {
            await storage.setItem(GUEST_NODES_STORE_KEY, JSON.stringify(parsed.filter((u) => !isHere(u))));
        }
    } catch (e) {
        console.warn('[Account] The guest marker of the community left could not be removed', e);
    }
}

/** What {@link deleteAccountHere} did. */
export type DeleteOutcome =
    /** The node did not delete the account (it refused, or never answered): nothing on the phone changed. */
    | { kind: 'not-deleted'; reason: string }
    /** Deleted here; this community left the phone and the phone is set to the plan's `next`. The key stays. */
    | { kind: 'left' }
    /** Deleted here, but the phone could not finish moving on. The key stays. */
    | { kind: 'left-unfinished'; reason: string }
    /** Deleted at the member's last community, and the phone wiped as Sign Out wipes it. */
    | { kind: 'wiped' }
    /** Deleted at the last community, but the wipe did not finish. */
    | { kind: 'wipe-unfinished'; reason: string };

const reasonOf = (e: unknown) => (e instanceof Error && e.message ? e.message : String(e));

/**
 * Settings' Permanently Delete Account, once the member confirmed `plan` ({@link planDelete}): the node deletes the
 * account here (node-post.ts `purgeAccountOnNode`), and only once it has answered `{ ok: true }` within
 * `purgeTimeoutMs`, the phone does what the
 * plan says. Other communities keep the key: {@link leaveThisCommunity}, then the next one's copy is opened. The last
 * one: account-leaves-phone.ts `signOutOfThisPhone`. Never throws.
 *
 * The phone must still be set to the community the plan was made for: purgeAccountOnNode deletes at the one it is set
 * to.
 */
export async function deleteAccountHere(
    identity: BeanPoolIdentity, plan: DeletePlan, purgeTimeoutMs: number = PURGE_TIMEOUT_MS,
): Promise<DeleteOutcome> {
    try {
        if (communityAddress(await anchorUrl()) !== communityAddress(plan.here)) {
            return { kind: 'not-deleted', reason: 'This phone changed community. Open Delete account again.' };
        }
        // Only the node's `{ ok: true }` counts, and a node that doesn't answer within the timeout is a not-deleted.
        await purgeAccountOnNode(identity, purgeTimeoutMs);
    } catch (e) {
        return { kind: 'not-deleted', reason: reasonOf(e) };
    }

    if (plan.kind === 'this-one') {
        try {
            await leaveThisCommunity(plan.here, plan.next.url);
            const { initDB } = await import('./db');
            await initDB();
        } catch (e) {
            return { kind: 'left-unfinished', reason: reasonOf(e) };
        }
        return { kind: 'left' };
    }

    try {
        // This community dropped the key's push tokens with the account; the other communities it registered with are
        // asked there.
        await signOutOfThisPhone(identity);
    } catch (e) {
        return { kind: 'wipe-unfinished', reason: reasonOf(e) };
    }
    return { kind: 'wiped' };
}
