import React, { createContext, useContext } from 'react';
import { MEMBERS_PAGE_SIZE, POSTS_PAGE_SIZE } from './node-client';

/**
 * The node's members and posts come a page at a time (POST /api/local/admin/data/members and /data/posts, capacity fix
 * 3): the data holds the first page of each, and a screen that lists them says how many it shows and offers the next
 * page. App holds the pages and provides this; a screen renders <LoadMoreRow kind=… /> under its list.
 */
export type PagedKind = 'members' | 'posts';

export interface NodeDataPagesValue {
    members: { loaded: number; total: number | null; more: boolean };
    posts: { loaded: number; more: boolean };
    busy: Record<PagedKind, boolean>;
    error: Record<PagedKind, string | null>;
    loadMore: (kind: PagedKind) => void;
}

export const NodeDataPagesContext = createContext<NodeDataPagesValue | null>(null);

export function useNodeDataPages(): NodeDataPagesValue | null {
    return useContext(NodeDataPagesContext);
}

/**
 * What a list shows when the node holds more than its pages so far: "Showing 200 of 3,500 members", a Load more for the
 * next page, and what went wrong if it failed. Nothing once every one is shown.
 */
export function LoadMoreRow({ kind, searching = false }: { kind: PagedKind; searching?: boolean }) {
    const pages = useNodeDataPages();
    if (!pages) return null;
    const more = pages[kind].more;
    const error = pages.error[kind];
    if (!more && !error) return null;
    const busy = pages.busy[kind];
    const loaded = pages[kind].loaded.toLocaleString('en');
    const total = kind === 'members' ? pages.members.total : null;
    const shown = kind === 'members'
        ? (total !== null ? `Showing ${loaded} of ${total.toLocaleString('en')} members, oldest joined first.` : `Showing the first ${loaded} members.`)
        : `Showing the ${loaded} most recently changed posts.`;
    const size = kind === 'members' ? MEMBERS_PAGE_SIZE : POSTS_PAGE_SIZE;
    return (
        <div role="status" data-testid={`load-more-${kind}`} className="flex flex-wrap items-center gap-2 py-2 text-xs text-nature-400">
            <span className="min-w-0 break-words">
                {shown}
                {searching && more ? ` The search looks only at the ${kind} shown.` : ''}
            </span>
            {more && (
                <button
                    type="button"
                    onClick={() => pages.loadMore(kind)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white border border-nature-700 disabled:opacity-50"
                >
                    {busy ? 'Loading…' : `Load ${size} more`}
                </button>
            )}
            {error && <span className="text-bp-ink-terra break-words">Couldn't load more: {error}</span>}
        </div>
    );
}
