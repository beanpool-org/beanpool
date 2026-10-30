/**
 * "Your community's admins can bring you back" in the web app (vault rethink VR3, community-held placement;
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3): the browser seals its key, and its 12 words when they make
 * this key, under 32 random bytes made for this copy (@beanpool/core sealSeedToCopyKey), and the community's server keeps
 * the copy and that key under its recovery seal (apps/server engine/community-copy.ts). The same requests as the phone's
 * (apps/native utils/community-copy.ts), signed by this browser's key; nothing goes to BeanPool's key vault, which the
 * web app has no client for. The server holds the community's rule: under any other rule than "this server", or in the
 * global community, it keeps nothing and says why.
 */

import { recoveryWordsMatchSeed, sealSeedToCopyKey, toEd25519Seed } from '@beanpool/core';
import { signedFetch } from './api';
import { getMnemonic, type BeanPoolIdentity } from './identity';

export interface WebCommunityCopyStatus {
    kept: boolean;
    since: string | null;
    offered: boolean;
}

export const WEB_COMMUNITY_COPY_TEXT = {
    unreachable: 'Couldn’t reach your community, so nothing changed. Try again in a moment.',
    notKept: 'Your community didn’t keep the copy, so this isn’t on yet. Try again.',
    noKey: 'This browser can’t read its own key, so no copy was made.',
} as const;

function bytesOfHex(hex: string): Uint8Array {
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error('not hex');
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

/** The server's answer for this browser's key, or null when it couldn't be asked (an older server: null too). */
export async function webCommunityCopyStatus(): Promise<WebCommunityCopyStatus | null> {
    try {
        const res = await signedFetch('POST', '/api/recovery/community-copy/status', {});
        if (!res.ok) return null;
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (typeof body.kept !== 'boolean') return null;
        return { kept: body.kept, since: typeof body.since === 'string' ? body.since : null, offered: body.offered === true };
    } catch {
        return null;
    }
}

/** Turn it on. Resolves only on the server's answer that it keeps the copy; throws an Error with a sentence otherwise. */
export async function webTurnOnCommunityCopy(identity: BeanPoolIdentity): Promise<{ since: string }> {
    let seed: Uint8Array;
    try {
        seed = toEd25519Seed(bytesOfHex(identity.privateKey));
    } catch {
        throw new Error(WEB_COMMUNITY_COPY_TEXT.noKey);
    }
    const words = await getMnemonic(identity);
    const made = sealSeedToCopyKey(seed, { words: words && recoveryWordsMatchSeed(words, seed) ? words : null });
    let res: Response;
    try {
        res = await signedFetch('POST', '/api/recovery/community-copy', made);
    } catch {
        throw new Error(WEB_COMMUNITY_COPY_TEXT.unreachable);
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : WEB_COMMUNITY_COPY_TEXT.unreachable);
    if (body.kept !== true || typeof body.since !== 'string') throw new Error(WEB_COMMUNITY_COPY_TEXT.notKept);
    return { since: body.since };
}

/**
 * Turn it off: the server deletes the copy and its key. Resolves only on the server's own answer that it keeps none now
 * (`kept: false`), never on a proxy's page; throws with a sentence otherwise.
 */
export async function webRemoveCommunityCopy(): Promise<void> {
    let res: Response;
    try {
        res = await signedFetch('DELETE', '/api/recovery/community-copy');
    } catch {
        throw new Error(WEB_COMMUNITY_COPY_TEXT.unreachable);
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : WEB_COMMUNITY_COPY_TEXT.unreachable);
    if (body.kept !== false) throw new Error(WEB_COMMUNITY_COPY_TEXT.unreachable);
}
