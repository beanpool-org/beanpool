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
 *   removed there, so the only date it has is the last change, not the copy's. The same answer lists the copy its admins
 *   can bring the member back from (`communityCopy`, vault rethink VR3), with since when, wherever it was turned on.
 * - **Deletes asked for that haven't landed** (the move card's list, utils/vault-move.ts): shown as not yet removed, and
 *   tried again before every listing, at app open (app/_layout.tsx) and when the move card looks.
 *
 * ## Removing (never a false "removed")
 *
 * - A vault copy is removed only on the vault's signed `deleted` answer (utils/vault.ts `disconnectFromVault`); a
 *   community's only on its own answer: a 2xx naming the copy removed, or its 404 for a copy already gone (never a
 *   proxy's page, vault-move.ts `removeCommunityCopy`). Anything short of that is "not removed", and a community's
 *   delete is then remembered and tried again (with the guard against a newer copy, vault-move.ts). The copy for a
 *   community's admins (VR3) goes on its own answer too; one that doesn't land is said as not removed, never remembered.
 *   A shared copy (VR4) is one way back in two places, so one Remove asks both, the vault first.
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
import { communityRefFor } from './community-recovery';
import { disconnectCommunityCopy, disconnectFromVault, hasVault, vaultStatus, VaultError } from './vault';
import { communityCopyStatus, deleteOrRemember, pendingCommunityRemovals, removeAdminsCopy, retryCommunityRemovals } from './vault-move';
import { sameCommunity, type CommunityPart, type NotAnswered, type Removal, type VaultPart, type WaysBack } from './ways-back-state';

export {
    beforeRemoving, everyoneAnswered, isPending, knownCopies, sameCommunity, strayVaultHalves, unopenableAdminsCopies, vaultCopiesBySignIn, vaultHalfOf, vaultHalves, wordsOnly,
    type BeforeRemoving, type CommunityPart, type CopyAt, type NotAnswered, type Removal, type VaultPart, type WaysBack,
} from './ways-back-state';

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
        Promise.all(places.map(async (p): Promise<CommunityPart> => {
            const status = await communityCopyStatus(identity, p.url);
            return { ...p, status, vaultRef: labelOf(identity, status?.nodeKey) };
        })),
        pendingCommunityRemovals(identity),
    ]);
    return { vault, communities, pending };
}

/** This member's label for a community at the vault, from the node key it said; null when it said none. */
function labelOf(identity: BeanPoolIdentity, nodeKey: string | null | undefined): string | null {
    if (!nodeKey || !hasVault()) return null;
    try {
        return communityRefFor(identity, nodeKey);
    } catch {
        return null;
    }
}

async function askVault(identity: BeanPoolIdentity): Promise<VaultPart> {
    if (!hasVault()) return { kind: 'no-vault' };
    try {
        const { copies, communityCopies } = await vaultStatus(identity);
        return { kind: 'listed', copies, communityCopies };
    } catch (e) {
        const why = notAnswered(e);
        return { kind: 'unknown', why: why === 'refused' ? 'unreachable' : why };
    }
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
 * again (`remembered`), guarded by its copies as the member saw them (`status`: the generation, and what was listed).
 */
export async function removeCommunityCopyFrom(
    identity: BeanPoolIdentity, community: CommunityPart, provider: SsoProvider,
): Promise<Removal> {
    const { gone } = await deleteOrRemember(identity, community.url, provider, community.status);
    return gone ? { removed: true } : { removed: false, why: 'remembered' };
}

/**
 * Remove the copy a community keeps for its admins to bring the member back from (vault rethink VR3): removed on the
 * community's own answer; otherwise not removed, and not remembered (vault-move.ts `removeAdminsCopy`). A shared copy
 * (VR4) goes from the vault first (`vaultToo`), on its signed answer: half a pair left there is what can be tried again.
 * A whole copy never asks the vault, which has nothing of it and may be paused.
 */
export async function removeAdminsCopyFrom(identity: BeanPoolIdentity, community: CommunityPart, opts: { vaultToo?: boolean } = {}): Promise<Removal> {
    if (opts.vaultToo && community.vaultRef) {
        const atVault = await removeVaultHalf(identity, community.vaultRef);
        if (!atVault.removed) return atVault;
    }
    return (await removeAdminsCopy(identity, community.url)) ? { removed: true } : { removed: false, why: 'unreachable' };
}

/** Remove the vault's community copy with this label: removed only on the vault's signed answer. */
export async function removeVaultHalf(identity: BeanPoolIdentity, ref: string): Promise<Removal> {
    try {
        await disconnectCommunityCopy(identity, ref);
        return { removed: true };
    } catch (e) {
        return { removed: false, why: notAnswered(e) };
    }
}

export interface EverythingRemoved {
    /** The vault's answer, or null when nothing was asked of it (no vault in this build, or it listed no copy). */
    vault: Removal | null;
    /** Each community copy that was listed, and what its delete did. */
    communities: { url: string; name: string; provider: SsoProvider; removal: Removal }[];
    /** Each copy a community keeps for its admins to bring the member back from (VR3), and what its delete did. */
    admins: { url: string; name: string; removal: Removal }[];
    /** Communities that couldn't be asked: nothing there was removed. */
    notAsked: { url: string; name: string }[];
}

/**
 * Remove everything (design §5.1): the vault's copies (`all`) when it listed one or couldn't say, and every copy each
 * community listed, its admins' copy included, the communities at once and each one's copies in turn. Never throws,
 * never blocks on one keeper.
 */
export async function removeEverything(identity: BeanPoolIdentity, w: WaysBack): Promise<EverythingRemoved> {
    const askVaultToo = w.vault.kind === 'unknown' || (w.vault.kind === 'listed' && w.vault.copies.length + (w.vault.communityCopies?.length ?? 0) > 0);
    const vault: Promise<Removal | null> = askVaultToo
        ? disconnectFromVault(identity, 'all').then((): Removal => ({ removed: true }), (e): Removal => ({ removed: false, why: notAnswered(e) }))
        : Promise.resolve(null);
    const communities = Promise.all(w.communities.filter(c => c.status).map(async c => {
        const done: EverythingRemoved['communities'] = [];
        // A delete that doesn't land is remembered with the community's copies as the member saw them, moved on by each of
        // these deletes that lands (the community's answer one above it is this phone's own change, utils/vault-move.ts).
        // A sibling removed meanwhile is one of the others it remembers, so its retry is never dropped as if someone had
        // changed the copies there, even when a delete of this phone's landed with its answer lost.
        let seen = c.status!;
        for (const provider of c.status!.providers) {
            const d = await deleteOrRemember(identity, c.url, provider, seen);
            if (d.gone && seen.generation !== null && d.generation === seen.generation + 1) {
                seen = { providers: seen.providers.filter(p => p !== provider), generation: d.generation };
            }
            done.push({ url: c.url, name: c.name, provider, removal: d.gone ? { removed: true } : { removed: false, why: 'remembered' } });
        }
        return done;
    }));
    // A copy a community keeps for its admins but can't open goes too: it is still the member's key, there.
    const admins = Promise.all(w.communities.filter(c => c.status?.adminsCopy || c.status?.adminsCopyUnopenable).map(async c => (
        // The vault's half goes with the vault's `all` above, whether or not this phone can tell it from another's.
        { url: c.url, name: c.name, removal: await removeAdminsCopyFrom(identity, c) }
    )));
    return {
        vault: await vault,
        communities: (await communities).flat(),
        admins: await admins,
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
