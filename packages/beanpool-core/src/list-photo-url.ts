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

export function listPhotoUrl<T extends string | null | undefined>(url: T): T {
    if (typeof url !== 'string' || !LISTING_PHOTO.test(url) || /[?&]size=/.test(url)) return url;
    const hash = url.indexOf('#');
    const base = hash < 0 ? url : url.slice(0, hash);
    const tail = hash < 0 ? '' : url.slice(hash);
    return `${base}${base.includes('?') ? '&' : '?'}size=thumb2${tail}` as T;
}

/**
 * What a list card draws next when the picture it showed would not load: a listing photo's small copy gives way to the
 * photo's own URL (the same URL without `size=thumb2`), and that gives way to nothing (null), where the card draws its
 * category tile and never an empty slot. `photo` is the URL the listing carries; `failed` is the URL the card was drawing.
 *
 * Each step happens once: the photo's own URL has no step after it, and a URL that has no small copy (a banner, an
 * avatar, a `data:` photo, a URL that already names a size) goes straight to null, so a card cannot loop. A card holds
 * the URL it gave up on beside the `photo` it was for, so a new URL a later read brings starts the steps again.
 */
export function nextListPhotoUrl(photo: string, failed: string | null | undefined): string | null {
    return failed === listPhotoUrl(photo) && failed !== photo ? photo : null;
}
