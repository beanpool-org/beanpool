/**
 * The address a listing's photo is served at: `/api/marketplace/posts/<id>/photos/<n>?v=<version>`, and where the node
 * keys that listing's photos, its key (`&k=`). An `<img>` cannot sign, so a photo that isn't everyone's goes only to a URL
 * carrying the key the node hands out with the listing (apps/server engine/photo-keys.ts). Which listings those are:
 * - every listing, on a node whose listings are its members' (a local community, 2026-09-28);
 * - every listing off the public board, on a node whose listings are a public read (the global node's visitors' view, or
 *   reads not enforced): a group's own listing, a listing for one person. Only a listing on the board keeps a plain URL.
 * Every listing-photo URL the node emits is made here, from the listing's audience as its row says now, so none goes
 * out without the key its listing needs.
 */

/** The key for one photo as it is now: its listing, its place in the listing and its version. */
export type PhotoKeyer = (postId: string, orderNum: number, version: number) => string;

/** Which listings' photo URLs carry the key: every listing's, or only those off the public board (onPublicBoard). */
export type PhotoKeyScope = 'every' | 'offBoard';

let photoKeyer: PhotoKeyer | null = null;
let keyScope: PhotoKeyScope = 'every';

/** Installs (or, with null, removes) the key the listing-photo URLs of `scope` carry. */
export function configurePhotoKeys(keyer: PhotoKeyer | null, scope: PhotoKeyScope = 'every'): void {
    photoKeyer = keyer;
    keyScope = scope;
}

/**
 * Whether a listing with this audience (`posts.audience_scope` as SQLite returns it) is on the public board: `public`,
 * or NULL (a row from before audiences), as getPosts reads it. Anything else is off it: `group`, `direct`, a value this
 * code doesn't know, and `undefined`, a read that never selected the column, so a caller that forgot it errs towards
 * the key (a keyed URL opens a board listing's photo too).
 */
export function onPublicBoard(audienceScope: string | null | undefined): boolean {
    return audienceScope === null || audienceScope === 'public';
}

/** Whether the photo URLs of a listing with this audience carry the key here (configurePhotoKeys). */
export function photoUrlKeyed(audienceScope: string | null | undefined): boolean {
    return photoKeyer !== null && (keyScope === 'every' || !onPublicBoard(audienceScope));
}

/** A photo's version, the `v` its URL carries: its row's `updated_at` in milliseconds, 0 when the row has none. */
export function photoVersionOf(updatedAt: string | null | undefined): number {
    return updatedAt ? new Date(updatedAt).getTime() : 0;
}

/**
 * The URL to emit for a listing's photo, from its `post_photos` row (post, order and `updated_at`) and its listing's
 * `audience_scope` as the posts row holds it now (onPublicBoard).
 */
export function postPhotoUrl(postId: string, orderNum: number, updatedAt: string | null | undefined, audienceScope: string | null | undefined): string {
    const version = photoVersionOf(updatedAt);
    const url = `/api/marketplace/posts/${postId}/photos/${orderNum}?v=${version}`;
    return photoKeyer && photoUrlKeyed(audienceScope) ? `${url}&k=${photoKeyer(postId, orderNum, version)}` : url;
}

/**
 * Whether a taken-off listing's photo (its row's `active` not 1) still goes to this reader, given the listing and its
 * author. The photo route answers anyone else 404 (apps/server routes/marketplace.ts), so a list that would hand such
 * a reader the URL hands out none: the apps show their no-photo state, not a load that fails. The server's rule is its
 * author, its moderators and anyone the listing's read by id still lets in (offListingPhotoShownTo); a caller with no
 * rule of its own gets the author's part of it (authorsOnly).
 */
export type OffListingPhotoShown = (postId: string, authorPubkey: string) => boolean;

/** The author's part of the photo route's rule for a taken-off listing: its author, and nobody else. */
export function authorsOnly(viewer: string): OffListingPhotoShown {
    return (_postId, authorPubkey) => authorPubkey === viewer;
}
