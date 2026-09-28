/**
 * The address a listing's photo is served at: `/api/marketplace/posts/<id>/photos/<n>?v=<version>`, and on a node that
 * keys them, its key (`&k=`). A local community's listings are its members' (2026-09-28), and an `<img>` cannot sign,
 * so such a node serves a listing's photo only to a URL carrying the key it hands out with the listing (apps/server
 * engine/photo-keys.ts). Every listing-photo URL the node emits is made here, so none goes out without its key.
 */

/** The key for one photo as it is now: its listing, its place in the listing and its version. */
export type PhotoKeyer = (postId: string, orderNum: number, version: number) => string;

let photoKeyer: PhotoKeyer | null = null;

/** Installs (or, with null, removes) the key every emitted listing-photo URL carries. */
export function configurePhotoKeys(keyer: PhotoKeyer | null): void {
    photoKeyer = keyer;
}

/** A photo's version, the `v` its URL carries: its row's `updated_at` in milliseconds, 0 when the row has none. */
export function photoVersionOf(updatedAt: string | null | undefined): number {
    return updatedAt ? new Date(updatedAt).getTime() : 0;
}

/** The URL to emit for a listing's photo, from its `post_photos` row (post, order and `updated_at`). */
export function postPhotoUrl(postId: string, orderNum: number, updatedAt: string | null | undefined): string {
    const version = photoVersionOf(updatedAt);
    const url = `/api/marketplace/posts/${postId}/photos/${orderNum}?v=${version}`;
    return photoKeyer ? `${url}&k=${photoKeyer(postId, orderNum, version)}` : url;
}
