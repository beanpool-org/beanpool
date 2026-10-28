/**
 * "Where your account can be brought back from" (vault rethink VR1, DESIGN-vault-rethink-fable.md §5.1): every place a
 * copy of this account's key is kept, as far as this phone can ask, since when, and removing them, one at a time or
 * all at once. The screen is app/ways-back.tsx; this file asks, removes and decides, and says nothing in words.
 *
 * ## What is asked, and what "couldn't say" means
 *
 * - **BeanPool's key vault**, in a build that has one: its signed status (utils/vault.ts `vaultStatus`), each sign-in's
 *   copy with `since`. Paused, or an answer the phone can't check: `unknown`, and nothing about its copies is shown as
 *   kept or as gone.
 * - **Every community saved on this phone** (utils/nodes.ts): `/api/recovery/shares/status`, signed by the key
 *   (utils/vault-move.ts `communityCopyStatus`). A community that gives no answer in time is `null`, never "none".
 *   A community's copy has no "since": its server rewrites every row of the member's copies whenever one is linked or
 *   removed there, so the only date it has is the last change, not the copy's.
 * - **Deletes asked for that haven't landed** (the move card's list, utils/vault-move.ts): shown as not yet removed, and
 *   tried again before every listing, at app open (app/_layout.tsx) and when the move card looks.
 *
 * ## Removing (never a false "removed")
 *
 * - A vault copy is removed only on the vault's signed `deleted` answer (utils/vault.ts `disconnectFromVault`); a
 *   community's only on its own 2xx, or a 404 for a copy already gone. Anything short of that is "not removed", and a
 *   community's delete is then remembered and tried again (with the guard against a newer copy, vault-move.ts).
 * - **Remove everything**: the vault's `all`, when it listed a copy or couldn't say, and a delete for every copy each
 *   community listed. A community that couldn't be asked has nothing removed, and the result says so: the phone never
 *   deletes a copy it was never shown, at a community it couldn't see.
 * - **The last way back** ({@link beforeRemoving}): a removal that would leave no copy this phone knows of is asked
 *   about first. With the 12 words on the phone and not marked written down: "Show my 12 words first?". With no words on
 *   the phone and none marked written down: what is then left, said plainly. Marked written down: an ordinary confirm.
 *   It never refuses: the member decides (memory onboarding-no-hard-gates).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BeanPoolIdentity } from './identity';
import { getSavedNodes } from './nodes';
import { readOneWayBack } from './one-way-back';
import type { SsoProvider } from './sso-providers';
import { wordsWrittenDownStoreKey } from './storage-keys';
import { disconnectFromVault, hasVault, vaultStatus, VaultError, type VaultCopy } from './vault';
import {
    communityCopyStatus, deleteOrRemember, pendingCommunityRemovals, retryCommunityRemovals, sameCommunity,
    type CommunityCopyStatus, type PendingRemoval,
} from './vault-move';

/** Why a keeper couldn't say, or didn't remove: paused (the vault, locked), no answer, or one that didn't check out. */
export type NotAnswered = 'paused' | 'unreachable' | 'unverified';

export type VaultPart =
    /** This build keeps no copies at BeanPool's key vault: nothing is asked there, and nothing is said about it. */
    | { kind: 'no-vault' }
    | { kind: 'listed'; copies: VaultCopy[] }
    /** The vault couldn't say. Its copies, if it keeps any, are neither listed nor said to be gone. */
    | { kind: 'unknown'; why: NotAnswered };

export interface CommunityPart {
    url: string;
    /** The name this phone saved it under, or its address. */
    name: string;
    /** Its answer about this key's copies, or null when it gave none: never read as "none". */
    status: CommunityCopyStatus | null;
}

export interface WaysBack {
    vault: VaultPart;
    communities: CommunityPart[];
    /** Deletes this phone was asked for that haven't landed yet. */
    pending: PendingRemoval[];
}

