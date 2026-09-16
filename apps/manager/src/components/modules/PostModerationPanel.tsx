import React, { useState, useMemo } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken, deleteNodePost } from '../../lib/node-client';

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
    [key: string]: unknown;
}

export interface PostModerationPanelProps {
    posts?: PostModerationItem[] | null;
    activeNode: NodeProfile;
    onRefresh: () => void;
    onDeletePost?: (postId: string) => Promise<void>;
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
}: PostModerationPanelProps) {
    const [searchTerm, setSearchTerm] = useState('');
    const [typeFilter, setTypeFilter] = useState<'all' | 'offer' | 'need'>('all');
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [deletingPost, setDeletingPost] = useState<PostModerationItem | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const [actionMessage, setActionMessage] = useState<{ text: string; isError: boolean } | null>(null);

    const safePosts = Array.isArray(posts) ? posts : [];

    const filteredPosts = useMemo(() => {
        return safePosts.filter((p) => {
            if (!p || typeof p !== 'object') return false;

            // Type filter
            if (typeFilter !== 'all') {
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
                    activeNode.adminPassword,
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
                        onClick={onRefresh}
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
                        onChange={(e) => setTypeFilter(e.target.value as any)}
                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-terra-500 min-h-[44px]"
                    >
                        <option value="all">All Types</option>
                        <option value="offer">Offers</option>
                        <option value="need">Needs</option>
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

            {/* Posts List */}
            <div
                id="admin-posts-list"
                className="space-y-3 max-h-[500px] overflow-y-auto divide-y divide-nature-800/60 pr-1"
            >
                {filteredPosts.length === 0 ? (
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
                        const isOffer = typeof post.type === 'string' && post.type.toLowerCase() === 'offer';
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
                                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                                                isOffer
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                                    : 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                                            }`}
                                        >
                                            {post.type || 'post'}
                                        </span>
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
                                    <div className="flex items-center gap-3 text-[11px] text-nature-400 font-mono">
                                        <span>By: {author}</span>
                                        {post.price !== undefined && <span>{post.price} 🫘</span>}
                                        {createdStr && <span>{createdStr}</span>}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                                    <button
                                        type="button"
                                        onClick={() => setDeletingPost(post)}
                                        aria-label={`Delete post ${post.title || post.id}`}
                                        className="min-h-[44px] px-3.5 py-1.5 rounded-xl bg-red-950/80 hover:bg-red-900 border border-red-800 text-red-200 text-xs font-bold transition-all flex items-center gap-1.5 active:scale-95"
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
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="delete-post-dialog-title"
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) setDeletingPost(null);
                    }}
                >
                    <div className="bg-nature-900 border border-red-800 rounded-2xl p-6 max-w-md w-full shadow-2xl space-y-4 font-sans text-white">
                        <div className="flex items-start justify-between gap-3 border-b border-nature-800 pb-3">
                            <h3 id="delete-post-dialog-title" className="text-base font-bold text-red-300 flex items-center gap-2 m-0">
                                <span>⚠️</span>
                                <span>Confirm Post Deletion</span>
                            </h3>
                            <button
                                type="button"
                                onClick={() => setDeletingPost(null)}
                                className="text-nature-400 hover:text-white p-1 text-sm min-h-[44px] min-w-[44px] flex items-center justify-center"
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
                                className="min-h-[44px] px-5 py-2 rounded-xl bg-red-700 hover:bg-red-600 text-xs font-bold text-white border border-red-500 shadow-md transition-all disabled:opacity-50 flex items-center gap-2"
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
                </div>
            )}
        </div>
    );
}
