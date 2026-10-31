/**
 * "Your community's admins can bring you back", community-held placement (vault rethink VR3;
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3 "Turning it on", Marty's picks of 27 Oct).
 *
 * The phone seals its key, and its 12 words when they make this key, under 32 random bytes it makes for this copy
 * (@beanpool/core sealSeedToCopyKey), and hands the community's server the copy and that key, signed by the member's own
 * key. The server keeps both under its recovery seal (apps/server engine/community-copy.ts), and an admin's Bring back
 * seals them to the member's new phone (utils/rekey-redeem.ts openBringBack). Nothing goes to BeanPool's key vault.
 *
 * Offered only where the community keeps copies itself (`recoveryCopies: 'server'`, utils/copies-rule.ts) and never in
 * the global community, where nobody meets anyone (design §4.2, Q13). The server holds the same rule, so a phone that
 * offered it on a stale answer is refused there with the sentence, and nothing is kept. Never a false success: the row
 * says On only once the server answered that it keeps the copy.
 *
 * Where the community's rule is the key vault (the default), the same row turns on the shared placement instead, in a
 * build with a vault: utils/community-recovery.ts. This file's status tells them apart, by the server's own answer.
 */

import { isVaultKeyHex, recoveryWordsMatchSeed, sealSeedToCopyKey, toEd25519Seed } from '@beanpool/core';
import { hexToBytes } from './crypto';
import { getMnemonic, type BeanPoolIdentity } from './identity';
import { signedDelete, signedPost } from './node-post';
import { GLOBAL_NODE_URL } from './global-node-url';
import { hasVault, type RecoveryCopiesRule } from './vault-config';
import { unopenableOf, type CommunityCopyUnopenable } from './community-copy-state';

export { unopenableOf, type CommunityCopyUnopenable, type CommunityCopyUnopenableReason } from './community-copy-state';

/** What the community's server says about this member's community copy. */
export interface CommunityCopyStatus {
    /** It keeps the copy and can open it: only then can its admins bring the member back. */
    kept: boolean;
    /** When it was turned on (ISO), when kept. */
    since: string | null;
    /** Whether the community offers it now (its rule is "this server", and its door is not open to anyone). */
    offered: boolean;
    /** It keeps a copy it can't open now (its key gone, or another): never On. Null otherwise, and from a server from before. */
    unopenable: CommunityCopyUnopenable | null;
    /** Whether it offers the shared placement now (its rule is the key vault, and its door is not open to anyone). */
    sharedOffered: boolean;
    /** The key its vouchers are signed with, which a deposit at the vault names. Null from a server from before. */
    nodeKey: string | null;
    /** What it keeps, when `kept`: the copy and its key, or its half of a copy the vault keeps. */
    placement: 'whole' | 'shared' | null;
    /** The digest of the copy its half belongs to, when it keeps one. */
    copy: string | null;
}

/** The phone's own sentences (the server's refusals come in its own words). */
export const COMMUNITY_COPY_TEXT = {
    unreachable: 'Couldn’t reach your community, so nothing changed. Try again in a moment.',
    notKept: 'Your community didn’t keep the copy, so this isn’t on yet. Try again.',
    noKey: 'This phone can’t read its own key, so no copy was made.',
} as const;

/**
 * Whether this phone offers the community path at `url` under `rule`: "this server", or the key vault in a build that has
 * one (the shared placement), and never the global community.
 */
export function offersCommunityCopy(url: string | null | undefined, rule: RecoveryCopiesRule | null | undefined): boolean {
    return !!url && (rule === 'server' || (rule === 'vault' && hasVault())) && url.trim().replace(/\/+$/, '').toLowerCase() !== GLOBAL_NODE_URL;
}

async function answerOf(res: Response): Promise<any> {
    return res.json().catch(() => ({}));
}

/** The community's answer for this key, or null when it couldn't be asked (an older server answers 404: null too). */
export async function communityCopyStatus(url: string, identity: BeanPoolIdentity): Promise<CommunityCopyStatus | null> {
    try {
        const res = await signedPost(url, '/api/recovery/community-copy/status', {}, identity);
        if (!res.ok) return null;
        const body = await answerOf(res);
        if (typeof body.kept !== 'boolean') return null;
        const unopenable = body.kept ? null : unopenableOf(body.unopenable);
        return {
            kept: body.kept, since: typeof body.since === 'string' ? body.since : null, offered: body.offered === true, unopenable,
            sharedOffered: body.sharedOffered === true,
            nodeKey: isVaultKeyHex(body.nodeKey) ? body.nodeKey : null,
            placement: body.kept ? (body.placement === 'shared' ? 'shared' : 'whole') : null,
            copy: typeof body.copy === 'string' ? body.copy : null,
        };
    } catch {
        return null;
    }
}

/**
 * Turn it on: seal and send. Resolves with since when, only on the server's answer that it keeps the copy; throws an
 * Error whose message is the server's sentence, or one of {@link COMMUNITY_COPY_TEXT}. The words travel only when they
 * make this key (a restore would throw others away), and never in a log.
 */
export async function turnOnCommunityCopy(url: string, identity: BeanPoolIdentity): Promise<{ since: string }> {
    let seed: Uint8Array;
    try {
        seed = toEd25519Seed(hexToBytes(identity.privateKey));
    } catch {
        throw new Error(COMMUNITY_COPY_TEXT.noKey);
    }
    const words = await getMnemonic(identity);
    const made = sealSeedToCopyKey(seed, { words: words && recoveryWordsMatchSeed(words, seed) ? words : null });
    let res: Response;
    try {
        res = await signedPost(url, '/api/recovery/community-copy', made, identity);
    } catch {
        throw new Error(COMMUNITY_COPY_TEXT.unreachable);
    }
    const body = await answerOf(res);
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : COMMUNITY_COPY_TEXT.unreachable);
    if (body.kept !== true || typeof body.since !== 'string') throw new Error(COMMUNITY_COPY_TEXT.notKept);
    return { since: body.since };
}

/**
 * Turn it off: the community deletes the copy and its key. Resolves only on the community's own answer that it keeps
 * none now (`kept: false`), never on a proxy's page; throws with a sentence otherwise.
 */
export async function removeCommunityCopy(url: string, identity: BeanPoolIdentity): Promise<void> {
    let res: Response;
    try {
        res = await signedDelete(url, '/api/recovery/community-copy', identity);
    } catch {
        throw new Error(COMMUNITY_COPY_TEXT.unreachable);
    }
    const body = await answerOf(res);
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : COMMUNITY_COPY_TEXT.unreachable);
    if (body.kept !== false) throw new Error(COMMUNITY_COPY_TEXT.unreachable);
}
