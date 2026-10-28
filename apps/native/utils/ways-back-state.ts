/**
 * What "Where your account can be brought back from" found, and what it means (vault rethink VR1; utils/ways-back.ts
 * asks and removes, components/WaysBackList.tsx draws). Plain data and plain decisions, with no storage, network or key
 * here, so the list can be drawn anywhere it is checked (the words render test, the 320 dp shots).
 */
import type { SsoProvider } from './sso-providers';
import type { VaultCopy } from './vault';
import type { CommunityCopyStatus, PendingRemoval } from './vault-move';

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
    const left = removing === 'everything' ? [] : knownCopies(w).filter(c => !sameCopy(c, removing));
    if (left.length > 0 || phone.writtenDown) return 'confirm';
    return phone.hasWords ? 'show-words-first' : 'no-words-on-phone';
}
