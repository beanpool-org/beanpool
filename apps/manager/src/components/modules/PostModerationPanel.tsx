import React, { useState, useMemo, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { getTfaSessionToken, deleteNodePost, resolveNodeApiUrl, buildAdminHeaders } from '../../lib/node-client';
import { ModalBackdrop } from '../common/ModalBackdrop';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * The posts screen in Settings → Moderation (scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.13, slice S4).
 *
 * - Type Filter: Offers, Needs, Events, Polls, and "Shown from another community" (a copy on a global community: its row is
 *   `shownCopy: true`, whatever it is a copy of). The server's list is every type, so events, polls and copies were always here.
 * - Each row's chip is coloured from the central brand colours (brand-colours.ts, `bg-bp-…`), one per type; before, anything that
 *   was not an Offer was drawn in the Need colour.
 * - "Taken down by <assistant>": a post an owner's assistant took down is hidden at once and removed for good after 7 days. The
 *   row says so, with the day, and an owner or admin can Put it back there (the route "Taken down by assistants" uses, one post).
 *   The record is read from that route (agent/takedowns-route.ts), which only an owner's or an admin's session may read: with no
 *   `viewer`, or a moderator's, nothing is asked and no line is drawn. A post's own row says nothing of who hid it.
 */

export interface PostModerationItem {
    id: string;
    title?: string;
    description?: string;
    type?: 'offer' | 'need' | string;
    category?: string;
    authorCallsign?: string;
    authorPublicKey?: string;
    author_callsign?: string;
    author_pubkey?: string;
    price?: number;
    credits?: number;
    createdAt?: string | number;
    created_at?: string | number;
    status?: string;
    /** A copy of a post from another community, shown on this one (global): the server marks it, whatever it copies. */
    shownCopy?: boolean;
    shownFrom?: { name?: string } | null;
    /** Hidden by reports, or by an assistant's takedown: only an owner's and an admin's list carries it. */
    hiddenByReportsAt?: string | null;
    [key: string]: unknown;
}

export interface PostModerationPanelProps {
    posts?: PostModerationItem[] | null;
    activeNode: NodeProfile;
    onRefresh: () => void;
    onDeletePost?: (postId: string) => Promise<void>;
    /** Who is looking. Without it the screen asks nothing of the takedown record and draws no "taken down" line. */
    viewer?: RolesViewer;
}

export type PostTypeFilter = 'all' | 'offer' | 'need' | 'event' | 'poll' | 'copy';

const TYPE_FILTERS: Array<{ value: PostTypeFilter; label: string }> = [
    { value: 'all', label: 'All Types' },
    { value: 'offer', label: 'Offers' },
    { value: 'need', label: 'Needs' },
    { value: 'event', label: 'Events' },
    { value: 'poll', label: 'Polls' },
    { value: 'copy', label: 'Shown from another community' },
];

/** A copy, whatever it is a copy of: the server's own marker, never a guess from the words. */
export const isCopy = (p: PostModerationItem) => p.shownCopy === true || (typeof p.shownFrom === 'object' && p.shownFrom !== null);

/**
 * One chip per type, from the central brand colours (docs/brand-colours.md): Offer and Need are the chips every app draws,
 * an event takes the event tile's violet, a poll the sage accent, a copy the amber chip. An unknown type reads as the sage chip.
 */
const CHIP_FRAME = 'border border-bp-chip-accent-border';
const SAGE_CHIP = `bg-bp-chip-accent-tint text-bp-chip-accent-ink ${CHIP_FRAME}`;
const TYPE_CHIPS: Record<string, string> = {
    offer: `bg-bp-chip-ok-tint text-bp-chip-ok-ink ${CHIP_FRAME}`,
    need: `bg-bp-chip-need-tint text-bp-chip-need-ink ${CHIP_FRAME}`,
    event: `bg-bp-tile-event-tint text-bp-tile-event-ink ${CHIP_FRAME}`,
    poll: SAGE_CHIP,
};
const COPY_CHIP = `bg-bp-chip-warn-tint text-bp-chip-warn-ink ${CHIP_FRAME}`;
export const chipClassFor = (type: unknown) => TYPE_CHIPS[typeof type === 'string' ? type.toLowerCase() : ''] ?? SAGE_CHIP;

const TAKEDOWNS = '/api/local/admin/agent/takedowns';

/** What the posts screen needs of a takedown: the assistant, when it goes for good, and whether it was left hidden and why. */
export interface HeldTakedown {
    grantName: string;
    finalAfter: string;
    state: 'hidden' | 'left_hidden';
    leftFor: 'deal' | 'child_safety' | null;
}

/**
 * Each post still held (hidden, or left hidden), by the newest call that holds it. `takedowns` is the route's own list, newest
 * first; anything not in its shape is left out, so an older or odd answer draws no line rather than a wrong one.
 */
export function heldTakedowns(takedowns: unknown): Map<string, HeldTakedown> {
    const held = new Map<string, HeldTakedown>();
    if (!Array.isArray(takedowns)) return held;
    for (const call of takedowns) {
        if (!call || typeof call !== 'object') continue;
        const { grantName, finalAfter, posts } = call as { grantName?: unknown; finalAfter?: unknown; posts?: unknown };
        if (!Array.isArray(posts)) continue;
        for (const p of posts) {
            const post = p as { id?: unknown; state?: unknown; leftFor?: unknown } | null;
            if (!post || typeof post.id !== 'string' || (post.state !== 'hidden' && post.state !== 'left_hidden') || held.has(post.id)) continue;
            held.set(post.id, {
                grantName: typeof grantName === 'string' && grantName ? grantName : 'an assistant',
                finalAfter: typeof finalAfter === 'string' ? finalAfter : '',
                state: post.state,
                leftFor: post.leftFor === 'deal' || post.leftFor === 'child_safety' ? post.leftFor : null,
            });
        }
    }
    return held;
}

const day = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '';
};

