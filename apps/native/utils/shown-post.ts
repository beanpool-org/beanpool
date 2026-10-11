/**
 * What the listing page (app/post/[id].tsx) shows after a reload: the row the reload read, or, when it read none, the
 * listing already shown for this id. On a community that syncs by area the phone drops a far listing's row (the next
 * sync, a near push past its cap: utils/posts-nearby.ts) while its page is open; getPost then refetches it by id, and
 * that row replaces the shown one on the reload it rings. Swapping the page for a spinner in between lost its scroll and
 * its children's state (the review of #1778, finding 3). Never another listing's: the page open on a new id starts empty.
 */
export function shownPostAfterReload<T extends { id?: unknown }>(shown: T | null, read: T | null | undefined, id: string): T | null {
    if (read) return read;
    return shown && shown.id === id ? shown : null;
}
