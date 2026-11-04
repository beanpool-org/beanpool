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
 * copy (about 18 KB) that has not drawn by then on a working connection is not coming. The phone counts from the last
 * bytes it received, so a slow phone that is still receiving is not cut off, but never past LIST_PHOTO_LONGEST_MS; the
 * web has no such event and counts from the start.
 */
export const LIST_PHOTO_WAIT_MS = 10_000;

/**
 * However many bytes are still arriving, a list card never waits longer than this for one picture. expo-image on Android
 * sends a progress event on every read of the response (react-native's ProgressResponseBody), so a response that sends
 * one byte every few seconds would start LIST_PHOTO_WAIT_MS again for ever. 30 s lets a whole photo (about 84 KB) arrive
 * at under 3 KB a second, a weak 2G link; a small copy that takes longer than that is trickling, not coming.
 */
export const LIST_PHOTO_LONGEST_MS = 30_000;

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
