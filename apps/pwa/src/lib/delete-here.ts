/**
 * Delete account in the web app, by the phone's rule (Marty, 2026-09-29; apps/native/utils/delete-here.ts): delete here,
 * keep the key for the member's other communities, and wipe it only at their last one.
 *
 * The web app keeps no list of communities. Its copy of the key lives in this web address's own storage (identity.ts:
 * IndexedDB is kept per web address), and serves the one community this web app talks to: the node that served the
 * page, or the one Advanced → Sovereign Node Connection points it at (`bp_node_url`, api.ts `getNodeApiUrl`). So the
 * only other community this copy can serve is the page's own node, while the web app is pointed at another
 * ({@link otherCommunityOfThisBrowser}). The phone app's copy, and the copy each other community's web address keeps,
 * are never touched by a delete here.
 *
 * - Pointed at another node, and the page's own node keeps the key (it says the key is a member there, or it can't be
 *   asked, so a poor connection never costs the key): the node deletes the account, then the web app goes back to the
 *   page's own node ({@link leaveThisCommunity}). The key stays.
 * - Otherwise this is the last community this copy serves: the delete wipes it, as before.
 */
import { getNodeApiUrl, setNodeApiUrl } from './api';

/** How long the page's own node has to answer, as the phone waits for each community. */
export const MEMBERSHIP_TIMEOUT_MS = 8000;

const NODE_URL_KEY = 'bp_node_url';

/**
 * What a community answered about the key. 'stranger' only when it said so plainly (`isMember: false` and not
 * recovering); no answer, an error, a timeout or an answer that isn't the membership route's is 'unreachable'.
 */
export type Membership = 'member' | 'stranger' | 'unreachable';

export type WebDeletePlan =
    /** The page's own node keeps the key: the delete leaves the node the web app is pointed at, and goes back to it. */
    | { kind: 'this-one'; here: string; keeps: { url: string; membership: 'member' | 'unreachable' } }
    /** The last community this browser's copy of the key serves: the delete wipes it. */
    | { kind: 'last'; here: string };

/** An address's origin, or null for one that isn't an http(s) address. */
function originOf(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
    } catch {
        return null;
    }
}

/** The host a member recognises: `mullum.beanpool.org`. */
export function hostOf(url: string): string {
    try {
        return new URL(url).host || url;
    } catch {
        return url;
    }
}

/**
 * The page's own node, when Advanced → Sovereign Node Connection points this web app at another (the member's setting
 * in this browser, not a build's fixed address): the one other community this browser's copy of the key can serve.
 * Null otherwise.
 */
export function otherCommunityOfThisBrowser(): string | null {
    let pointed: string | null;
    try {
        pointed = localStorage.getItem(NODE_URL_KEY);
    } catch {
        return null;
    }
    const there = originOf(pointed);
    const page = originOf(typeof window !== 'undefined' ? window.location.origin : null);
    return there && page && there !== page ? page : null;
}

/** The node this web app deletes at, as api.ts sends it the purge: the one it is pointed at, or the page's own. */
function thisCommunity(): string {
    return getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
}

/** GET /api/community/membership/<key> at `community`, as the phone asks it. Never throws; gives up at `timeoutMs`. */
export async function membershipAt(community: string, publicKey: string, timeoutMs: number = MEMBERSHIP_TIMEOUT_MS): Promise<Membership> {
    const base = originOf(community);
    if (!base) return 'unreachable';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}/api/community/membership/${publicKey}`, {
            headers: { Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
        });
        if (!res.ok) return 'unreachable';
        const data: unknown = await res.json();
        if (!data || typeof data !== 'object') return 'unreachable';
        const { isMember, isRecovering } = data as { isMember?: unknown; isRecovering?: unknown };
        if (isMember === true || isRecovering === true) return 'member';
        return isMember === false ? 'stranger' : 'unreachable';
    } catch {
        return 'unreachable';
    } finally {
        clearTimeout(timer);
    }
}

/** What Delete account will do in this browser, asked as the member opens it so the screen can say it. Never throws. */
export async function planWebDelete(publicKey: string, timeoutMs: number = MEMBERSHIP_TIMEOUT_MS): Promise<WebDeletePlan> {
    const here = thisCommunity();
    const other = otherCommunityOfThisBrowser();
    if (!other) return { kind: 'last', here };
    const membership = await membershipAt(other, publicKey, timeoutMs);
    return membership === 'stranger' ? { kind: 'last', here } : { kind: 'this-one', here, keeps: { url: other, membership } };
}

/**
 * Once the node the web app is pointed at has deleted the account ({@link WebDeletePlan} 'this-one'): the web app goes
 * back to the page's own node. The key, its 12 words and the browser's settings stay.
 */
export function leaveThisCommunity(): void {
    setNodeApiUrl(null);
}

// ── What the web app says ──────────────────────────────────────────────────────────────────────────────────────

/** Settings' Permanently Delete Account card, before anything is asked. */
export const WEB_DELETE_CARD_LINE =
    'Permanently purges your account from this community node. Cancels active posts, clears push tokens, and settles ' +
    'your balance with the Commons Pool. Your key leaves this browser unless another community this web app opens ' +
    "still has you. The phone app, and other communities' web addresses, keep their own copy.";

/** While the page's own node is asked. */
export const WEB_DELETE_CHECKING_LINE = 'Checking whether this browser still needs your key…';

/** What stays: the page's own node keeps the key. */
export function webKeepsKeyLine(plan: Extract<WebDeletePlan, { kind: 'this-one' }>, hasWords: boolean): string {
    const what = hasWords ? 'Your key and 12 words stay' : 'Your key stays';
    const home = hostOf(plan.keeps.url);
    const lines = [
        `${what} in this browser, for ${home}, the community this web address belongs to.`,
        `After the delete at ${hostOf(plan.here)}, the web app goes back to ${home}.`,
    ];
    if (plan.keeps.membership === 'unreachable') lines.push(`${home} couldn't be reached, so it counts as a community you are still in.`);
    return lines.join(' ');
}

/** The last community this browser's copy serves: the key goes. */
export function webLastCommunityLine(hasWords: boolean): string {
    return hasWords
        ? "Your key and 12 words leave this browser, for this web address. The phone app, and other communities' web " +
          'addresses, keep their own copy. Write your 12 words down first if you use them anywhere else.'
        : "Your key leaves this browser, for this web address. The phone app, and other communities' web addresses, " +
          'keep their own copy.';
}

/** The node did not delete the account: nothing in this browser changed. */
export function webDeleteFailedLine(reason: string): string {
    return `${reason} Nothing was removed from this browser: your key is still here.`;
}

/** The node deleted the account, but this browser could not be cleared. */
export function webDeletedButLine(reason: string): string {
    return `Your account was deleted, but this browser couldn't be cleared (${reason}). Use Sign Out (Device Only) to finish.`;
}