/** One copy to remove: a sign-in's at the vault, or a sign-in's at a community. */
export type CopyAt =
    | { at: 'vault'; provider: SsoProvider }
    | { at: 'community'; url: string; provider: SsoProvider };

/** What a removal did. `remembered`: a community's delete that didn't land, kept and tried again. */
export type Removal = { removed: true } | { removed: false; why: NotAnswered | 'refused' | 'remembered' };

/** The vault's failure, as the member's list says it. */
function notAnswered(e: unknown): NotAnswered | 'refused' {
    if (!(e instanceof VaultError)) return 'unreachable';
    if (e.code === 'unverified') return 'unverified';
    if (e.reason === 'locked') return 'paused';
    if (e.reason === 'unreachable' || e.reason === 'not_configured') return 'unreachable';
    return 'refused';
}

/** A community's name as this phone saved it, or its host. */
function nameOf(url: string, alias?: string): string {
    if (alias?.trim()) return alias.trim();
    try {
        return new URL(url).host || url;
    } catch {
        return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
}

/**
 * Everything this phone can find out, each keeper asked at once. Deletes that didn't land are tried again first, so the
 * list shows what is there now. Never throws: what can't be asked says so in its part.
 */
export async function listWaysBack(identity: BeanPoolIdentity): Promise<WaysBack> {
    await retryCommunityRemovals(identity);
    const saved = await getSavedNodes();
    const places: { url: string; name: string }[] = [];
    for (const n of saved) {
        if (!places.some(p => sameCommunity(p.url, n.url))) places.push({ url: n.url, name: nameOf(n.url, n.alias) });
    }
    const [vault, communities, pending] = await Promise.all([
        askVault(identity),
        Promise.all(places.map(async (p): Promise<CommunityPart> => ({ ...p, status: await communityCopyStatus(identity, p.url) }))),
        pendingCommunityRemovals(identity),
    ]);
    return { vault, communities, pending };
}

async function askVault(identity: BeanPoolIdentity): Promise<VaultPart> {
    if (!hasVault()) return { kind: 'no-vault' };
    try {
        return { kind: 'listed', copies: (await vaultStatus(identity)).copies };
    } catch (e) {
        const why = notAnswered(e);
        return { kind: 'unknown', why: why === 'refused' ? 'unreachable' : why };
    }
}

/** Whether `copy` is waiting to be removed (its delete didn't land yet). */
function isPending(w: WaysBack, url: string, provider: SsoProvider): boolean {
    return w.pending.some(p => p.provider === provider && sameCommunity(p.url, url));
}

/** Every copy this phone knows is kept now, not counting ones waiting to be removed. */
export function knownCopies(w: WaysBack): CopyAt[] {
    const out: CopyAt[] = [];
    if (w.vault.kind === 'listed') for (const c of w.vault.copies) out.push({ at: 'vault', provider: c.provider });
    for (const c of w.communities) {
        for (const provider of c.status?.providers ?? []) {
            if (!isPending(w, c.url, provider)) out.push({ at: 'community', url: c.url, provider });
        }
    }
    return out;
}

const sameCopy = (a: CopyAt, b: CopyAt) => a.at === b.at && a.provider === b.provider
    && (a.at === 'vault' || (b.at === 'community' && sameCommunity(a.url, b.url)));

/** Whether every keeper answered: the vault (when the build has one) and every saved community. */
export function everyoneAnswered(w: WaysBack): boolean {
    return w.vault.kind !== 'unknown' && w.communities.every(c => c.status !== null);
}

/**
 * Nothing kept anywhere this phone can ask: every keeper answered, none keeps a copy, and no delete is waiting. The
 * member's 12 words are then their way back (with an admin's re-key, to a new key, when they are lost too).
 */
export function wordsOnly(w: WaysBack): boolean {
    return everyoneAnswered(w) && knownCopies(w).length === 0 && w.pending.length === 0;
}

/** What to ask before a removal (see the file's note): an ordinary confirm, or the 12 words first. */
export type BeforeRemoving = 'confirm' | 'show-words-first' | 'no-words-on-phone';

export function beforeRemoving(
    w: WaysBack, removing: CopyAt | 'everything', phone: { hasWords: boolean; writtenDown: boolean },
): BeforeRemoving {
    const left = removing === 'everything' ? [] : knownCopies(w).filter(c => !sameCopy(c, removing));
    if (left.length > 0 || phone.writtenDown) return 'confirm';
    return phone.hasWords ? 'show-words-first' : 'no-words-on-phone';
}

/** Remove the vault's copy for one sign-in: removed only on the vault's signed answer. */
export async function removeVaultCopy(identity: BeanPoolIdentity, provider: SsoProvider): Promise<Removal> {
    try {
        await disconnectFromVault(identity, provider);
        return { removed: true };
    } catch (e) {
        return { removed: false, why: notAnswered(e) };
    }
}

/**
 * Remove a community's copy for one sign-in: removed on the community's own answer; otherwise remembered and tried
 * again (`remembered`), guarded by the generation the member saw (`status`).
 */
export async function removeCommunityCopyFrom(
    identity: BeanPoolIdentity, community: CommunityPart, provider: SsoProvider,
): Promise<Removal> {
    const gone = await deleteOrRemember(identity, community.url, provider, community.status?.generation ?? null);
    return gone ? { removed: true } : { removed: false, why: 'remembered' };
}

export interface EverythingRemoved {
    /** The vault's answer, or null when nothing was asked of it (no vault in this build, or it listed no copy). */
    vault: Removal | null;
    /** Each community copy that was listed, and what its delete did. */
    communities: { url: string; name: string; provider: SsoProvider; removal: Removal }[];
    /** Communities that couldn't be asked: nothing there was removed. */
    notAsked: { url: string; name: string }[];
}

/**
 * Remove everything (design §5.1): the vault's copies (`all`) when it listed one or couldn't say, and every copy each
 * community listed, the communities at once and each one's copies in turn. Never throws, never blocks on one keeper.
 */
export async function removeEverything(identity: BeanPoolIdentity, w: WaysBack): Promise<EverythingRemoved> {
    const askVaultToo = w.vault.kind === 'unknown' || (w.vault.kind === 'listed' && w.vault.copies.length > 0);
    const vault: Promise<Removal | null> = askVaultToo
        ? disconnectFromVault(identity, 'all').then((): Removal => ({ removed: true }), (e): Removal => ({ removed: false, why: notAnswered(e) }))
        : Promise.resolve(null);
    const communities = Promise.all(w.communities.filter(c => c.status).map(async c => {
        const done: EverythingRemoved['communities'] = [];
        for (const provider of c.status!.providers) {
            done.push({ url: c.url, name: c.name, provider, removal: await removeCommunityCopyFrom(identity, c, provider) });
        }
        return done;
    }));
    return {
        vault: await vault,
        communities: (await communities).flat(),
        notAsked: w.communities.filter(c => !c.status).map(({ url, name }) => ({ url, name })),
    };
}

/**
 * The member's say-so that their 12 words are written down, kept on the phone per account. Never asked: an account
 * whose "one way back" card heard "I still have my 12 words" counts as written down until the member says otherwise.
 */
export async function wordsWrittenDown(publicKey: string): Promise<boolean> {
    try {
        const v = await AsyncStorage.getItem(wordsWrittenDownStoreKey(publicKey));
        if (v === '1') return true;
        if (v === '0') return false;
    } catch {
        // Nothing read: as nothing said.
    }
    return (await readOneWayBack(publicKey))?.done === 'checked';
}

export async function noteWordsWrittenDown(publicKey: string, writtenDown: boolean): Promise<void> {
    await AsyncStorage.setItem(wordsWrittenDownStoreKey(publicKey), writtenDown ? '1' : '0').catch(() => {});
}
