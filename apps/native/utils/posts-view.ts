/**
 * Which view of the listings a node sent, and whether this phone may keep it (G9c; the server's half is
 * G9a, scratch/global-node/DESIGN-g9a-guest-view-fable.md §2 and §7).
 *
 * On a node that shows visitors the listings but not the people (the global community), every posts
 * answer says which view it is in `X-BeanPool-View`: `member`, the full listing, or `guest`, the same
 * listing with each person neutralised (author `'hidden'`, names empty, the rough area instead of the
 * point). A member's phone whose request went out unsigned (the signing wrapper is best-effort,
 * node-request-signing.ts) would be sent the guest view, and writing it would put `'hidden'` authors and
 * area centres over the rows it holds until each post next changed. So a guest view reaching a phone
 * that expects the member's is treated as a failed fetch: nothing is written, and the next sync asks again.
 *
 * No header is today's behaviour (every node before G9a, and every local node): the answer is kept.
 */

import { isGuestNode } from './nodes';

export const VIEW_HEADER = 'X-BeanPool-View';

export type PostsView = 'member' | 'guest';

/** The author a guest view puts on every listing: a constant, so it links no two listings together. */
export const HIDDEN_AUTHOR = 'hidden';

/** An author nobody can open: a guest view's placeholder, or no author at all. */
export function isHiddenAuthor(pubkey: string | null | undefined): boolean {
    return !pubkey || pubkey === HIDDEN_AUTHOR;
}

/** The view a response says it is, or null when it says nothing this phone knows. */
export function viewOf(res: { headers?: { get?(name: string): string | null } } | null | undefined): PostsView | null {
    const raw = res?.headers?.get?.(VIEW_HEADER);
    const view = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return view === 'member' || view === 'guest' ? view : null;
}

/**
 * What this phone expects from `anchorUrl`: `member` when it holds a key and has not chosen to visit that
 * node as a guest (nodes.ts `markGuestNode`), otherwise `guest`.
 */
export async function expectedView(anchorUrl: string, publicKey: string | null | undefined): Promise<PostsView> {
    if (!publicKey) return 'guest';
    try {
        return (await isGuestNode(anchorUrl)) ? 'guest' : 'member';
    } catch {
        return 'member';
    }
}

/**
 * Why a posts answer must not be written, or null when it may be. Only a guest view reaching a phone
 * that expects the member's is refused; the member's view is never less than a guest may see, and no
 * header is today's behaviour. The expected view is only worked out when the answer is a guest view.
 */
export async function postsViewRefusal(
    res: { headers?: { get?(name: string): string | null } } | null | undefined,
    anchorUrl: string,
    publicKey: string | null | undefined,
): Promise<string | null> {
    if (viewOf(res) !== 'guest') return null;
    if ((await expectedView(anchorUrl, publicKey)) !== 'member') return null;
    return 'The node sent the visitors\' view of the listings to a member; not saved';
}
