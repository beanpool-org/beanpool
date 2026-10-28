/**
 * The move card (key vault design §5.1): a sign-in copy that a community still keeps goes to BeanPool's key vault,
 * with one sign-in, and then comes off the community.
 *
 * - The card shows when the community the phone is on has a copy for a sign-in and the vault has none for it (asked of
 *   each, `/api/recovery/shares/status` and `/v1/copies/status`), or when a sign-in the member tried to link while the
 *   vault was paused is still unlinked (§2.3: "saved and retried at the next app open").
 * - Moving is an ordinary connect (utils/sso-sheet-connect.ts): the phone seals the copy afresh from its own seed and
 *   words, so nothing is read from the old one, and deposits it at the vault. Only once the vault has it does the phone
 *   send a signed DELETE for that sign-in to the community. A delete that doesn't land is remembered on the phone and
 *   tried again each time the card looks, until it does. Only copies this phone moved are ever deleted.
 * - "Not now" is always there; the card comes back a week later, and never blocks anything.
 * - "Remove it instead" (PR #1336 review finding 7): a member who wants no copy anywhere can have the community's copy
 *   deleted without first depositing one at the vault. The same signed DELETE, remembered and tried again the same way
 *   when it doesn't land ({@link removeInstead}).
 *
 * Nothing sent to the community here carries a token, a copy or a nonce request: its status, and the delete.
 *
 * "Where your account can be brought back from" (vault rethink VR1, design §5.1; utils/ways-back.ts) removes a community's
 * copy with the same delete and keeps the same list of deletes that didn't land, so either one's are tried again by the
 * other: when the card looks, when that screen opens, and at app open ({@link retryCommunityRemovals}). A delete it
 * remembers also remembers the community's `generation` when it was asked: tried again, it goes only while that is
 * unchanged, so a copy the member made there afterwards, from any device, is never the one deleted.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { BeanPoolIdentity } from './identity';
import { signedDelete, signedPost } from './node-post';
import { offeredProviders, type SsoProvider } from './sso-providers';
import { vaultMoveLaterStoreKey, vaultMoveUnfinishedStoreKey } from './storage-keys';
import { connectWanted, hasVault, vaultStatus } from './vault';
import { sameCommunity } from './ways-back-state';

export { sameCommunity };

/** How long "Not now" puts the card away (design §5.1: weekly until the date). */
export const MOVE_AGAIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type VaultMoveOffer =
    /** The community keeps a copy for `provider` and the vault none: move it. */
    | { kind: 'move'; provider: SsoProvider; communityUrl: string }
    /** The member tried to link `provider` while the vault was paused: offer it again. */
    | { kind: 'retry'; provider: SsoProvider };

/** The sign-ins this phone can sign in with (Apple on the iPhone only). */
function canSignInHere(provider: SsoProvider): boolean {
    return provider !== 'apple' || Platform.OS === 'ios';
}

/**
 * How long the community gets to answer the card's two questions. React Native's fetch never gives up by itself, and a
 * community that never answers would otherwise hold the card (and a paused link's offer) back for good (seen on the
 * emulator with no connection).
 */
export const COMMUNITY_TIMEOUT_MS = 15_000;

/** `p`, or null once `ms` has passed. */
function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })])
        .finally(() => { if (timer) clearTimeout(timer); });
}

/** What the community at `url` keeps for this key: its sign-in copies, and the `generation` of its copies (null when unsaid). */
export interface CommunityCopyStatus {
    providers: SsoProvider[];
    generation: number | null;
}

/**
 * The community's own answer about this key's copies, or null when it gave none in time: no answer, a refusal (not a
 * member there, a server that can't open its copies), or one that isn't a status. Null is "couldn't ask", never "none".
 */
export async function communityCopyStatus(identity: BeanPoolIdentity, url: string): Promise<CommunityCopyStatus | null> {
    try {
        const controller = new AbortController();
        const res = await within(signedPost(url, '/api/recovery/shares/status', {}, identity, controller.signal), COMMUNITY_TIMEOUT_MS);
        if (!res) {
            controller.abort();
            return null;
        }
        if (!res.ok) return null;
        const body = await within(res.json().catch(() => null), COMMUNITY_TIMEOUT_MS) as { enrolledSso?: unknown; generation?: unknown } | null;
        if (!body || !Array.isArray(body.enrolledSso)) return null;
        const generation = typeof body.generation === 'number' && Number.isSafeInteger(body.generation) ? body.generation : null;
        return { providers: [...new Set(offeredProviders(body.enrolledSso))], generation };
    } catch {
        return null;
    }
}

