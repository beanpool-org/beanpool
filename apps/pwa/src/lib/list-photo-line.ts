/**
 * The browser's line for list photos, one per host (review of #2853, round 3: on a slow link the Market page stepped its
 * later cards down before their requests had started, and they stayed on their tile for good).
 *
 * Over HTTP/1.1 a browser runs at most 6 requests to one host at once (Chromium, Firefox and Safari alike); the rest wait
 * their turn, and an <img> waiting its turn fires no event. Nor does the page see a request start: Resource Timing lists a
 * request only once it has ended, and an IntersectionObserver says only that the <img> is in view. So the page keeps the
 * same line itself. A photo joins it when the browser asks for it (lib/use-list-photo-steps.ts: at once for an eager
 * <img>, once a lazy one is in view) and leaves it once it has drawn, failed, moved to another URL or gone. Its turn has
 * come once fewer than PHOTOS_AT_ONCE photos for its host are ahead of it, and its wait starts then, never before.
 *
 * Where the line differs from the browser's, a turn comes later than the request starts, or earlier, and both are safe:
 *  - later: over HTTP/2 every request starts at once, and two cards with one URL make one request; the wait only starts
 *    later, and the tile holds the slot meanwhile;
 *  - earlier: another request to the host (an API read, a URL a card has moved past that the browser still downloads, a
 *    lazy photo the browser asks for before it is in view, as it does within its lazy-load distance) can hold a place in
 *    the browser's line that this one does not count. The wait after a turn is the phone's budget for a load that may
 *    still be queued (LIST_PHOTO_QUEUED_MS), not the short one.
 * A photo whose turn has come leaves within its wait, so the line always moves, and a request that never ends (the one
 * the wait is for) is stepped down in the end however many are ahead of it.
 */

/** How many requests a browser runs to one host at once over HTTP/1.1. */
export const PHOTOS_AT_ONCE = 6;

type Place = { started: boolean; onTurn: () => void };
const lines = new Map<string, Place[]>();

/** The host a photo is asked from; null for one that needs no request to a host (`data:`, `blob:`). */
function hostOf(src: string): string | null {
    try {
        const url = new URL(src, typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : null;
    } catch {
        return null;
    }
}

function moveOn(host: string) {
    const line = lines.get(host);
    if (!line) return;
    if (line.length === 0) { lines.delete(host); return; }
    for (const place of line.slice(0, PHOTOS_AT_ONCE)) {
        if (place.started) continue;
        place.started = true;
        place.onTurn();
    }
}

/**
 * `src` joins the back of its host's line; `onTurn` is called once, when its turn comes (at once if fewer than
 * PHOTOS_AT_ONCE are ahead of it, or if it needs no host). Call what it answers when the photo leaves the line.
 */
export function joinPhotoLine(src: string, onTurn: () => void): () => void {
    const host = hostOf(src);
    if (!host) {
        onTurn();
        return () => {};
    }
    const place: Place = { started: false, onTurn };
    const line = lines.get(host) ?? [];
    line.push(place);
    lines.set(host, line);
    moveOn(host);
    return () => {
        const now = lines.get(host);
        const at = now ? now.indexOf(place) : -1;
        if (!now || at < 0) return;
        now.splice(at, 1);
        moveOn(host);
    };
}

/** How many photos are in a host's line, and how many of them have had their turn (tests). */
export function photoLineFor(src: string): { waiting: number; started: number } {
    const host = hostOf(src);
    const line = (host && lines.get(host)) || [];
    return { waiting: line.length, started: line.filter((p) => p.started).length };
}