/** The line on a taken-down post's row: who, that it is hidden now, and when it goes for good unless put back. */
export function takenDownWords(h: HeldTakedown, now: number = Date.now()): string {
    if (h.state === 'left_hidden') {
        const why = h.leftFor === 'deal' ? ', because a deal is in escrow' : h.leftFor === 'child_safety' ? ', because a Child safety report is open' : '';
        return `Taken down by ${h.grantName}: left hidden${why}. It is not removed for good until a person decides.`;
    }
    const final = Date.parse(h.finalAfter);
    if (!Number.isFinite(final)) return `Taken down by ${h.grantName}: hidden now, and removed for good after 7 days unless put back.`;
    return final <= now
        ? `Taken down by ${h.grantName}: hidden now, and due to be removed for good.`
        : `Taken down by ${h.grantName}: hidden now, and removed for good on ${day(h.finalAfter)} unless put back.`;
}

/** What Put back did, in words, from the route's answer (the same lines "Taken down by assistants" says). */
export function putBackWords(json: { back?: unknown; stillHidden?: unknown; gone?: unknown }): string {
    const back = Array.isArray(json.back) ? json.back.length : 0;
    const stillHidden = Array.isArray(json.stillHidden) ? json.stillHidden.length : 0;
    if (back === 0) return 'That post had gone already: it was removed for good, so there is nothing to put back.';
    const closed = ' Any reports the takedown closed are open again.';
    return stillHidden > 0
        ? `Put back, but it stays hidden for the moderators: a hide from before the assistant took it down, or its reports, still hold it.${closed}`
        : `Put back: its author is told, and everyone sees it again.${closed}`;
}

const CATEGORIES = [
    { value: 'all', label: 'All Categories' },
    { value: 'food', label: '🥕 Food' },
    { value: 'services', label: '🤝 Services' },
    { value: 'labour', label: '👷 Labour' },
    { value: 'tools', label: '🛠️ Tools' },
    { value: 'goods', label: '📦 Goods' },
    { value: 'garden', label: '🌻 Garden' },
    { value: 'housing', label: '🏠 Housing' },
    { value: 'transport', label: '🚗 Transport' },
    { value: 'education', label: '📚 Education' },
    { value: 'arts', label: '🎨 Arts' },
    { value: 'health', label: '🌿 Health' },
    { value: 'care', label: '❤️ Care' },
    { value: 'animals', label: '🐾 Animals' },
    { value: 'tech', label: '💻 Tech' },
    { value: 'energy', label: '☀️ Energy' },
    { value: 'general', label: '🌱 General' },
];