/** The sign-ins the community at `url` keeps a copy for, for this key. Empty when it can't say in time. */
export async function communityCopies(identity: BeanPoolIdentity, url: string): Promise<SsoProvider[]> {
    return (await communityCopyStatus(identity, url))?.providers ?? [];
}

/**
 * Remove the community's copy for `provider`: a signed DELETE, and nothing else. True when it is gone; false when the
 * community refused it or didn't answer in time (it is then tried again, see {@link finishMove}).
 */
export async function removeCommunityCopy(identity: BeanPoolIdentity, url: string, provider: SsoProvider): Promise<boolean> {
    try {
        const res = await within(signedDelete(url, `/api/recovery/shares/sso/${encodeURIComponent(provider)}`, identity), COMMUNITY_TIMEOUT_MS);
        // 404: the community has no copy for it (already gone).
        return !!res && (res.ok || res.status === 404);
    } catch {
        return false;
    }
}

/**
 * What the card offers now, or null. Never throws, and a vault that can't say shows no card: the card is never shown
 * on a guess. First, deletes this phone sent that didn't land are tried again: only copies this phone moved or was
 * asked to remove. A copy the vault already has is not deleted from the community on that ground alone.
 */
export async function vaultMoveOffer(
    identity: BeanPoolIdentity, communityUrl: string | null, now: number = Date.now(),
): Promise<VaultMoveOffer | null> {
    if (!hasVault()) return null;
    let atVault: SsoProvider[];
    try {
        atVault = (await vaultStatus(identity, 15_000)).providers;
    } catch {
        return null;
    }
    await retryCommunityRemovals(identity);
    const atCommunity = communityUrl ? await communityCopies(identity, communityUrl) : [];
    const later = Number(await AsyncStorage.getItem(vaultMoveLaterStoreKey(identity.publicKey)).catch(() => null));
    if (later && now - later < MOVE_AGAIN_AFTER_MS) return null;
    // A copy the member asked to remove, whose delete hasn't landed yet, is never offered as one to move.
    const removing = await unfinishedMoves(identity);
    const move = atCommunity.find(p => !atVault.includes(p) && canSignInHere(p)
        && !removing.some(m => m.provider === p && sameCommunity(m.url, communityUrl as string)));
    if (move && communityUrl) return { kind: 'move', provider: move, communityUrl };
    const retry = (await connectWanted(identity.publicKey)).find(p => !atVault.includes(p) && canSignInHere(p));
    return retry ? { kind: 'retry', provider: retry } : null;
}

/** "Not now": the card comes back a week later. */
export async function moveLater(identity: BeanPoolIdentity, now: number = Date.now()): Promise<void> {
    await AsyncStorage.setItem(vaultMoveLaterStoreKey(identity.publicKey), String(now)).catch(() => {});
}

interface UnfinishedMove {
    url: string;
    provider: SsoProvider;
    /**
     * The community's `generation` when the member asked (utils/ways-back.ts): tried again, the delete goes only while
     * it is unchanged. Absent on the card's own deletes, which are tried again as they always were.
     */
    generation?: number;
}

/** A delete that hasn't landed yet: which community, and which sign-in's copy there. */
export interface PendingRemoval {
    url: string;
    provider: SsoProvider;
}

const sameRemoval = (a: PendingRemoval, b: PendingRemoval) => a.provider === b.provider && sameCommunity(a.url, b.url);

async function unfinishedMoves(identity: BeanPoolIdentity): Promise<UnfinishedMove[]> {
    try {
        const raw = await AsyncStorage.getItem(vaultMoveUnfinishedStoreKey(identity.publicKey));
        const list = raw ? JSON.parse(raw) as unknown : [];
        return Array.isArray(list)
            ? list.filter((m): m is UnfinishedMove => !!m && typeof m.url === 'string' && offeredProviders([m.provider]).length === 1
                && (m.generation === undefined || Number.isSafeInteger(m.generation)))
            : [];
    } catch {
        return [];
    }
}

async function keepUnfinishedMoves(identity: BeanPoolIdentity, moves: UnfinishedMove[]): Promise<void> {
    const key = vaultMoveUnfinishedStoreKey(identity.publicKey);
    await (moves.length ? AsyncStorage.setItem(key, JSON.stringify(moves)) : AsyncStorage.removeItem(key)).catch(() => {});
}

