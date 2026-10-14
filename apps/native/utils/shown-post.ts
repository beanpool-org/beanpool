/**
 * What the listing page (app/post/[id].tsx) shows after a reload: the row the reload read, or, when it read none, the
 * listing already shown for this id. On a community that syncs by area the phone drops a far listing's row (the next
 * sync, a near push past its cap: utils/posts-nearby.ts) while its page is open; getPost then refetches it by id, and
 * that row replaces the shown one on the reload it rings. Swapping the page for a spinner in between lost its scroll and
 * its children's state (the review of #1778, finding 3). Never another listing's: the page open on a new id starts empty.
 *
 * `goneOnNode`: the node answered the by-id read with no such listing (utils/db.ts `post_not_on_node`). With no row read
 * either, the shown listing goes, so the page's "Post not found" shows; before, it showed a listing the node had
 * deleted as active, indefinitely (the confirmation review of #1778, finding 1). A failed or offline read says nothing,
 * and the shown listing stays.
 */
export function shownPostAfterReload<T extends { id?: unknown }>(
    shown: T | null, read: T | null | undefined, id: string, goneOnNode = false,
): T | null {
    if (read) return read;
    if (goneOnNode) return null;
    return shown && shown.id === id ? shown : null;
}
