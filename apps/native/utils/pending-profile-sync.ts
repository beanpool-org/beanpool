import AsyncStorage from '@react-native-async-storage/async-storage';
import { plainOriginOf } from './node-url';
import { PENDING_PROFILE_STORE_PREFIX } from './storage-keys';

/**
 * A profile change waiting to reach a community, kept for THAT community.
 *
 * The member's name, photo and bio in a community are its row there (db.ts updateMemberProfile writes the copy open). A
 * Save that can't reach the community (offline, or the node unreachable) is published later by pillar-sync's retry
 * (db.ts pushProfileToServer). This used to be one flag for the phone (`pending_profile_sync`), with the photo parked
 * beside it (`pending_profile_avatar`), and the retry published the row of whichever community was open. So a rename
 * made in A while offline, then a switch to B: B's sync published B's row with A's photo and cleared the flag. A never
 * got the change, and its next answer put the old name back.
 *
 * So each community has its own entry, under its address in one spelling (node-url.ts plainOriginOf, as its copy is
 * named), holding what changed there that its row can't keep until the community has it:
 *   - `callsign`: a new name. The members sync writes the name the node still holds over the row (db.ts applyDelta),
 *     so the row alone would give the retry the old name back.
 *   - `avatar`: a photo picked there (a portable value, avatar-value.ts). The same sync writes the node's photo URL
 *     over it.
 * The bio and contact are in the row, which no sync writes over, and the retry reads them from there. An entry with
 * neither still says a change is waiting there: the retry publishes that community's row.
 *
 * Each entry names the account it was made under, and is read only for that account: a change is never sent under
 * another key. It is published only to its own community (pushProfileToServer reads the entry of the community it
 * publishes to) and cleared only when that community has accepted it, when the community leaves the phone (nodes.ts
 * removeSavedNode, delete-here.ts, update-block-escape.ts), or with the account (identity.ts wipeIdentityScopedStorage).
 * A community followed to its new address takes its entry there (address-follow.ts).
 *
 * A phone updated from a build with the one flag: the flag moves to the entry of the community it was set in
 * (`pending_profile_sync_anchor`, written by the settings Save since #2439), with the photo parked beside it, or is
 * dropped when it names none (the wizard and the first join never wrote one). It is never applied to whichever
 * community is open.
 */

export interface PendingProfileChange {
    /** The account it was made under. */
    publicKey: string;
    /** A new name the community hasn't accepted yet. */
    callsign?: string;
    /** A photo picked there that the community hasn't accepted yet. */
    avatar?: string;
}

/** What the screens hand over: a field left out (or null) is not part of this change. */
export interface ProfileChange {
    callsign?: string | null;
    avatar?: string | null;
}

/** Enough of AsyncStorage for one entry; a leave that runs on storage of its own passes that. */
export interface PendingProfileStorage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/** The keys an older build kept, one each for the phone. */
const OLDER_FLAG = 'pending_profile_sync';
const OLDER_ANCHOR = 'pending_profile_sync_anchor';
const OLDER_AVATAR = 'pending_profile_avatar';

/** The key of `community`'s entry, or null for an address that isn't plain (node-url.ts): it is no community's. */
function keyOf(community: string | null | undefined): string | null {
    const origin = plainOriginOf(community);
    return origin ? `${PENDING_PROFILE_STORE_PREFIX}${origin}` : null;
}

async function readEntry(key: string, storage: PendingProfileStorage): Promise<PendingProfileChange | null> {
    try {
        const parsed: unknown = JSON.parse((await storage.getItem(key)) ?? 'null');
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as PendingProfileChange).publicKey !== 'string') return null;
        const { publicKey, callsign, avatar } = parsed as PendingProfileChange;
        return {
            publicKey,
            ...(typeof callsign === 'string' ? { callsign } : {}),
            ...(typeof avatar === 'string' ? { avatar } : {}),
        };
    } catch {
        return null;
    }
}

const sameEntry = (a: PendingProfileChange | null, b: PendingProfileChange | null) =>
    a?.publicKey === b?.publicKey && a?.callsign === b?.callsign && a?.avatar === b?.avatar;

/**
 * An older build's flag, moved to the community it names, for `publicKey` (the account on the phone: Sign Out and
 * Replace removed the old keys with the account). A flag naming no community is dropped. An entry the community
 * already has is newer and stays.
 */
