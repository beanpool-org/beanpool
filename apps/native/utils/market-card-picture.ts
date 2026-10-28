import { eventCoverPhoto } from './events';

/**
 * A Market card's picture (Pictures S6, DESIGN-pictures-fable §3.1): the listing's own first photo, else its enterprise's
 * shop banner (`authorBannerUrl`, which the node names on an enterprise's listing alone; db.ts getPosts reads it back from
 * the phone's copy, the server search maps it from the node's answer, both on the node's address), else null and the
 * card draws its CategoryTile. `cover` is the listing's own photo alone: only that one is healed when it fails to load
 * (refreshListingAfterPhotoError), never the shop's banner.
 */
export function marketCardPicture(item: any): { cover: string | null; picture: string | null } {
    const cover = eventCoverPhoto(item);
    return { cover, picture: cover ?? usableUrl(item?.authorBannerUrl) ?? usableUrl(item?.author_banner_url) };
}

/** A URL, or null for anything else: an empty string, or a placeholder SQLite hands back for a missing value. */
function usableUrl(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    const u = url.trim();
    return u && u !== 'null' && u !== 'undefined' ? u : null;
}
