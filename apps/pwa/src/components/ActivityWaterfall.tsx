/**
 * ActivityWaterfall — Living Community Activity Pulse (#208).
 *
 * Provides a real-time, ambient activity stream of recent joins, trades, ratings,
 * and posts to ensure communities feel alive and welcoming during cold-start or quiet periods.
 */

import React, { useState, useEffect, useRef } from 'react';
import { getActivityFeedApi, type ActivityFeedItem } from '../lib/api';
import { withJitter } from '../lib/jitter';
import { onSyncActivity } from '../lib/sync';
import { formatNumber, t, tn, activityTarget } from '@beanpool/core';
import { Sentence } from './Sentence';

interface Props {
    isFullView?: boolean;
    /** The node only serves this feed to its members (it names who traded with whom, and for how many
     *  Beans). A guest (false) is not sent to fetch a 403 — the full view says why it is empty instead;
     *  null means membership is still being checked, so nothing is fetched yet. */
    isMember?: boolean | null;
    /** Open the listing a Live Pulse chip names, the way the Market's own cards open one. Omitted
     *  means chips that would open a listing stay plain text rather than pretending to be controls. */
    onOpenPost?: (postId: string) => void;
    /** Open a member's profile from a Live Pulse chip. Same rule as `onOpenPost` when omitted. */
    onOpenProfile?: (pubkey: string) => void;
}

