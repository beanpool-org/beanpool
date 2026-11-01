/**
 * What "Where your account can be brought back from" found, and what it means (vault rethink VR1; utils/ways-back.ts
 * asks and removes, components/WaysBackList.tsx draws). Plain data and plain decisions, with no storage, network or key
 * here, so the list can be drawn anywhere it is checked (the words render test, the 320 dp shots).
 */
import type { SsoProvider } from './sso-providers';
import type { VaultCommunityCopy, VaultCopy } from './vault';
import type { CommunityCopyStatus, PendingRemoval } from './vault-move';

/** Why a keeper couldn't say, or didn't remove: paused (the vault, locked), no answer, or one that didn't check out. */
export type NotAnswered = 'paused' | 'unreachable' | 'unverified';

export type VaultPart =
    /** This build keeps no copies at BeanPool's key vault: nothing is asked there, and nothing is said about it. */
    | { kind: 'no-vault' }
    /** `communityCopies`: half a key and a copy it can't open, for a community's admins (vault rethink VR4). */
    | { kind: 'listed'; copies: VaultCopy[]; communityCopies?: VaultCommunityCopy[] }
    /** The vault couldn't say. Its copies, if it keeps any, are neither listed nor said to be gone. */
    | { kind: 'unknown'; why: NotAnswered };

export interface CommunityPart {
    url: string;
    /** The name this phone saved it under, or its address. */
    name: string;
    /** Its answer about this key's copies, or null when it gave none: never read as "none". */
    status: CommunityCopyStatus | null;
    /** This member's label for it at the vault, when it said its node key: how this phone knows which vault copy is this one's. */
    vaultRef?: string | null;
}

export interface WaysBack {
    vault: VaultPart;
    communities: CommunityPart[];
    /** Deletes this phone was asked for that haven't landed yet. */
    pending: PendingRemoval[];
}

/**
 * One copy to remove: a sign-in's at the vault, a sign-in's at a community, or the copy a community's admins can bring
 * the member back from (`admins`: "Your community's admins", vault rethink VR3), one per community.
 */
export type CopyAt =
    | { at: 'vault'; provider: SsoProvider }
    | { at: 'community'; url: string; provider: SsoProvider }
    | { at: 'admins'; url: string }
    /** A community copy at the vault no community saved on this phone can be keeping the rest of: it goes alone, by its label. */
    | { at: 'vault-half'; ref: string };

/**
 * What a removal did. `remembered`: a community's delete that didn't land, kept and tried again. `vault-unreachable`: a shared
 * copy's Remove stopped at the vault, asked first, for want of an answer (`unreachable` there is the community's).
 */
export type Removal = { removed: true } | { removed: false; why: NotAnswered | 'refused' | 'remembered' | 'vault-unreachable' };

/** Two addresses of one community, as the phone saves them (case and a trailing slash aside). */
export function sameCommunity(a: string, b: string): boolean {
    const plain = (u: string) => u.trim().replace(/\/+$/, '').toLowerCase();
    return plain(a) === plain(b);
}

/**
 * The vault's copies by sign-in, in the order it lists them. It keeps one for each sign-in account, so a member who linked
 * two Google accounts has two under Google, and its Remove takes both: the vault removes a sign-in's copies together.
 */
export function vaultCopiesBySignIn(copies: VaultCopy[]): { provider: SsoProvider; copies: VaultCopy[] }[] {
    const out: { provider: SsoProvider; copies: VaultCopy[] }[] = [];
    for (const c of copies) {
        const same = out.find(g => g.provider === c.provider);
        if (same) same.copies.push(c);
        else out.push({ provider: c.provider, copies: [c] });
    }
    return out;
}

/** Whether a community's copy for `provider` is waiting to be removed (its delete didn't land yet). */
export function isPending(w: WaysBack, url: string, provider: SsoProvider): boolean {
    return w.pending.some(p => p.provider === provider && sameCommunity(p.url, url));
}

/** The community copies the vault lists: half a key each (VR4). */
export function vaultHalves(w: WaysBack): VaultCommunityCopy[] {
    return w.vault.kind === 'listed' ? w.vault.communityCopies ?? [] : [];
}

/**
 * Whether Remove everything asks the vault: it listed a copy of either kind, or it couldn't say. The one test for the delete
 * and for its confirm, so a member is never asked about less than goes (a shared copy's half is a vault copy too).
 */
export function removeEverythingAsksVault(w: WaysBack): boolean {
    return w.vault.kind === 'unknown' || (w.vault.kind === 'listed' && w.vault.copies.length + vaultHalves(w).length > 0);
}

/** The vault's copy that goes with community `c`'s half, or undefined. */
export function vaultHalfOf(w: WaysBack, c: CommunityPart): VaultCommunityCopy | undefined {
    return c.vaultRef ? vaultHalves(w).find(h => h.ref === c.vaultRef) : undefined;
}

/**
 * Whether what community `c` keeps for its admins can bring the member back: its whole copy, or its half with the vault's
 * half of the very same copy. Half a pair brings nobody back.
 */
function adminsCopyWorks(w: WaysBack, c: CommunityPart): boolean {
    const copy = c.status?.adminsCopy;
    if (!copy) return false;
    return copy.placement !== 'shared' || vaultHalfOf(w, c)?.copy === copy.copy;
}

/**
 * Whether community `c` could hold the other half of a vault copy nobody has claimed: it didn't answer, or it says it keeps a
 * half, or a copy it can't open, and gave no node key to tell which (a server still starting has none to give). One that says
 * what it keeps, and that is no half, holds none, whatever it said of its key: a server from before VR4 says nothing of it.
 */
