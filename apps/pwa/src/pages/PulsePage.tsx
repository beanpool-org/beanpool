/**
 * The Pulse — Local Community Activity Feed (Phase 3).
 *
 * Consumes Contract B:
 * - GET /api/pulse/feed (public read, cursor pagination, category filtering)
 * - POST /api/member/pulse/items/:id/mute (signed owner mutation)
 *
 * Rules:
 * - Facade cards, NOT embeds: taps open external post on platform.
 * - Prioritizes creator attribution: "my neighbour made this".
 * - Honest empty states for newly syndicated nodes.
 * - Responsive at 320dp and 1.3x font scale with pagination and filtering.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CATEGORIES, type ChannelCategory } from '@beanpool/core';
import {
    type PulseFeedItem,
    type MemberCreatorChannel,
    getPulseFeed,
    getMemberChannels,
    mutePulseItem,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { isOfficialSource } from '../lib/pulse';
import { PulseFeedCard } from '../components/PulseFeedCard';
import { PulseNudges } from '../components/PulseNudges';
import { ChannelsPage } from './ChannelsPage';
import { PulseIntakePage } from './PulseIntakePage';

interface Props {
    identity: BeanPoolIdentity | null;
    onOpenProfile: (pubkey: string) => void;
    onNavigate?: (tab: string, contextId?: string) => void;
}

export function PulsePage({ identity, onOpenProfile, onNavigate }: Props) {
    const [view, setView] = useState<'feed' | 'channels' | 'intake'>('feed');
    const [intakeParams, setIntakeParams] = useState<{ url?: string; channelId?: string }>({});

    // Feed state
    const [lane, setLane] = useState<'neighbours' | 'local'>('neighbours');
    const [items, setItems] = useState<PulseFeedItem[]>([]);
    const [selectedCategory, setSelectedCategory] = useState<ChannelCategory | 'all'>('all');
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Channels state for nudges
    const [memberChannels, setMemberChannels] = useState<MemberCreatorChannel[]>([]);

    const localItems = items.filter(isOfficialSource);
    const neighbourItems = items.filter(i => !isOfficialSource(i));
    const localLaneAvailable = localItems.length > 0;
    const activeLane = (lane === 'local' && localLaneAvailable) ? 'local' : 'neighbours';
    const visibleItems = activeLane === 'local' ? localItems : neighbourItems;

    const activeCategoryRef = useRef(selectedCategory);
    useEffect(() => {
        activeCategoryRef.current = selectedCategory;
    }, [selectedCategory]);

    const loadFeed = useCallback(async (isRefresh = false, category = selectedCategory) => {
        if (isRefresh) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }
        setError(null);

        try {
            const res = await getPulseFeed({
                category: category === 'all' ? undefined : category,
                limit: 20,
            });

            if (activeCategoryRef.current !== category) return;

            setItems(res.items || []);
            setNextCursor(res.nextCursor);
        } catch (e: any) {
            if (activeCategoryRef.current === category) {
                setError(e?.message || 'Could not load community feed.');
            }
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, [selectedCategory]);

    const loadChannels = useCallback(async () => {
        if (!identity) return;
        try {
            const res = await getMemberChannels();
            setMemberChannels(res.channels || []);
        } catch {}
    }, [identity]);

    useEffect(() => {
        if (view === 'feed') {
            void loadFeed(false, selectedCategory);
            void loadChannels();
        }
    }, [view, loadFeed, loadChannels, selectedCategory]);

    const handleRefresh = async () => {
        await loadFeed(true, selectedCategory);
        await loadChannels();
    };

    const handleLoadMore = async () => {
        if (loadingMore || !nextCursor || loading || refreshing) return;
        setLoadingMore(true);

        try {
            const res = await getPulseFeed({
                category: selectedCategory === 'all' ? undefined : selectedCategory,
                cursor: nextCursor,
                limit: 20,
            });

            if (activeCategoryRef.current !== selectedCategory) return;

            setItems(prev => {
                const existingIds = new Set(prev.map(i => i.id));
                const newItems = (res.items || []).filter(i => !existingIds.has(i.id));
                return [...prev, ...newItems];
            });
            setNextCursor(res.nextCursor);
        } catch (e: any) {
            console.warn('[PulsePage] Failed to load more items:', e);
        } finally {
            setLoadingMore(false);
        }
    };

    const handleSelectCategory = (cat: ChannelCategory | 'all') => {
        if (cat === selectedCategory) return;
        setSelectedCategory(cat);
    };

    const handleMute = async (itemId: string) => {
        if (!identity) return;
        const itemToMute = items.find(i => i.id === itemId);
        if (!itemToMute) return;

        // Optimistic removal from feed
        setItems(prev => prev.filter(i => i.id !== itemId));

        try {
            await mutePulseItem(itemId, true);
        } catch (e: any) {
            setItems(prev => {
                if (prev.some(i => i.id === itemId)) return prev;
                const updated = [...prev, itemToMute];
                updated.sort((a, b) => {
                    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
                    const db = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
                    return db - da;
                });
                return updated;
            });
            setError(e?.message || 'Could not hide that item.');
        }
    };

    const openIntakeWithParam = (param?: string) => {
        if (!param) {
            setIntakeParams({});
        } else if (param.startsWith('http://') || param.startsWith('https://')) {
            setIntakeParams({ url: param });
        } else {
            setIntakeParams({ channelId: param });
        }
        setView('intake');
    };

    // Sub-view renders
    if (view === 'channels') {
        return (
            <ChannelsPage
                identity={identity}
                onBack={() => setView('feed')}
                onViewFeed={() => setView('feed')}
                onSharePost={openIntakeWithParam}
            />
        );
    }

    if (view === 'intake') {
        return (
            <PulseIntakePage
                identity={identity}
                initialUrl={intakeParams.url}
                initialChannelId={intakeParams.channelId}
                onBack={() => setView('feed')}
                onManageChannels={() => setView('channels')}
                onSuccess={() => {
                    setView('feed');
                    void loadFeed(true, selectedCategory);
                }}
            />
        );
    }

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6 pb-24 min-h-full">
            {/* Header: Title, subtitle, + Channels button */}
            <div className="mb-4">
                <div className="flex items-center justify-between gap-3 mb-1">
                    <h1 className="text-xl sm:text-2xl font-black text-nature-950 dark:text-white m-0 tracking-tight">
                        The Pulse
                    </h1>
                    <button
                        type="button"
                        onClick={() => setView('channels')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-white dark:bg-nature-800 border border-nature-200 dark:border-nature-700 text-nature-800 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700/80 cursor-pointer shadow-sm transition-colors"
                        aria-label="Manage your channels"
                    >
                        <span>+ Channels</span>
                    </button>
                </div>
                <p className="text-xs sm:text-sm text-nature-500 dark:text-nature-400 m-0">
                    {activeLane === 'local'
                        ? 'News and notices from around the shire'
                        : 'What your neighbours are creating and sharing'}
                </p>
            </div>

            {/* Lane switch (Neighbours vs Local) — only visible if official sources exist */}
            {localLaneAvailable && (
                <div className="flex items-center p-1 bg-nature-100 dark:bg-nature-950 rounded-2xl mb-4 gap-1 border border-nature-200/60 dark:border-nature-800/60">
                    <button
                        type="button"
                        onClick={() => setLane('neighbours')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border-none ${
                            activeLane === 'neighbours'
                                ? 'bg-white dark:bg-nature-800 text-nature-950 dark:text-white shadow-sm'
                                : 'bg-transparent text-nature-500 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white'
                        }`}
                        aria-pressed={activeLane === 'neighbours'}
                    >
                        <span>👥 Neighbours</span>
                        {neighbourItems.length > 0 && (
                            <span className="text-[10px] font-extrabold px-1.5 py-0.2 rounded-full bg-nature-200 dark:bg-nature-700 text-nature-700 dark:text-nature-300">
                                {neighbourItems.length}
                            </span>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setLane('local')}
                        className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border-none ${
                            activeLane === 'local'
                                ? 'bg-white dark:bg-nature-800 text-nature-950 dark:text-white shadow-sm'
                                : 'bg-transparent text-nature-500 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white'
                        }`}
                        aria-pressed={activeLane === 'local'}
                    >
                        <span>📰 Local</span>
                        {localItems.length > 0 && (
                            <span className="text-[10px] font-extrabold px-1.5 py-0.2 rounded-full bg-nature-200 dark:bg-nature-700 text-nature-700 dark:text-nature-300">
                                {localItems.length}
                            </span>
                        )}
                    </button>
                </div>
            )}

            {/* Category Filter Bar */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 mb-4 scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
                <button
                    type="button"
                    onClick={() => handleSelectCategory('all')}
                    className={`shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                        selectedCategory === 'all'
                            ? 'bg-terra-500 border-terra-500 text-white shadow-sm'
                            : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-800'
                    }`}
                    aria-pressed={selectedCategory === 'all'}
                >
                    <span>🌐</span>
                    <span>All</span>
                </button>

                {CATEGORIES.map(c => {
                    const active = selectedCategory === c.id;
                    return (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => handleSelectCategory(c.id)}
                            className={`shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                                active
                                    ? 'bg-terra-500 border-terra-500 text-white shadow-sm'
                                    : 'bg-white dark:bg-nature-900 border-nature-200 dark:border-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-800'
                            }`}
                            aria-pressed={active}
                        >
                            <span>{c.icon}</span>
                            <span>{c.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* Embedded Pulse Nudges */}
            <PulseNudges
                channels={memberChannels}
                onNudgeDismissed={loadChannels}
                onAddFromClipboard={openIntakeWithParam}
                onShareChannel={openIntakeWithParam}
            />

            {/* Error Message Box */}
            {error && (
                <div className="flex items-center justify-between gap-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 p-3.5 rounded-2xl mb-4" role="alert">
                    <span className="text-xs sm:text-sm text-red-700 dark:text-red-300 flex-1">
                        {error}
                    </span>
                    <button
                        type="button"
                        onClick={() => void loadFeed(false, selectedCategory)}
                        className="px-3 py-1 rounded-xl text-xs font-bold bg-white dark:bg-nature-800 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-50 cursor-pointer shrink-0"
                    >
                        Retry
                    </button>
                </div>
            )}

            {/* Feed List or Empty State */}
            {loading && !refreshing ? (
                <div className="flex flex-col items-center justify-center p-12 text-nature-500 dark:text-nature-400">
                    <div className="w-8 h-8 rounded-full border-4 border-nature-200 dark:border-nature-800 border-t-terra-500 animate-spin mb-3"></div>
                    <span className="text-xs sm:text-sm">Loading community feed…</span>
                </div>
            ) : visibleItems.length === 0 ? (
                selectedCategory !== 'all' ? (
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-3xl p-8 text-center my-4 shadow-sm">
                        <div className="text-4xl mb-3 select-none">🔍</div>
                        <h3 className="text-base sm:text-lg font-bold text-nature-900 dark:text-white mb-2">
                            No posts in this category yet
                        </h3>
                        <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 max-w-sm mx-auto mb-5 leading-relaxed">
                            Try selecting "All" or check another category to see what neighbours have posted.
                        </p>
                        <button
                            type="button"
                            onClick={() => setSelectedCategory('all')}
                            className="px-4 py-2 rounded-xl text-xs sm:text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700 cursor-pointer shadow-sm"
                        >
                            Show all categories
                        </button>
                    </div>
                ) : (
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-3xl p-8 text-center my-4 shadow-sm">
                        <div className="text-4xl mb-3 select-none">🗞️</div>
                        <h3 className="text-base sm:text-lg font-bold text-nature-900 dark:text-white mb-2">
                            The Pulse is quiet right now
                        </h3>
                        <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 max-w-sm mx-auto mb-5 leading-relaxed">
                            Items from neighbours' YouTube channels and blogs appear here automatically once syndicated. As more members connect their channels, this feed will fill up.
                        </p>
                        <button
                            type="button"
                            onClick={() => setView('channels')}
                            className="px-5 py-2.5 rounded-xl font-bold text-sm bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm transition-transform active:scale-95"
                        >
                            + Connect your channels
                        </button>
                    </div>
                )
            ) : (
                <div className="space-y-4">
                    {visibleItems.map(item => (
                        <PulseFeedCard
                            key={item.id}
                            item={item}
                            currentPubkey={identity?.publicKey}
                            onMute={handleMute}
                            onOpenProfile={onOpenProfile}
                        />
                    ))}

                    {/* Pagination / Load more */}
                    {nextCursor && (
                        <div className="pt-2 text-center">
                            <button
                                type="button"
                                onClick={handleLoadMore}
                                disabled={loadingMore}
                                className="px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700 cursor-pointer shadow-sm disabled:opacity-50"
                            >
                                {loadingMore ? 'Loading more posts…' : 'Load more posts'}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