async function moveOlderFlag(publicKey: string): Promise<void> {
    const flag = await AsyncStorage.getItem(OLDER_FLAG);
    const anchor = await AsyncStorage.getItem(OLDER_ANCHOR);
    const avatar = await AsyncStorage.getItem(OLDER_AVATAR);
    if (flag === null && anchor === null && avatar === null) return;
    const key = flag === 'true' ? keyOf(anchor) : null;
    if (key && !(await AsyncStorage.getItem(key))) {
        const moved: PendingProfileChange = { publicKey, ...(avatar ? { avatar } : {}) };
        await AsyncStorage.setItem(key, JSON.stringify(moved));
    }
    await AsyncStorage.removeItem(OLDER_FLAG);
    await AsyncStorage.removeItem(OLDER_ANCHOR);
    await AsyncStorage.removeItem(OLDER_AVATAR);
}

/** An older build's flag goes with the community it names, unmoved. */
async function dropOlderFlagAt(community: string, storage: PendingProfileStorage): Promise<void> {
    const anchor = await storage.getItem(OLDER_ANCHOR);
    if (anchor === null || plainOriginOf(anchor) !== plainOriginOf(community)) return;
    await storage.removeItem(OLDER_FLAG);
    await storage.removeItem(OLDER_ANCHOR);
    await storage.removeItem(OLDER_AVATAR);
}

/** What waits to reach `community` for `publicKey`, or null: nothing, or a change of another account's. */
export async function pendingProfileChange(community: string | null | undefined, publicKey: string): Promise<PendingProfileChange | null> {
    const key = keyOf(community);
    if (!key || !publicKey) return null;
    await moveOlderFlag(publicKey);
    const entry = await readEntry(key, AsyncStorage);
    return entry?.publicKey === publicKey ? entry : null;
}

/**
 * A Save that couldn't reach `community`: keep `change` for it, over what already waits there (a field left out keeps
 * the one waiting). Nothing is kept for an address that isn't plain, nor with no community: answers whether it was.
 */
export async function keepPendingProfileChange(community: string | null | undefined, publicKey: string, change: ProfileChange): Promise<boolean> {
    const key = keyOf(community);
    if (!key || !publicKey) return false;
    const held = await pendingProfileChange(community, publicKey);
    const kept: PendingProfileChange = { ...(held ?? {}), publicKey };
    if (change.callsign) kept.callsign = change.callsign;
    if (change.avatar) kept.avatar = change.avatar;
    await AsyncStorage.setItem(key, JSON.stringify(kept));
    return true;
}

/**
 * `community` accepted everything that waited there, or left the phone: its entry goes. With `onlyIf` (the entry the
 * publish was built from, null for none), only while the entry is still that one: a change kept while the publish was
 * out (an offline Save meanwhile) waits for the next.
 */
export async function clearPendingProfileChange(
    community: string | null | undefined,
    onlyIf?: PendingProfileChange | null,
    storage: PendingProfileStorage = AsyncStorage,
): Promise<void> {
    if (!community) return;
    const key = keyOf(community);
    if (key) {
        if (onlyIf !== undefined && !sameEntry(await readEntry(key, storage), onlyIf)) return;
        await storage.removeItem(key);
    }
    await dropOlderFlagAt(community, storage);
}

/**
 * `community` accepted a name (a Save or the wizard sent one): the name waiting there is sent, or overtaken, and goes.
 * The rest still waits: the photo goes only with a publish that carried it (avatar-value.ts retireParkedPickAfterPublish).
 */
export async function pendingNameAccepted(community: string | null | undefined): Promise<void> {
    const key = keyOf(community);
    if (!key) return;
    const entry = await readEntry(key, AsyncStorage);
    if (!entry || entry.callsign === undefined) return;
    const rest: PendingProfileChange = { publicKey: entry.publicKey, ...(entry.avatar !== undefined ? { avatar: entry.avatar } : {}) };
    await AsyncStorage.setItem(key, JSON.stringify(rest));
}

/** A community followed to its new address (address-follow.ts): what waits for it waits there. Never throws. */
export async function carryPendingProfileChange(from: string, to: string): Promise<void> {
    const fromKey = keyOf(from);
    const toKey = keyOf(to);
    if (!fromKey || !toKey || fromKey === toKey) return;
    try {
        const waiting = await AsyncStorage.getItem(fromKey);
        if (waiting === null) return;
        if ((await AsyncStorage.getItem(toKey)) === null) await AsyncStorage.setItem(toKey, waiting);
        await AsyncStorage.removeItem(fromKey);
    } catch (e) {
        console.warn('[Profile] The profile change waiting for this community could not follow it to its new address', e);
    }
}
