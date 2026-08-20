/**
 * ActivityWaterfall — Living Community Activity Pulse (#208).
 *
 * Provides a real-time, ambient activity stream of recent joins, trades, ratings,
 * and posts to ensure communities feel alive and welcoming during cold-start or quiet periods.
 */

import React, { useState, useEffect } from 'react';
import { getActivityFeedApi, type ActivityFeedItem } from '../lib/api';

interface Props {
    isFullView?: boolean;
}

const EVENT_EMOJIS: Record<ActivityFeedItem['eventType'], string> = {
    member_joined: '🎉',
    trade_completed: '✅',
    rating_given: '⭐️',
    post_created: '📍',
};

function formatRelativeTime(isoDate: string): string {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}

function getCompactLabel(item: ActivityFeedItem): string {
    const actor = item.actorCallsign || 'Someone';
    switch (item.eventType) {
        case 'trade_completed':
            return `${actor} traded`;
        case 'rating_given':
            return `${actor} rated ★`;
        case 'post_created':
            return `${actor} posted`;
        case 'member_joined':
        default:
            return `${actor} joined`;
    }
}

export function ActivityWaterfall({ isFullView = false }: Props) {
    const [feed, setFeed] = useState<ActivityFeedItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;

        async function fetchFeed() {
            try {
                const res = await getActivityFeedApi(30, 0);
                if (isMounted && res?.feed) {
                    setFeed(res.feed);
                }
            } catch (e) {
                console.warn('[ActivityWaterfall] Could not fetch activity feed:', e);
            } finally {
                if (isMounted) setLoading(false);
            }
        }

        fetchFeed();
        const timer = setInterval(fetchFeed, 30_000); // 30s live pulse refresh

        return () => {
            isMounted = false;
            clearInterval(timer);
        };
    }, []);

    if (loading && feed.length === 0) {
        return isFullView ? (
            <div className="py-12 flex flex-col items-center justify-center text-zinc-400">
                <div className="animate-spin text-2xl mb-2" aria-hidden="true">⏳</div>
                <p className="text-xs font-semibold">Tuning into community pulse...</p>
            </div>
        ) : null;
    }

    if (feed.length === 0) {
        return isFullView ? (
            <div className="py-12 flex flex-col items-center justify-center text-center p-6 bg-zinc-50 dark:bg-zinc-900/40 rounded-2xl border border-zinc-200/80 dark:border-zinc-800">
                <div className="text-4xl mb-3" aria-hidden="true">🌱</div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">Welcome to the Community</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mt-1">
                    You're among the first here! Create an offer or need above to start local circulation.
                </p>
            </div>
        ) : null;
    }

    // FULL VIEW MODE: Rich card stream for cold-start / empty marketplace state
    if (isFullView) {
        return (
            <div className="w-full max-w-lg mx-auto space-y-3 py-2 animate-in fade-in duration-300">
                <div className="text-center pb-2">
                    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-xs font-extrabold mb-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
                        Community Pulse
                    </div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">Recent Community Life</h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        Live activity across members and trades
                    </p>
                </div>

                <div className="space-y-2.5">
                    {feed.map((item) => {
                        const actorName = item.actorCallsign || 'Member';
                        const targetName = item.targetCallsign || 'Member';
                        const timeStr = formatRelativeTime(item.createdAt);

                        let emoji = '✨';
                        let badgeBg = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300';
                        let content = null;

                        switch (item.eventType) {
                            case 'member_joined':
                                emoji = '🎉';
                                badgeBg = 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800';
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{actorName}</span> joined the community
                                    </p>
                                );
                                break;
                            case 'trade_completed':
                                emoji = '✅';
                                badgeBg = 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{actorName}</span> completed a trade with{' '}
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{targetName}</span>
                                        {item.metadata?.credits && (
                                            <span className="ml-1 font-bold text-emerald-600 dark:text-emerald-400">
                                                (🫘 {item.metadata.credits})
                                            </span>
                                        )}
                                    </p>
                                );
                                break;
                            case 'rating_given': {
                                const starCount = Math.max(1, Math.min(5, Math.round(Number(item.metadata?.stars) || 5)));
                                emoji = '⭐️';
                                badgeBg = 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800';
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{actorName}</span> rated{' '}
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{targetName}</span>{' '}
                                        <span
                                            className="font-bold text-amber-500"
                                            role="img"
                                            aria-label={`${starCount} out of 5 stars`}
                                        >
                                            {'★'.repeat(starCount)}
                                        </span>
                                        {item.metadata?.comment && (
                                            <span className="italic text-zinc-500 dark:text-zinc-400 block text-[11px] mt-0.5">
                                                "{item.metadata.comment}"
                                            </span>
                                        )}
                                    </p>
                                );
                                break;
                            }
                            case 'post_created':
                                emoji = '📍';
                                badgeBg = 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800';
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">{actorName}</span> posted{' '}
                                        <span className="font-bold text-zinc-900 dark:text-zinc-100">
                                            "{item.metadata?.title || 'Listing'}"
                                        </span>
                                        {item.metadata?.credits ? ` for 🫘 ${item.metadata.credits}` : ''}
                                    </p>
                                );
                                break;
                        }

                        return (
                            <div
                                key={item.id}
                                className="flex items-center gap-3 p-3 rounded-2xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 shadow-sm hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
                            >
                                <div
                                    className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0 border ${badgeBg}`}
                                    aria-hidden="true"
                                >
                                    {emoji}
                                </div>
                                <div className="flex-1 min-w-0">
                                    {content}
                                </div>
                                <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 flex-shrink-0">
                                    {timeStr}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    // COMPACT STRIP MODE: Subtle horizontal ticker when active listings exist
    const latestItems = feed.slice(0, 5);

    return (
        <div className="mb-2 bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 rounded-2xl p-2 sm:px-3 text-xs transition-all">
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-shrink-0 text-zinc-500 dark:text-zinc-400 font-bold text-[11px]">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
                    <span>Live Pulse</span>
                </div>

                <div className="flex-1 overflow-x-auto scrollbar-none flex items-center gap-2">
                    {latestItems.map((item) => (
                        <span
                            key={item.id}
                            className="flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white dark:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-700/60 text-[11px] text-zinc-700 dark:text-zinc-300 font-medium"
                        >
                            <span aria-hidden="true">{EVENT_EMOJIS[item.eventType] || '✨'}</span>
                            {getCompactLabel(item)}
                            <span className="text-zinc-400 text-[10px] ml-0.5">{formatRelativeTime(item.createdAt)}</span>
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}
