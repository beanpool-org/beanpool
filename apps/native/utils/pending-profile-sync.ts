import AsyncStorage from '@react-native-async-storage/async-storage';
import { plainOriginOf } from './node-url';
import { PENDING_PROFILE_REFUSAL_STORE_PREFIX, PENDING_PROFILE_STORE_PREFIX } from './storage-keys';

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
 * A name the community refuses for good (nameRefusedForGood: someone else holds it there, or it is too short) would get
 * the same answer every time, and the photo and bio waiting with it would never arrive. So it leaves the entry
 * (pendingNameRefused), which keeps `refusedCallsign`: the retry then sends no name at all, and the community keeps the
 * one it holds, and a Save sends that name again only when the member types it. What the community said is kept
 * beside the entry until Settings has said it once (takeNameRefusal). A busy, limited or unreachable community, and any
 * other refusal, leave everything waiting for the next retry.
 *
 * Each entry names the account it was made under, and is read only for that account: a change is never sent under
 * another key. It is published only to its own community (pushProfileToServer reads the entry of the community it
 * publishes to) and cleared only when that community has accepted it, when the community leaves the phone (nodes.ts
 * removeSavedNode, delete-here.ts, update-block-escape.ts), or with the account (identity.ts wipeIdentityScopedStorage).
 * A community followed to its new address takes its entry there (address-follow.ts).
 *
 * A phone updated from a build with the one flag: the flag moves to the entry of the community its anchor names
 * (`pending_profile_sync_anchor`), or is dropped when it names none. The anchor proves less than where the flag was
 * set: the settings Save wrote it (since #2439) and nothing retired it, while Re-run Setup and the first join set the
 * flag and parked a photo without touching it. So the parked photo moves only when the anchor names the community open
 * at the move, where the older build would have sent it; otherwise the anchor's community gets the bare change, and
 * republishes its own row (moveOlderFlag).
 */

export interface PendingProfileChange {
    /** The account it was made under. */
    publicKey: string;
    /** A new name the community hasn't accepted yet. */
    callsign?: string;
    /** A photo picked there that the community hasn't accepted yet. */
    avatar?: string;
    /** A name the community refused for good: the retry sends none, and the community keeps the one it holds. */
    refusedCallsign?: string;
}

/** What a community answered when it refused a name for good: its status and its own sentence, if it gave one. */
export interface NameRefusal {
    status: number;
    message: string | null;
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
/** The community open on the phone (db.ts getDb opens its copy). */
const OPEN_COMMUNITY = 'beanpool_anchor_url';

/** The key of `community`'s entry, or null for an address that isn't plain (node-url.ts): it is no community's. */
function keyOf(community: string | null | undefined, prefix = PENDING_PROFILE_STORE_PREFIX): string | null {
    const origin = plainOriginOf(community);
    return origin ? `${prefix}${origin}` : null;
}

/** The key of what `community` said when it refused a name for good (takeNameRefusal). */
const refusalKeyOf = (community: string | null | undefined) => keyOf(community, PENDING_PROFILE_REFUSAL_STORE_PREFIX);

async function readEntry(key: string, storage: PendingProfileStorage): Promise<PendingProfileChange | null> {
    try {
        const parsed: unknown = JSON.parse((await storage.getItem(key)) ?? 'null');
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as PendingProfileChange).publicKey !== 'string') return null;
        const { publicKey, callsign, avatar, refusedCallsign } = parsed as PendingProfileChange;
        return {
            publicKey,
            ...(typeof callsign === 'string' ? { callsign } : {}),
            ...(typeof avatar === 'string' ? { avatar } : {}),
            ...(typeof refusedCallsign === 'string' ? { refusedCallsign } : {}),
        };
    } catch {
        return null;
    }
}

const sameEntry = (a: PendingProfileChange | null, b: PendingProfileChange | null) =>
    a?.publicKey === b?.publicKey && a?.callsign === b?.callsign && a?.avatar === b?.avatar && a?.refusedCallsign === b?.refusedCallsign;