export function PostModerationPanel({
    posts,
    activeNode,
    onRefresh,
    onDeletePost,
    viewer,
}: PostModerationPanelProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [typeFilter, setTypeFilter] = useState<PostTypeFilter>('all');
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [deletingPost, setDeletingPost] = useState<PostModerationItem | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [actionMessage, setActionMessage] = useState<{ text: string; isError: boolean } | null>(null);

    const safePosts = Array.isArray(posts) ? posts : [];

    // Only an owner's or an admin's session may read the takedown record (the route says so as well): no one else is asked.
    const mayReadTakedowns = viewer !== undefined && (viewer.kind === 'password' || viewer.role === 'owner' || viewer.role === 'admin');
    const [held, setHeld] = useState<Map<string, HeldTakedown>>(() => new Map());
    const [takedownNote, setTakedownNote] = useState('');
    const [puttingBack, setPuttingBack] = useState<string | null>(null);
    const credential = nodeCredential(activeNode);

    const loadTakedowns = useCallback(async () => {
        if (!mayReadTakedowns) return;
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, TAKEDOWNS), {
                headers: buildAdminHeaders(credential, getTfaSessionToken(activeNode.id)), credentials: 'same-origin',
            });
            const json = await res.json().catch(() => ({}));
            if (res.ok) {
                setHeld(heldTakedowns(json.takedowns));
                setTakedownNote('');
            } else if (res.status !== 404 && res.status !== 403) {
                // A node older than this has no such route (404), and a moderator may not read it (403): nothing to say. Anything else is.
                setTakedownNote(`Which posts an assistant took down could not be listed: ${json.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setTakedownNote(`Which posts an assistant took down could not be listed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }, [mayReadTakedowns, activeNode.url, activeNode.id, credential]);

    // Again whenever the set of hidden posts changes (an assistant took one down, or one was put back), not on every refresh of the list.
    const hiddenKey = safePosts.filter((p) => p && typeof p === 'object' && p.hiddenByReportsAt).map((p) => p.id).sort().join(',');
    useEffect(() => { void loadTakedowns(); }, [loadTakedowns, hiddenKey]);

    const handlePutBack = async (post: PostModerationItem) => {
        if (puttingBack) return;
        setPuttingBack(post.id);
        setActionMessage(null);
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, `${TAKEDOWNS}/put-back`), {
                method: 'POST', credentials: 'same-origin', body: JSON.stringify({ postId: post.id }),
                headers: buildAdminHeaders(credential, getTfaSessionToken(activeNode.id)),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
            setActionMessage({ text: putBackWords(json), isError: false });
            onRefresh();
        } catch (err: unknown) {
            setActionMessage({ text: `Failed to put the post back: ${err instanceof Error ? err.message : String(err)}`, isError: true });
        } finally {
            setPuttingBack(null);
            void loadTakedowns();
        }
    };

    const filteredPosts = useMemo(() => {
        return safePosts.filter((p) => {
            if (!p || typeof p !== 'object') return false;

            // Type filter
            if (typeFilter === 'copy') {
                if (!isCopy(p)) return false;
            } else if (typeFilter !== 'all') {
                const pType = typeof p.type === 'string' ? p.type.toLowerCase() : '';
                if (pType !== typeFilter) return false;
            }

            // Category filter
            if (categoryFilter !== 'all') {
                const pCat = typeof p.category === 'string' ? p.category.toLowerCase() : '';
                if (pCat !== categoryFilter) return false;
            }

            // Search term filter
            if (searchTerm.trim()) {
                const q = searchTerm.trim().toLowerCase();
                const title = typeof p.title === 'string' ? p.title.toLowerCase() : '';
                const desc = typeof p.description === 'string' ? p.description.toLowerCase() : '';
                const author = typeof p.authorCallsign === 'string'
                    ? p.authorCallsign.toLowerCase()
                    : (typeof p.author_callsign === 'string' ? p.author_callsign.toLowerCase() : '');
                const authorPk = typeof p.authorPublicKey === 'string'
                    ? p.authorPublicKey.toLowerCase()
                    : (typeof p.author_pubkey === 'string' ? p.author_pubkey.toLowerCase() : '');

                if (!title.includes(q) && !desc.includes(q) && !author.includes(q) && !authorPk.includes(q)) {
                    return false;
                }
            }

            return true;
        });
    }, [safePosts, typeFilter, categoryFilter, searchTerm]);

    const handleConfirmDelete = async () => {
        if (!deletingPost || !deletingPost.id || isDeleting) return;
        setIsDeleting(true);
        setActionMessage(null);
        try {
            if (onDeletePost) {
                await onDeletePost(deletingPost.id);
            } else {
                await deleteNodePost(
                    activeNode.url,
                    deletingPost.id,
                    nodeCredential(activeNode),
                    getTfaSessionToken(activeNode.id)
                );
            }
            setActionMessage({ text: `Post "${deletingPost.title || deletingPost.id}" deleted successfully.`, isError: false });
            setDeletingPost(null);
            onRefresh();
        } catch (err: unknown) {
            setActionMessage({
                text: `Failed to delete post: ${err instanceof Error ? err.message : String(err)}`,
                isError: true,
            });
        } finally {
            setIsDeleting(false);
        }
    };

    useEffect(() => {
        if (!deletingPost) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !isDeleting) {
                e.preventDefault();
                setDeletingPost(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [deletingPost, isDeleting]);

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-5 font-sans">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-nature-800 pb-4">
                <div>
                    <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                        <span>📦</span>
                        <span>Marketplace Post Search &amp; Moderation</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-0.5">
                        Filter, inspect, and remove individual abusive or prohibited listings
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <span id="post-count-label" className="text-xs font-mono text-nature-400">
                        {filteredPosts.length} of {safePosts.length} posts
                    </span>
                    <button
                        type="button"
                        onClick={() => { onRefresh(); void loadTakedowns(); }}
                        className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white font-bold transition-all min-h-[36px]"
                    >
                        🔄 Refresh
                    </button>
                </div>
            </div>

            {/* Status notification */}
            {actionMessage && (
                <div
                    role={actionMessage.isError ? 'alert' : 'status'}
                    className={`p-3 rounded-xl border text-xs font-semibold ${
                        actionMessage.isError
                            ? 'bg-red-950 border-red-800 text-red-200'
                            : 'bg-emerald-950 border-emerald-800 text-emerald-300'
                    }`}
                >
                    {actionMessage.isError ? '❌ ' : '✓ '}
                    {actionMessage.text}
                </div>
            )}

            {/* Search and Filters Bar */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                    <label htmlFor="admin-post-search" className="block text-[11px] font-bold text-nature-300 mb-1">
                        Search Posts
                    </label>
                    <input
                        id="admin-post-search"
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        placeholder="Search title, description, author..."
                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-terra-500 min-h-[44px]"
                    />
                </div>

                <div>
                    <label htmlFor="admin-post-type-filter" className="block text-[11px] font-bold text-nature-300 mb-1">
                        Type Filter
                    </label>
                    <select
                        id="admin-post-type-filter"
                        value={typeFilter}
                        onChange={(e) => setTypeFilter(e.target.value as PostTypeFilter)}
                        className="w-full min-w-0 overflow-hidden text-ellipsis bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                    >
                        {TYPE_FILTERS.map((f) => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label htmlFor="admin-post-category-filter" className="block text-[11px] font-bold text-nature-300 mb-1">
                        Category Filter
                    </label>
                    <select
                        id="admin-post-category-filter"
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                    >
                        {CATEGORIES.map((cat) => (
                            <option key={cat.value} value={cat.value}>
                                {cat.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {takedownNote && (
                <p role="status" data-testid="post-takedown-note" className="text-xs text-nature-300 m-0 break-words">{takedownNote}</p>
            )}

            {/* Posts List */}
            <div
                id="admin-posts-list"
                className="space-y-3 max-h-[500px] overflow-y-auto divide-y divide-nature-800/60 pr-1"
            >
                {posts == null ? (
                    <div className="py-8 text-center text-xs text-nature-400 font-mono bg-nature-950/50 rounded-xl border border-nature-800 flex items-center justify-center gap-2">
                        <span className="animate-spin text-sm">🔄</span>
                        <span>Loading marketplace posts...</span>
                    </div>
                ) : filteredPosts.length === 0 ? (
                    <div className="py-8 text-center text-xs text-nature-400 italic bg-nature-950/50 rounded-xl border border-nature-800">
                        No marketplace posts match your search and filter criteria.
                    </div>
                ) : (
                    filteredPosts.map((post) => {
                        const author = typeof post.authorCallsign === 'string'
                            ? post.authorCallsign
                            : (typeof post.author_callsign === 'string'
                                ? post.author_callsign
                                : (typeof post.authorPublicKey === 'string'
                                    ? `${post.authorPublicKey.slice(0, 10)}...`
                                    : 'Unknown Author'));
                        const takenDown = held.get(post.id);
                        const createdStr = post.createdAt || post.created_at
                            ? new Date(post.createdAt || post.created_at || '').toLocaleDateString()
                            : '';
                        const categoryStr = typeof post.category === 'string' ? post.category : '';

                        return (
                            <div
                                key={post.id}
                                className="pt-3 first:pt-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                            >
                                <div className="space-y-1 min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span
                                            data-testid="post-type-chip"
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${chipClassFor(post.type)}`}
                                        >
                                            {post.type || 'post'}
                                        </span>
                                        {isCopy(post) && (
                                            <span
                                                data-testid="post-copy-chip"
                                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${COPY_CHIP}`}
                                            >
                                                Shown from another community
                                            </span>
                                        )}
                                        {categoryStr && (
                                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-nature-800 text-nature-300 border border-nature-700 capitalize">
                                                {categoryStr}
                                            </span>
                                        )}
                                        <h4 className="text-xs sm:text-sm font-bold text-white m-0 truncate">
                                            {post.title || 'Untitled Listing'}
                                        </h4>
                                    </div>
                                    <p className="text-xs text-nature-300 line-clamp-1 m-0">
                                        {post.description || 'No description'}
                                    </p>
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-nature-400 font-mono">
                                        <span>By: {author}</span>
                                        {post.price !== undefined && <span>{post.price} 🫘</span>}
                                        {createdStr && <span>{createdStr}</span>}
                                    </div>
                                    {takenDown && (
                                        <p
                                            data-testid="post-taken-down"
                                            className="m-0 mt-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold leading-snug break-words bg-bp-chip-danger-tint text-bp-chip-danger-ink border border-bp-chip-accent-border"
                                        >
                                            {takenDownWords(takenDown)}
                                        </p>
                                    )}
                                </div>

                                <div className="flex flex-wrap items-center justify-end gap-2 shrink-0 self-end sm:self-center">
                                    {takenDown && (
                                        <button
                                            type="button"
                                            onClick={() => void handlePutBack(post)}
                                            disabled={puttingBack !== null}
                                            data-testid="post-put-back"
                                            aria-label={`Put back post ${post.title || post.id}`}
                                            className="min-h-[44px] px-3.5 py-1.5 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-xs font-bold transition-all active:scale-95 disabled:opacity-50"
                                        >
                                            {puttingBack === post.id ? 'Putting back…' : 'Put back'}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => setDeletingPost(post)}
                                        aria-label={`Delete post ${post.title || post.id}`}
                                        className="min-h-[44px] px-3.5 py-1.5 rounded-xl bg-bp-chip-danger-tint hover:opacity-90 border border-red-800 text-bp-chip-danger-ink text-xs font-bold transition-all flex items-center gap-1.5 active:scale-95"
                                    >
                                        <span>🗑️</span>
                                        <span>Delete</span>
                                    </button>
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {/* Single Post Deletion Confirmation Modal */}
            {deletingPost && (
                <ModalBackdrop
                    onClose={() => setDeletingPost(null)}
                    dismissable={!isDeleting}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="delete-post-dialog-title"
                    className="fixed inset-0 overflow-y-auto z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                >
                    <div className="m-auto bg-nature-900 border border-red-800 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="delete-post-dialog-title" className="text-base font-bold text-red-300 flex items-center gap-2 m-0 min-w-0 flex-1">
                                <span>⚠️</span>
                                <span>Confirm Post Deletion</span>
                            </h3>
                            <button
                                type="button"
                                onClick={() => {
                                    if (!isDeleting) setDeletingPost(null);
                                }}
                                disabled={isDeleting}
                                className="shrink-0 text-nature-400 hover:text-white p-1 text-sm min-h-[44px] min-w-[44px] flex items-center justify-center disabled:opacity-50"
                                aria-label="Close delete confirmation"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-3 bg-red-950/60 border border-red-900/60 rounded-xl space-y-1 text-xs text-red-200">
                            <p className="font-bold text-red-300 m-0">
                                Permanently delete this listing?
                            </p>
                            <p className="m-0 text-[11px] text-nature-300">
                                Title: <strong className="text-white">{deletingPost.title || deletingPost.id}</strong>
                            </p>
                            <p className="m-0 text-[11px] text-nature-300">
                                Author: <span className="font-mono">{deletingPost.authorCallsign || deletingPost.authorPublicKey || 'Unknown'}</span>
                            </p>
                        </div>

                        <p className="text-xs text-nature-400 m-0">
                            This administrative action removes the post immediately from the community node. This cannot be undone.
                        </p>

                        <div className="flex items-center justify-end gap-3 pt-2">
                            <button
                                type="button"
                                onClick={() => setDeletingPost(null)}
                                disabled={isDeleting}
                                className="min-h-[44px] px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={handleConfirmDelete}
                                disabled={isDeleting}
                                className="min-h-[44px] px-5 py-2 rounded-xl bg-bp-danger-fill hover:bg-bp-danger-hover text-xs font-bold text-bp-danger-on border border-bp-danger-fill shadow-md transition-all disabled:opacity-50 flex items-center gap-2"
                            >
                                {isDeleting ? (
                                    <>
                                        <span className="animate-spin text-sm">🔄</span>
                                        <span>Deleting...</span>
                                    </>
                                ) : (
                                    <span>🗑️ Confirm Delete</span>
                                )}
                            </button>
                        </div>
                    </div>
                </ModalBackdrop>
            )}
        </div>
    );
}