/**
 * Every change to the list, one at a time. A retry takes seconds per community, and writes its answer only to the
 * entries it tried, so a delete remembered meanwhile (Remove everything while the app-open retry runs) is kept.
 */
let listTurn: Promise<unknown> = Promise.resolve();
function changeList<T>(change: () => Promise<T>): Promise<T> {
    const turn = listTurn.then(change, change);
    listTurn = turn.catch(() => {});
    return turn;
}

/** The deletes this phone was asked for that haven't landed yet, of `identity`'s copies. */
export async function pendingCommunityRemovals(identity: BeanPoolIdentity): Promise<PendingRemoval[]> {
    return (await unfinishedMoves(identity)).map(({ url, provider }) => ({ url, provider }));
}

/**
 * Deletes that didn't land: tried again, and kept until each lands. Only ones this phone moved or was asked to remove.
 * One remembered with the community's generation is asked about first: gone already, it is done; the community's copies
 * changed since (a sign-in linked or removed there, from any device), it is dropped and nothing is deleted, as the copy
 * may be a newer one, which the member's list then shows as kept; the community can't say, it waits. Never throws.
 */
export async function retryCommunityRemovals(identity: BeanPoolIdentity): Promise<void> {
    const moves = await unfinishedMoves(identity);
    if (!moves.length) return;
    const finished: UnfinishedMove[] = [];
    for (const m of moves) {
        if (m.generation !== undefined) {
            const now = await communityCopyStatus(identity, m.url);
            if (!now) continue;
            if (!now.providers.includes(m.provider)) {
                finished.push(m);
                continue;
            }
            if (now.generation !== m.generation) {
                console.log(`[VAULT] a remembered delete of a ${m.provider} copy was dropped: that community's copies changed since it was asked`);
                finished.push(m);
                continue;
            }
        }
        if (await removeCommunityCopy(identity, m.url, m.provider)) finished.push(m);
    }
    if (!finished.length) return;
    await changeList(async () => {
        const list = await unfinishedMoves(identity);
        await keepUnfinishedMoves(identity, list.filter(m => !finished.some(f => sameRemoval(f, m) && f.generation === m.generation)));
    });
}

/**
 * After the vault has the copy for `provider` (the connect succeeded): the community's copy goes, with a signed
 * DELETE. One that doesn't land now is remembered and tried again the next time the card looks ({@link vaultMoveOffer}).
 */
export async function finishMove(identity: BeanPoolIdentity, offer: VaultMoveOffer): Promise<void> {
    if (offer.kind !== 'move') return;
    await deleteOrRemember(identity, offer.communityUrl, offer.provider);
}

/**
 * "Remove it instead": the community's copy for `provider` goes, with the signed DELETE, and nothing is deposited at the
 * vault. The member's choice: afterwards that sign-in brings the account back nowhere until it is linked again. A
 * delete that doesn't land now is remembered and tried again when the card next looks. True once it is gone.
 */
export async function removeInstead(identity: BeanPoolIdentity, offer: VaultMoveOffer): Promise<boolean> {
    if (offer.kind !== 'move') return false;
    return deleteOrRemember(identity, offer.communityUrl, offer.provider);
}

/**
 * The community's copy for `provider` goes now, or is remembered and tried again ({@link retryCommunityRemovals}). With
 * `generation` (the community's, as the member saw its copies), a retry deletes only while it is unchanged. True once
 * it is gone; false when it is remembered: not yet removed.
 */
export async function deleteOrRemember(
    identity: BeanPoolIdentity, url: string, provider: SsoProvider, generation: number | null = null,
): Promise<boolean> {
    if (await removeCommunityCopy(identity, url, provider)) {
        // Gone: a delete of it that was waiting is done too.
        await changeList(async () => {
            const list = await unfinishedMoves(identity);
            const left = list.filter(m => !sameRemoval(m, { url, provider }));
            if (left.length !== list.length) await keepUnfinishedMoves(identity, left);
        });
        return true;
    }
    await changeList(async () => {
        const list = await unfinishedMoves(identity);
        const was = list.find(m => sameRemoval(m, { url, provider }));
        // The card's own delete of the same copy, already waiting, stays as it was; otherwise this one, with its generation.
        if (was && (was.generation === undefined || generation === null)) return;
        const entry: UnfinishedMove = generation === null ? { url, provider } : { url, provider, generation };
        await keepUnfinishedMoves(identity, [...list.filter(m => !sameRemoval(m, entry)), entry]);
    });
    return false;
}
