/**
 * The peek ticket, the web app's half (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4; the node's
 * apps/server engine/peek-tickets.ts and routes/peek.ts; the shape, the link and the words are core's peek-ticket.ts):
 *
 *   - a member shares one listing, event or Pulse post outside the community: the node makes the ticket (a signed
 *     `POST /api/peek`) and the link is this community's own address with `?post=<id>&peek=<ticket>`;
 *   - Settings, Shared outside: the member's open links (`GET /api/peek/mine`) and Stop sharing (`POST /api/peek/stop`);
 *   - a stranger who opens the link in a browser (See it in your browser, on the node's share page) reads that one post
 *     here, unsigned (`GET /api/marketplace/posts/:id?peek=`), in the one-post peek (pages/PeekPage.tsx).
 */
import { peekFromLink, peekLink, readPeekShares, type PeekShare } from '@beanpool/core';
import type { MarketplacePost } from './api';
import { getNodeApiUrl, request } from './api';

/** `?post=<id>&peek=<ticket>` in this page's address, when both have their shapes: the post a stranger came to see. */
export function readPeekParam(win: Pick<Window, 'location'> = window): { postId: string; ticket: string } | null {
    return peekFromLink(`${win.location.pathname}${win.location.search || ''}`);
}

/**
 * The post a ticket opens, as the node answers a visitor (guestPost: nobody in it, its area only); or `stopped` where the
 * node answers that the link opens nothing now (stopped, run out, the post gone, sharing outside turned off: it answers
 * all of those alike, 401, 403 or 404); or `unreachable` where it couldn't be asked or gave no answer (no connection, a
 * 429, a 5xx), so a link that works isn't called dead: the phone's split (apps/native utils/peek.ts fetchPeekPost).
 * Unsigned on purpose: the ticket is the whole of what lets the read through, and a stranger here has no key.
 */
export async function getPeekPost(postId: string, ticket: string, fetcher: typeof fetch = fetch): Promise<MarketplacePost | 'stopped' | 'unreachable'> {
    try {
        const res = await fetcher(`${getNodeApiUrl()}/api/marketplace/posts/${encodeURIComponent(postId)}?peek=${encodeURIComponent(ticket)}`, {
            method: 'GET', cache: 'no-store', credentials: 'omit',
        });
        if (res.status === 401 || res.status === 403 || res.status === 404) return 'stopped';
        if (!res.ok) return 'unreachable';
        const body = await res.json() as { post?: MarketplacePost };
        return body?.post && body.post.id === postId ? body.post : 'stopped';
    } catch {
        return 'unreachable';
    }
}

/** A new link to share `postId` outside, from this community's address (`origin`). Throws the node's refusal in words. */
export async function makePeekLink(postId: string, origin: string): Promise<{ link: string; expiresAt: string }> {
    const made = await request<{ ticket: string; expiresAt: string; postId: string }>('POST', '/api/peek', { postId });
    return { link: peekLink(origin, made.postId || postId, made.ticket), expiresAt: made.expiresAt };
}

/** The member's open links, newest first. */
export async function getPeekShares(): Promise<PeekShare[]> {
    return readPeekShares(await request('GET', '/api/peek/mine'));
}

/** Stop one of them: it opens nothing from now. */
export async function stopPeekShare(id: string): Promise<void> {
    await request('POST', '/api/peek/stop', { id });
}

const ANDROID_PACKAGE = 'org.beanpool.pillar';
const PLAY_URL = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`;
const APP_STORE_URL = 'https://apps.apple.com/app/id6761870086';

/**
 * The peek's phone doors, as the node's share page has them (apps/server routes/peek.ts peekPageLinks): on Android the
 * app's peek screen by intent, falling back to Google Play with the peek in the install referrer (so the app opens on the
 * post after it is installed); on an iPhone the app by its own scheme, and the App Store; on a computer, none.
 */
export function peekAppDoors(postId: string, ticket: string, origin: string, ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): { app: string; store: string } | null {
    const id = encodeURIComponent(postId);
    const t = encodeURIComponent(ticket);
    const appQuery = `node=${encodeURIComponent(origin)}&post=${id}&peek=${t}`;
    if (/\bAndroid\b/i.test(ua)) {
        const store = `${PLAY_URL}&referrer=${encodeURIComponent(`peek=${ticket}&post=${postId}&server=${origin}`)}`;
        return { app: `intent://peek?${appQuery}#Intent;scheme=beanpool;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(store)};end`, store };
    }
    if (/\b(iPhone|iPad|iPod)\b/i.test(ua)) return { app: `beanpool://peek?${appQuery}`, store: APP_STORE_URL };
    return null;
}

/**
 * `?peek=` taken out of this page's address (the post stays, for takePostParam): a member's browser opens the post as
 * any shared link, and the ticket isn't left in the address bar to be copied on. Returns what the address carried.
 */
export function takePeekParam(win: Pick<Window, 'location' | 'history'> = window): { postId: string; ticket: string } | null {
    const peek = readPeekParam(win);
    const params = new URLSearchParams(win.location.search || '');
    if (!params.has('peek')) return peek;
    try {
        params.delete('peek');
        const qs = params.toString();
        win.history.replaceState(win.history.state, '', `${win.location.pathname}${qs ? `?${qs}` : ''}${win.location.hash || ''}`);
    } catch { /* the page still opens; the ticket just stays in the address bar */ }
    return peek;
}