/**
 * An older build's flag, moved to the community its anchor names, for `publicKey` (the account on the phone: Sign Out
 * and Replace removed the old keys with the account). A flag naming no community is dropped. An entry the community
 * already has is newer and stays.
 *
 * The anchor names the community of the last settings Save made offline, and a successful retry never removed it;
 * Re-run Setup and the first join set the flag and parked a photo without touching it. So a Save in A then a switch to
 * B, and a stale A anchor with a wizard run in B, leave the same keys, and the anchor can't say whose the photo is
 * (#2461 review r4368601890). It moves with the flag only when the anchor names the community open now, the one the
 * older build's retry would have published it to. Otherwise the anchor's community gets the bare change: it republishes
 * its own row (which still holds its own offline pick), and nothing of another community's.
 */
async function moveOlderFlag(publicKey: string): Promise<void> {
    const flag = await AsyncStorage.getItem(OLDER_FLAG);
    const anchor = await AsyncStorage.getItem(OLDER_ANCHOR);
    const avatar = await AsyncStorage.getItem(OLDER_AVATAR);
    if (flag === null && anchor === null && avatar === null) return;
    const key = flag === 'true' ? keyOf(anchor) : null;
    if (key && !(await AsyncStorage.getItem(key))) {
        const anchorIsOpen = plainOriginOf(await AsyncStorage.getItem(OPEN_COMMUNITY)) === plainOriginOf(anchor);
        const moved: PendingProfileChange = { publicKey, ...(avatar && anchorIsOpen ? { avatar } : {}) };
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
    if (change.callsign) {
        kept.callsign = change.callsign;
        // A name the member gives now goes, whatever was refused before.
        delete kept.refusedCallsign;
    }
    if (change.avatar) kept.avatar = change.avatar;
    await AsyncStorage.setItem(key, JSON.stringify(kept));
    return true;
}

/**
 * `community` accepted everything that waited there, or left the phone: its entry goes. With `onlyIf` (the entry the
 * publish was built from, null for none), only while the entry is still that one: a change kept while the publish was
 * out (an offline Save meanwhile) waits for the next. What the community said of a refused name goes too, except with
 * `onlyIf`: the retry's own publish, which no one watched, leaves it for Settings to say (takeNameRefusal).
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
        if (onlyIf === undefined) await storage.removeItem(refusalKeyOf(community)!);
    }
    await dropOlderFlagAt(community, storage);
}

/**
 * `community` accepted a name (a Save or the wizard sent one): the name waiting there is sent, or overtaken, and goes,
 * with one it refused before and what it said of that. The rest still waits: the photo goes only with a publish that
 * carried it (avatar-value.ts retireParkedPickAfterPublish).
 */
export async function pendingNameAccepted(community: string | null | undefined): Promise<void> {
    const key = keyOf(community);
    if (!key) return;
    await AsyncStorage.removeItem(refusalKeyOf(community)!);
    const entry = await readEntry(key, AsyncStorage);
    if (!entry || (entry.callsign === undefined && entry.refusedCallsign === undefined)) return;
    const rest: PendingProfileChange = { publicKey: entry.publicKey, ...(entry.avatar !== undefined ? { avatar: entry.avatar } : {}) };
    await AsyncStorage.setItem(key, JSON.stringify(rest));
}

/**
 * Whether a community's answer to a profile update refuses the name in it for good: someone else holds that name there
 * (409 `callsign_taken`) or it is too short (400 `callsign_too_short`), as the server's profile route answers
 * (apps/server/src/routes/community.ts). The same name gets the same answer every time. Any other answer is not: a busy,
 * limited or unreachable community, or a refusal of something else, leaves the change waiting for the next retry.
 */
export function nameRefusedForGood(status: number, error: unknown): boolean {
    return (status === 409 && error === 'callsign_taken') || (status === 400 && error === 'callsign_too_short');
}

/**
 * `community` refused for good (nameRefusedForGood) the name `callsign` that a publish built from `onlyIf` carried. The
 * name leaves the change and is kept as refused, so the retry sends none and the community keeps the one it holds. The
 * rest still waits: the photo, and the publish of the row's bio and contact. Only while the change is still `onlyIf`: one
 * kept meanwhile (an offline Save) is newer, and waits as it is. With `said`, the answer to a publish no one watched (the
 * retry's), the member is told it once in Settings (takeNameRefusal). Answers whether the change was the one refused.
 */
export async function pendingNameRefused(
    community: string | null | undefined,
    onlyIf: PendingProfileChange,
    callsign: string,
    said?: NameRefusal,
): Promise<boolean> {
    const key = keyOf(community);
    if (!key || !sameEntry(await readEntry(key, AsyncStorage), onlyIf)) return false;
    const rest: PendingProfileChange = {
        publicKey: onlyIf.publicKey,
        ...(onlyIf.avatar !== undefined ? { avatar: onlyIf.avatar } : {}),
        refusedCallsign: callsign,
    };
    await AsyncStorage.setItem(key, JSON.stringify(rest));
    if (said) await AsyncStorage.setItem(refusalKeyOf(community)!, JSON.stringify({ publicKey: onlyIf.publicKey, ...said }));
    return true;
}

/** The refusals being read now: two readers at once (Settings loads on mount and on focus) say it once. */
const refusalsBeingTaken = new Set<string>();

/**
 * What `community` said when it refused for good a name waiting there for `publicKey` (pendingNameRefused), for Settings
 * to say once: read and forgotten. Null when there is nothing, or it was said under another account.
 */
export async function takeNameRefusal(community: string | null | undefined, publicKey: string): Promise<NameRefusal | null> {
    const key = refusalKeyOf(community);
    if (!key || !publicKey || refusalsBeingTaken.has(key)) return null;
    refusalsBeingTaken.add(key);
    try {
        let said: Partial<NameRefusal> & { publicKey?: unknown } | null = null;
        try {
            said = JSON.parse((await AsyncStorage.getItem(key)) ?? 'null');
        } catch { /* unreadable: forgotten below */ }
        if (said && said.publicKey !== publicKey) return null;
        await AsyncStorage.removeItem(key);
        return said && typeof said.status === 'number' ? { status: said.status, message: typeof said.message === 'string' ? said.message : null } : null;
    } finally {
        refusalsBeingTaken.delete(key);
    }
}

/**
 * A community followed to its new address (address-follow.ts): what waits for it waits there. An older build's flag set
 * there and not moved yet names the new address, so the old row's removal keeps it (dropOlderFlagAt) and the first read
 * there moves it. Never throws.
 */
export async function carryPendingProfileChange(from: string, to: string): Promise<void> {
    const fromKey = keyOf(from);
    const toKey = keyOf(to);
    if (!fromKey || !toKey || fromKey === toKey) return;
    try {
        // Before the entry: a read that moves the flag meanwhile moves it to the entry carried next, or to `to`'s.
        const olderAnchor = await AsyncStorage.getItem(OLDER_ANCHOR);
        if (olderAnchor !== null && plainOriginOf(olderAnchor) === plainOriginOf(from)) await AsyncStorage.setItem(OLDER_ANCHOR, to);
        // What it said of a refused name, still to be said in Settings.
        const said = await AsyncStorage.getItem(refusalKeyOf(from)!);
        if (said !== null) {
            await AsyncStorage.setItem(refusalKeyOf(to)!, said);
            await AsyncStorage.removeItem(refusalKeyOf(from)!);
        }
        const waiting = await AsyncStorage.getItem(fromKey);
        if (waiting === null) return;
        if ((await AsyncStorage.getItem(toKey)) === null) await AsyncStorage.setItem(toKey, waiting);
        await AsyncStorage.removeItem(fromKey);
    } catch (e) {
        console.warn('[Profile] The profile change waiting for this community could not follow it to its new address', e);
    }
}
