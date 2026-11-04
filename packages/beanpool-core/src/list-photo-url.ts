/**
 * The URL a list draws a listing photo from: the node's small copy of it (shortest side 320 px, `size=thumb2`, apps/server
 * storage/photo-thumbnails.ts) instead of the 800 px photo. A Market page of 20 rows was 20 full photos on prepaid data
 * (Marty, board, 9 Oct). The detail screens keep the photo's own URL.
 *
 * Only a listing photo's URL (`/api/marketplace/posts/<id>/photos/<n>`, relative or on a node) is changed; anything
 * else (a `data:` photo not yet sent, an avatar, a link elsewhere) comes back as it was. The route checks the URL's key
 * and every other gate before it looks at `size`, so the small copy goes to exactly whoever the photo goes to.
 */
const LISTING_PHOTO = /^(?:https?:\/\/[^/?#]+)?\/api\/marketplace\/posts\/[^/?#]+\/photos\/\d+(?:[?#]|$)/;

/** `url` with `param` added to its query, before any `#`. */
function withParam(url: string, param: string): string {
    const hash = url.indexOf('#');
    const base = hash < 0 ? url : url.slice(0, hash);
    const tail = hash < 0 ? '' : url.slice(hash);
    return `${base}${base.includes('?') ? '&' : '?'}${param}${tail}`;
}

export function listPhotoUrl<T extends string | null | undefined>(url: T): T {
    if (typeof url !== 'string' || !LISTING_PHOTO.test(url) || /[?&]size=/.test(url)) return url;
    return withParam(url, 'size=thumb2') as T;
}

/**
 * How long a list card waits for its picture before it counts it as failed (card-photo-blank, Marty 4 Nov 2026: a card
 * on global showed an empty slot through two restarts while its small copy was served fine). Neither picture library
 * bounds a load that never ends: on Android expo-image's OkHttp client keeps OkHttp's defaults (10 s to connect, 10 s per
 * read, no limit on the whole call), so a response that trickles never fails, and a load that waits for a size or is
 * paused sends no event at all; an <img> on the web has no limit either. 10 s is OkHttp's own per-read limit: a small
 * copy (about 18 KB) that has not drawn by then on a working connection is not coming. The phone counts it from the last
 * bytes it received, so a slow phone that is still receiving is not cut off (never past LIST_PHOTO_LONGEST_MS), and waits
 * LIST_PHOTO_QUEUED_MS for the first bytes. The web has no progress event and counts from when the browser asks for the
 * picture: at once for an eager <img>, once a lazy one is in view.
 */
export const LIST_PHOTO_WAIT_MS = 10_000;

/**
 * However many bytes are still arriving, a list card on the phone never waits longer than this from its picture's first
 * bytes. expo-image on Android sends a progress event on every read of the response (react-native's ProgressResponseBody),
 * so a response that sends one byte every few seconds would start LIST_PHOTO_WAIT_MS again for ever. Counted from the
 * first bytes, not from when the card was shown, because a picture can wait its turn first (LIST_PHOTO_QUEUED_MS). 60 s
 * lets a small copy (about 18 KB) arrive at 0.3 KB a second: the five pictures OkHttp fetches at once from one node,
 * sharing a 1.5 KB/s link. A small copy slower than that is trickling, not coming; the tile is on screen all the while.
 */
export const LIST_PHOTO_LONGEST_MS = 60_000;

/**
 * How long a list card on the phone waits for its picture's first bytes once its load has started (expo-image's
 * onLoadStart), before it counts the picture as failed (review of #2853, finding 3). onLoadStart comes when the Image hands
 * the URL to Glide, before the request leaves OkHttp's queue: Glide 5's OkHttp fetcher calls `enqueue`, and OkHttp 4.12's
 * Dispatcher runs at most 5 requests to one host at once, so the rest of a Market screen's cards wait there with no event.
 * A request that is running and gets no bytes is failed by OkHttp itself (10 s to connect, 10 s per read) through
 * onError; this only bounds a load that is lost without an event. 60 s: at 50 KB/s about 160 small copies come down in
 * that time, so a card that far back in the queue still gets its turn; at a weak 2G 3 KB/s, about 10. A load that has not
 * started at all (no onLoadStart: on Android, its view has no size yet) is not waited on: a new URL would wait the same
 * way, and the tile holds the slot.
 */
export const LIST_PHOTO_QUEUED_MS = 60_000;

/**
 * What a list card draws next when the picture it showed would not load (or did not load within LIST_PHOTO_WAIT_MS):
 * a listing photo's small copy is asked once more past every cache (`retry=1`: a new address, so no bad copy the phone,
 * the browser or a shared cache keeps under the first one can answer it; the node reads only `k` and `size`); that gives
 * way to the photo's own URL (the same URL without `size=thumb2`, which the detail screen draws), and that gives way to
 * nothing (null), where the card draws its category tile and never an empty slot. `photo` is the URL the listing
 * carries; `failed` is the URL the card was drawing.
 *
 * Each step happens once: the photo's own URL has no step after it, and a URL that has no small copy (a banner, an
 * avatar, a `data:` photo, a URL that already names a size) goes straight to null, so a card cannot loop. A card holds
 * the URL it gave up on beside the `photo` it was for, so a new URL a later read brings starts the steps again.
 */
export function nextListPhotoUrl(photo: string, failed: string | null | undefined): string | null {
    const small = listPhotoUrl(photo);
    if (small === photo || !failed) return null;
    const again = withParam(small, 'retry=1');
    if (failed === small) return again;
    if (failed === again) return photo;
    return null;
}