function mayHoldAHalf(c: CommunityPart): boolean {
    if (c.vaultRef) return false;
    return !c.status || c.status.adminsCopy?.placement === 'shared' || !!c.status.adminsCopyUnopenable;
}

/** The vault's community copies no community on this phone has said are its own. */
function unclaimedVaultHalves(w: WaysBack): VaultCommunityCopy[] {
    return vaultHalves(w).filter(h => !w.communities.some(c => c.vaultRef === h.ref));
}

/**
 * The unclaimed halves no community on this phone can be keeping the rest of: listed and removable, never a way back. A
 * community's silence is never read as "not mine" (#2683 review): that half may be one half of a working pair, and Remove here
 * deletes it for good.
 */
export function strayVaultHalves(w: WaysBack): VaultCommunityCopy[] {
    return w.communities.some(mayHoldAHalf) ? [] : unclaimedVaultHalves(w);
}

/**
 * The unclaimed halves a community that hasn't said may be keeping the rest of: listed, as everything the vault lists is, with
 * no Remove of their own until it says. Remove everything still takes them, and says what stays.
 */
export function unplacedVaultHalves(w: WaysBack): VaultCommunityCopy[] {
    return w.communities.some(mayHoldAHalf) ? unclaimedVaultHalves(w) : [];
}

/**
 * Whether community `c`'s half has lost the vault's: the vault listed, and has no half of this copy for it. With no label for
 * `c`, an unclaimed half may be the very one, so that is never said; a vault that lists no half at all has none for anyone.
 */
export function otherHalfMissing(w: WaysBack, c: CommunityPart): boolean {
    if (w.vault.kind !== 'listed' || (!c.vaultRef && unclaimedVaultHalves(w).length > 0)) return false;
    return vaultHalfOf(w, c)?.copy !== c.status?.adminsCopy?.copy;
}

/**
 * Every copy this phone knows is kept now, not counting ones waiting to be removed. A copy a community keeps for its
 * admins but can't open (`adminsCopyUnopenable`) is not one: it brings nobody back, so it is listed but never counted.
 * Nor is half of a shared copy without the other half (VR4).
 */
export function knownCopies(w: WaysBack): CopyAt[] {
    const out: CopyAt[] = [];
    if (w.vault.kind === 'listed') for (const c of w.vault.copies) out.push({ at: 'vault', provider: c.provider });
    for (const c of w.communities) {
        for (const provider of c.status?.providers ?? []) {
            if (!isPending(w, c.url, provider)) out.push({ at: 'community', url: c.url, provider });
        }
        if (adminsCopyWorks(w, c)) out.push({ at: 'admins', url: c.url });
    }
    return out;
}

function sameCopy(a: CopyAt, b: CopyAt): boolean {
    if (a.at === 'vault') return b.at === 'vault' && a.provider === b.provider;
    if (a.at === 'admins') return b.at === 'admins' && sameCommunity(a.url, b.url);
    if (a.at === 'vault-half') return b.at === 'vault-half' && a.ref === b.ref;
    return b.at === 'community' && a.provider === b.provider && sameCommunity(a.url, b.url);
}

/** Whether every keeper answered: the vault (when the build has one) and every saved community. */
export function everyoneAnswered(w: WaysBack): boolean {
    return w.vault.kind !== 'unknown' && w.communities.every(c => c.status !== null);
}

/** The communities that keep a copy for their admins they can't open now: listed, removable, never a way back. */
export function unopenableAdminsCopies(w: WaysBack): CommunityPart[] {
    return w.communities.filter(c => !c.status?.adminsCopy && !!c.status?.adminsCopyUnopenable);
}

/**
 * Nothing kept anywhere this phone can ask: every keeper answered, none keeps a copy, and no delete is waiting. The
 * member's 12 words are then their way back (with an admin's re-key, to a new key, when they are lost too). A copy a
 * community can't open is no way back, but it is kept: never "nothing is kept" while one is listed (its row says the
 * 12 words still work).
 */
export function wordsOnly(w: WaysBack): boolean {
    return everyoneAnswered(w) && knownCopies(w).length === 0 && w.pending.length === 0 && unopenableAdminsCopies(w).length === 0
        && vaultHalves(w).length === 0 && !w.communities.some(c => c.status?.adminsCopy);
}

/**
 * What to ask before a removal. One that leaves another copy this phone knows of, or with the 12 words marked written
 * down: an ordinary confirm. One that would leave none (the last copy, or everything): "Show my 12 words first?" on a
 * phone that has them; what is then left, said plainly, on a phone without. A copy waiting to be removed, and a keeper
 * that couldn't say, are never counted as a way back that stays. It never refuses: the member decides.
 */
export type BeforeRemoving = 'confirm' | 'show-words-first' | 'no-words-on-phone';

export function beforeRemoving(
    w: WaysBack, removing: CopyAt | 'everything', phone: { hasWords: boolean; writtenDown: boolean },
): BeforeRemoving {
    // Removing what brings nobody back (a copy its community can't open, half a pair) takes no way back away: an ordinary ask.
    if (removing !== 'everything' && (removing.at === 'vault-half' || (removing.at === 'admins' && !knownCopies(w).some(c => sameCopy(c, removing))))) return 'confirm';
    const left = removing === 'everything' ? [] : knownCopies(w).filter(c => !sameCopy(c, removing));
    if (left.length > 0 || phone.writtenDown) return 'confirm';
    return phone.hasWords ? 'show-words-first' : 'no-words-on-phone';
}
