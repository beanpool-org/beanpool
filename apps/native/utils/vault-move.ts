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
 *
 * Nothing sent to the community here carries a token, a copy or a nonce request: its status, and the delete.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { BeanPoolIdentity } from './identity';
import { signedDelete, signedPost } from './node-post';
import { offeredProviders, type SsoProvider } from './sso-providers';
import { vaultMoveLaterStoreKey, vaultMoveUnfinishedStoreKey } from './storage-keys';
import { connectWanted, hasVault, vaultStatus } from './vault';

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

/** The sign-ins the community at `url` keeps a copy for, for this key. Empty when it can't say. */
export async function communityCopies(identity: BeanPoolIdentity, url: string): Promise<SsoProvider[]> {
    try {
        const res = await signedPost(url, '/api/recovery/shares/status', {}, identity);
        if (!res.ok) return [];
        const body = await res.json().catch(() => null) as { enrolledSso?: unknown } | null;
        return offeredProviders(body?.enrolledSso);
    } catch {
        return [];
    }
}

/** Remove the community's copy for `provider`: a signed DELETE, and nothing else. True when it is gone. */
export async function removeCommunityCopy(identity: BeanPoolIdentity, url: string, provider: SsoProvider): Promise<boolean> {
    try {
        const res = await signedDelete(url, `/api/recovery/shares/sso/${encodeURIComponent(provider)}`, identity);
        // 404: the community has no copy for it (already gone).
        return res.ok || res.status === 404;
    } catch {
        return false;
    }
}

/**
 * What the card offers now, or null. Never throws, and a vault that can't say shows no card: the card is never shown
 * on a guess. Copies the vault already has that the community still keeps are removed from the community here.
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
    await retryUnfinishedMoves(identity);
    const atCommunity = communityUrl ? await communityCopies(identity, communityUrl) : [];
    const later = Number(await AsyncStorage.getItem(vaultMoveLaterStoreKey(identity.publicKey)).catch(() => null));
    if (later && now - later < MOVE_AGAIN_AFTER_MS) return null;
    const move = atCommunity.find(p => !atVault.includes(p) && canSignInHere(p));
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
}

async function unfinishedMoves(identity: BeanPoolIdentity): Promise<UnfinishedMove[]> {
    try {
        const raw = await AsyncStorage.getItem(vaultMoveUnfinishedStoreKey(identity.publicKey));
        const list = raw ? JSON.parse(raw) as unknown : [];
        return Array.isArray(list)
            ? list.filter((m): m is UnfinishedMove => !!m && typeof m.url === 'string' && offeredProviders([m.provider]).length === 1)
            : [];
    } catch {
        return [];
    }
}

async function keepUnfinishedMoves(identity: BeanPoolIdentity, moves: UnfinishedMove[]): Promise<void> {
    const key = vaultMoveUnfinishedStoreKey(identity.publicKey);
    await (moves.length ? AsyncStorage.setItem(key, JSON.stringify(moves)) : AsyncStorage.removeItem(key)).catch(() => {});
}

/** Deletes a move sent that didn't land: tried again, and kept until each lands. Only ones this phone moved. */
async function retryUnfinishedMoves(identity: BeanPoolIdentity): Promise<void> {
    const moves = await unfinishedMoves(identity);
    if (!moves.length) return;
    const left: UnfinishedMove[] = [];
    for (const m of moves) if (!(await removeCommunityCopy(identity, m.url, m.provider))) left.push(m);
    await keepUnfinishedMoves(identity, left);
}

/**
 * After the vault has the copy for `provider` (the connect succeeded): the community's copy goes, with a signed
 * DELETE. One that doesn't land now is remembered and tried again the next time the card looks ({@link vaultMoveOffer}).
 */
export async function finishMove(identity: BeanPoolIdentity, offer: VaultMoveOffer): Promise<void> {
    if (offer.kind !== 'move') return;
    if (await removeCommunityCopy(identity, offer.communityUrl, offer.provider)) return;
    const moves = await unfinishedMoves(identity);
    if (!moves.some(m => m.url === offer.communityUrl && m.provider === offer.provider)) {
        await keepUnfinishedMoves(identity, [...moves, { url: offer.communityUrl, provider: offer.provider }]);
    }
}
