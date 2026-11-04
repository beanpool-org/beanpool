/**
 * The phone's Market grid as rows (DESIGN-market-grid-sizes-fable.md §2.5, slice PG2; Marty, 4 Nov 2026: one style box, the
 * grid's tiles one height per row, a poll a whole row). The grid's FlatList takes one item a row, not one a post: a row is two
 * tiles side by side, drawn in one `flexDirection: 'row'` so the pair shares one height, or a poll on its own at the list's
 * width (it is the poll card, which a half cell squeezed, as it did the event).
 *
 * The order is the posts' own, packed as the web's grid packs it (`grid-flow-row-dense`): a poll that comes while a tile waits
 * for its partner is drawn after that row, and the next tile fills the cell beside the waiting one, so no cell is left empty
 * but the last one. Nothing else moves, and no post is drawn twice or dropped.
 *
 * Pure: no React, no I/O.
 */

/** A post as the grid reads it: its id, and its type (a poll takes a row of its own). */
export interface GridPost {
    id: string | number;
    type?: string;
}

/**
 * One row of the grid. `isGridRow` marks it apart from a post (a poll post carries poll data of its own); `id` is its first
 * post's, so it is the FlatList's key.
 */
export type GridRow<T extends GridPost> =
    | { isGridRow: true; id: string; pair: T[] }
    | { isGridRow: true; id: string; poll: T };

export function gridRows<T extends GridPost>(posts: readonly T[]): GridRow<T>[] {
    const rows: GridRow<T>[] = [];
    let waiting: T | null = null;
    let held: T[] = [];
    const pollRows = () => {
        for (const poll of held) rows.push({ isGridRow: true, id: String(poll.id), poll });
        held = [];
    };
    for (const post of posts) {
        if (post.type === 'poll') {
            if (waiting) held.push(post);
            else rows.push({ isGridRow: true, id: String(post.id), poll: post });
            continue;
        }
        if (!waiting) {
            waiting = post;
            continue;
        }
        rows.push({ isGridRow: true, id: String(waiting.id), pair: [waiting, post] });
        waiting = null;
        pollRows();
    }
    if (waiting) rows.push({ isGridRow: true, id: String(waiting.id), pair: [waiting] });
    pollRows();
    return rows;
}