function formatRelativeTime(isoDate: string): string {
    const diffMs = Date.now() - new Date(isoDate).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return t('just now');
    if (diffMins < 60) return t('{n}m ago', { n: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t('{n}h ago', { n: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    return t('{n}d ago', { n: diffDays });
}

/** A Beans amount the feed carries (a number from the node), written the language's way; anything else as it came. */
function beansAmount(v: unknown): string {
    return typeof v === 'number' ? formatNumber(v) : String(v);
}

/** The emoji that heads a Live Pulse chip. */
function pulseEmoji(eventType: ActivityFeedItem['eventType']): string {
    switch (eventType) {
        case 'member_joined': return '🎉';
        case 'trade_completed': return '✅';
        case 'rating_given': return '⭐️';
        case 'post_created': return '📍';
        case 'dispute_resolved': return '⚖️';
        default: return '✨';
    }
}

/**
 * What a Live Pulse chip reads at rest, and the longer line it reveals while the pointer is over it.
 *
 * `full` only ever uses detail the feed already carries and already shows members elsewhere — a
 * listing's title, a rating's comment. Nothing is fetched per chip, and nothing private is added.
 */
function pulseText(item: ActivityFeedItem): { short: string; full: string } {
    // The names, titles and comments are the members' own, shown as written inside each sentence.
    const actor = item.actorCallsign || t('Someone');
    const target = item.targetCallsign || t('another member');
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');

    switch (item.eventType) {
        case 'trade_completed': {
            const title = text(item.metadata?.postTitle);
            return {
                short: t('{actor} traded', { actor }),
                full: title ? t('{actor} traded with {target}: {title}', { actor, target, title }) : t('{actor} traded with {target}', { actor, target }),
            };
        }
        case 'rating_given': {
            const comment = text(item.metadata?.comment);
            return {
                short: t('{actor} rated ★', { actor }),
                full: comment ? t('{actor} rated {target}: “{comment}”', { actor, target, comment }) : t('{actor} rated {target}', { actor, target }),
            };
        }
        case 'post_created': {
            const title = text(item.metadata?.title);
            return {
                short: t('{actor} posted', { actor }),
                full: title ? t('{actor} posted: {title}', { actor, title }) : t('{actor} posted', { actor }),
            };
        }
        case 'dispute_resolved':
            // The actor here is whoever ruled — an admin, or the owner password. Naming them would put a
            // moderator in front of every member, so this chip stays impersonal and opens nothing.
            // (Before this mapping it fell through to the default and read "<admin> joined".)
            return { short: t('Dispute resolved'), full: t('A trade dispute was resolved') };
        case 'member_joined':
        default:
            return { short: t('{actor} joined', { actor }), full: t('{actor} joined the community', { actor }) };
    }
}

/** Slow enough to read a listing title, rather than a ticker: ~40 CSS pixels a second. */
const PULSE_SCROLL_PX_PER_SECOND = 40;
const PULSE_MIN_SCROLL_SECONDS = 1.5;

function usePrefersReducedMotion(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        // jsdom has no matchMedia, and neither does an old WebView; no query means no reduction asked for.
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        setReduced(mq.matches);
        const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
        mq.addEventListener?.('change', onChange);
        return () => mq.removeEventListener?.('change', onChange);
    }, []);
    return reduced;
}

// `relative`: the chip holds its screen-reader line (sr-only, absolutely placed), so the strip's own scroller clips it;
// otherwise a chip scrolled past the strip's end widened the whole page (measured at 320 px: 512 px wide).
const PULSE_CHIP_SHELL =
    'relative flex-shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white dark:bg-zinc-800 ' +
    'border border-zinc-200/60 dark:border-zinc-700/60 text-[11px] text-zinc-700 dark:text-zinc-300 font-medium';

/**
 * One chip in the Live Pulse strip.
 *
 * Clickable when the item has somewhere to go, plain text when it has not. The reveal is CSS: the
 * chip's visible width comes from a hidden sizer holding the short line, the full line sits on top of
 * it and is clipped, and `is-scrolling` slides it by the measured overflow. Nothing moves until a
 * pointer is over the chip or it takes keyboard focus, and dropping the class snaps it back with no
 * transition. The stylesheet gates the movement on a real hovering pointer, so a tap only opens.
 */
function PulseChip({
    item,
    onOpenPost,
    onOpenProfile,
    prefersReducedMotion,
}: {
    item: ActivityFeedItem;
    onOpenPost?: (postId: string) => void;
    onOpenProfile?: (pubkey: string) => void;
    prefersReducedMotion: boolean;
}) {
    const viewportRef = useRef<HTMLSpanElement | null>(null);
    const trackRef = useRef<HTMLSpanElement | null>(null);

    const { short, full } = pulseText(item);
    const timeStr = formatRelativeTime(item.createdAt);
    const target = activityTarget(item);

    const reveal = () => {
        if (prefersReducedMotion) return;
        const viewport = viewportRef.current;
        const track = trackRef.current;
        if (!viewport || !track) return;
        // Measured on every reveal: the overflow moves with the font size, the zoom and the text itself.
        const overflow = Math.round(track.scrollWidth - viewport.clientWidth);
        if (overflow <= 0) return;
        const seconds = Math.max(PULSE_MIN_SCROLL_SECONDS, overflow / PULSE_SCROLL_PX_PER_SECOND);
        viewport.style.setProperty('--pulse-overflow', `${overflow}px`);
        viewport.style.setProperty('--pulse-duration', `${seconds.toFixed(2)}s`);
        viewport.classList.add('is-scrolling');
    };

    const snapBack = () => {
        viewportRef.current?.classList.remove('is-scrolling');
    };

    const inner = (
        <>
            <span aria-hidden="true">{pulseEmoji(item.eventType)}</span>
            <span className="pulse-chip-viewport" ref={viewportRef} aria-hidden="true">
                <span className="pulse-chip-sizer">{short}</span>
                <span className="pulse-chip-track" ref={trackRef}>{full}</span>
            </span>
            <span className="text-zinc-400 text-[10px] ml-0.5" aria-hidden="true">{timeStr}</span>
        </>
    );

    const canOpen = target !== null
        && ((target.kind === 'post' && !!onOpenPost) || (target.kind === 'profile' && !!onOpenProfile));

    if (target === null || !canOpen) {
        return (
            <span
                className={PULSE_CHIP_SHELL}
                title={prefersReducedMotion && full !== short ? full : undefined}
                onMouseEnter={reveal}
                onMouseLeave={snapBack}
            >
                {/* The chip's own text is hidden from a screen reader: the sizer would read it twice. */}
                <span className="sr-only">{t('{summary}, {time}', { summary: full, time: timeStr })}</span>
                {inner}
            </span>
        );
    }

    return (
        <button
            type="button"
            className={`${PULSE_CHIP_SHELL} text-left cursor-pointer transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-700/70 hover:border-zinc-300 dark:hover:border-zinc-600`}
            aria-label={t('{summary}, {time} — open', { summary: full, time: timeStr })}
            title={prefersReducedMotion && full !== short ? full : undefined}
            onClick={() => {
                if (target.kind === 'post') onOpenPost?.(target.postId);
                else onOpenProfile?.(target.pubkey);
            }}
            onMouseEnter={reveal}
            onMouseLeave={snapBack}
            onFocus={reveal}
            onBlur={snapBack}
        >
            {inner}
        </button>
    );
}

export function ActivityWaterfall({ isFullView = false, isMember = true, onOpenPost, onOpenProfile }: Props) {
    const [feed, setFeed] = useState<ActivityFeedItem[]>([]);
    const [loading, setLoading] = useState(true);
    // Read here, not inside PulseChip: the early returns below sit between the two, and a hook may not
    // be called conditionally.
    const prefersReducedMotion = usePrefersReducedMotion();

    useEffect(() => {
        if (isMember !== true) return;
        let isMounted = true;
        let timer: ReturnType<typeof setInterval> | null = null;
        let lastFetchTime = 0;
        let fetchPromise: Promise<void> | null = null;

        async function fetchFeed() {
            if (fetchPromise) return fetchPromise;
            const p = (async () => {
                try {
                    const res = await getActivityFeedApi(30, 0);
                    if (isMounted && res?.feed) {
                        setFeed(res.feed);
                    }
                    // Stamped on SUCCESS only — see the note in MapPage. A failed fetch in
                    // `finally` counted as a refresh and the cooldown suppressed the retry.
                    lastFetchTime = Date.now();
                } catch (e) {
                    console.warn('[ActivityWaterfall] Could not fetch activity feed:', e);
                    throw e;
                } finally {
                    if (isMounted) setLoading(false);
                    fetchPromise = null;
                }
            })();
            fetchPromise = p;
            return p;
        }

        const startPolling = () => {
            if (!timer) {
                fetchFeed().catch(() => {});
                timer = setInterval(() => {
                    fetchFeed().catch(() => {});
                }, withJitter(300_000));
            }
        };

        const stopPolling = () => {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopPolling();
            } else {
                startPolling();
            }
        };

        if (!document.hidden) {
            startPolling();
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Fast path: WebSocket broadcasts trigger coordinated sync.
        // Returns the in-flight or fresh promise to coordinator so delta cursor advances only on success.
        // Coalesces with visibilitychange / reconnect sync if already in-flight or refreshed within 2000ms.
        const unsubscribe = onSyncActivity(() => {
            if (document.hidden) return;
            if (fetchPromise) return fetchPromise;
            if (Date.now() - lastFetchTime < 2000) return;
            return fetchFeed();
        });

        return () => {
            isMounted = false;
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            unsubscribe();
        };
    }, [isMember]);

    if (isMember === false) {
        return isFullView ? (
            <div className="py-12 flex flex-col items-center justify-center text-center p-6 bg-zinc-50 dark:bg-zinc-900/40 rounded-2xl border border-zinc-200/80 dark:border-zinc-800">
                <div className="text-4xl mb-3" aria-hidden="true">🌱</div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{t('Community activity is for members')}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mt-1">
                    {t('Join this community to see who is trading and who is new.')}
                </p>
            </div>
        ) : null;
    }

    if (loading && feed.length === 0) {
        return isFullView ? (
            <div className="py-12 flex flex-col items-center justify-center text-zinc-400">
                <div className="animate-spin text-2xl mb-2" aria-hidden="true">⏳</div>
                <p className="text-xs font-semibold">{t('Tuning into community pulse...')}</p>
            </div>
        ) : null;
    }

    if (feed.length === 0) {
        return isFullView ? (
            <div className="py-12 flex flex-col items-center justify-center text-center p-6 bg-zinc-50 dark:bg-zinc-900/40 rounded-2xl border border-zinc-200/80 dark:border-zinc-800">
                <div className="text-4xl mb-3" aria-hidden="true">🌱</div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{t('Welcome to the Community')}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-sm mt-1">
                    {t("You're among the first here! Create an offer or need above to start local circulation.")}
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
                        {t('Community Pulse')}
                    </div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{t('Recent Community Life')}</h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {t('Live activity across members and trades')}
                    </p>
                </div>

                <div className="space-y-2.5">
                    {feed.map((item) => {
                        const actorName = item.actorCallsign || t('Member');
                        const targetName = item.targetCallsign || t('Member');
                        const timeStr = formatRelativeTime(item.createdAt);
                        // Each line is one sentence in the member's language, as on the phone; the names (and a
                        // listing's title) are the members' own, bold parts of it wherever the language puts them.
                        const actor = <span className="font-bold text-zinc-900 dark:text-zinc-100">{actorName}</span>;
                        const target = <span className="font-bold text-zinc-900 dark:text-zinc-100">{targetName}</span>;

                        let emoji = '✨';
                        let badgeBg = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300';
                        let content = null;

                        switch (item.eventType) {
                            case 'member_joined':
                                emoji = '🎉';
                                badgeBg = 'bg-indigo-50 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800';
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <Sentence text={t('{actor} joined the community')} parts={{ actor }} />
                                    </p>
                                );
                                break;
                            case 'trade_completed':
                                emoji = '✅';
                                badgeBg = 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800';
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <Sentence text={t('{actor} completed a trade with {target}')} parts={{ actor, target }} />
                                        {item.metadata?.credits && (
                                            <span className="ml-1 font-bold text-emerald-600 dark:text-emerald-400">
                                                (🫘 {beansAmount(item.metadata.credits)})
                                            </span>
                                        )}
                                    </p>
                                );
                                break;
                            case 'rating_given': {
                                const starCount = Math.max(1, Math.min(5, Math.round(Number(item.metadata?.stars) || 5)));
                                emoji = '⭐️';
                                badgeBg = 'bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800';
                                const stars = (
                                    <span
                                        className="font-bold text-amber-500"
                                        role="img"
                                        aria-label={tn(starCount, '{n} out of 5 stars', '{n} out of 5 stars')}
                                    >
                                        {'★'.repeat(starCount)}
                                    </span>
                                );
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <Sentence text={t('{actor} rated {target} {stars}')} parts={{ actor, target, stars }} />
                                        {item.metadata?.comment && (
                                            <span dir="auto" className="italic text-zinc-500 dark:text-zinc-400 block text-[11px] mt-0.5">
                                                "{item.metadata.comment}"
                                            </span>
                                        )}
                                    </p>
                                );
                                break;
                            }
                            case 'post_created': {
                                emoji = '📍';
                                badgeBg = 'bg-sky-50 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-800';
                                const credits = item.metadata?.credits;
                                const title = <span className="font-bold text-zinc-900 dark:text-zinc-100">{item.metadata?.title || t('Listing')}</span>;
                                content = (
                                    <p className="text-xs text-zinc-800 dark:text-zinc-200">
                                        <Sentence
                                            text={credits
                                                ? t('{actor} posted "{title}" for 🫘 {credits}', { credits: typeof credits === 'number' ? credits : String(credits) })
                                                : t('{actor} posted "{title}"')}
                                            parts={{ actor, title }}
                                        />
                                    </p>
                                );
                                break;
                            }
                        }

                        const rowTarget = activityTarget(item);
                        const canOpen = rowTarget !== null
                            && ((rowTarget.kind === 'post' && !!onOpenPost) || (rowTarget.kind === 'profile' && !!onOpenProfile));
                        const rowShell = 'flex items-center gap-3 p-3 min-h-[44px] w-full rounded-2xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800 shadow-sm hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors';
                        const rowBody = (
                            <>
                                <span
                                    className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0 border ${badgeBg}`}
                                    aria-hidden="true"
                                >
                                    {emoji}
                                </span>
                                <span className="block flex-1 min-w-0">
                                    {content}
                                </span>
                                <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-400 flex-shrink-0">
                                    {timeStr}
                                </span>
                            </>
                        );

                        // One real button when the row has somewhere to go (its own sentence is its name); a row
                        // with nothing to open stays plain text rather than a dead control.
                        if (!canOpen || rowTarget === null) {
                            return <div key={item.id} className={rowShell}>{rowBody}</div>;
                        }
                        return (
                            <button
                                key={item.id}
                                type="button"
                                className={`${rowShell} text-left cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:focus-visible:outline-emerald-400`}
                                onClick={() => {
                                    if (rowTarget.kind === 'post') onOpenPost?.(rowTarget.postId);
                                    else onOpenProfile?.(rowTarget.pubkey);
                                }}
                            >
                                {rowBody}
                            </button>
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
                    <span>{t('Live Pulse')}</span>
                </div>

                <div className="flex-1 overflow-x-auto scrollbar-none flex items-center gap-2">
                    {latestItems.map((item) => (
                        <PulseChip
                            key={item.id}
                            item={item}
                            onOpenPost={onOpenPost}
                            onOpenProfile={onOpenProfile}
                            prefersReducedMotion={prefersReducedMotion}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
