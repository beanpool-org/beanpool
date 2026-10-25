/**
 * Small icons in the web header showing what needs you right now.
 * Parity with the phone's apps/native/components/NeedsYouIcons.tsx.
 *
 * Shown to members only, between the title/logo and the pill.
 * Stacks from the right: the highest-priority icon sits nearest the pill.
 * When several needs show and width is constrained (e.g. 320 px × 130%),
 * collapses into "•••" which opens the "Needs you" sheet.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRefreshGate, fitNeedsYou, isOwnInviteChange, needsYouRowOrder, NEEDS_YOU_PRIORITY, type NeedsYouKind } from '@beanpool/core';
import { t, tn } from '@beanpool/core';
import type { NeedsItem, NeedsTarget } from '../lib/home-cards';
import { freshHomeForHeader, homeForHeader, onHomeRead, HOME_HEADER_WAIT_MS, recordHomeAnswer, forgetHomeForHeader } from '../lib/home-store';
import { onSyncActivity } from '../lib/sync';
import { useDialogFocus } from './dialog-focus';
import * as api from '../lib/api';

const NODE_MIN_GAP_MS = 15_000;
const SAFETY_POLL_MS = 120_000;
const WS_SETTLE_MS = 3_000;

export function moreLabel(hidden: number): string {
    return tn(hidden, '{n} more thing needs you', '{n} more things need you');
}

/** Where a tap on a need lands in the web app. Parity with HomePage.tsx:1802-1820. */
export function goToWebNeedsTarget(target: NeedsTarget, onNavigate?: (tab: string, ctxId?: string) => void): void {
    if (!onNavigate) return;
    switch (target.to) {
        case 'deal': return onNavigate('marketplace', target.postId);
        case 'my-deals': return onNavigate('marketplace');
        case 'decide': return onNavigate('projects');
        case 'chat': return onNavigate('messages', target.conversationId);
        case 'unread-messages': case 'your-groups': return onNavigate('messages');
        case 'enterprise': return onNavigate('enterprise', target.id);
        case 'group': return onNavigate('group', target.id);
        case 'invite': return onNavigate('group', target.id);
        case 'invites': return onNavigate('projects');
        default: return undefined;
    }
}

/** Slot width in pixels for each header alert icon. 44 px matches tour-check and pill height. */
export const HEADER_ALERT_SLOT_PX = 44;

function NeedSvg({ kind }: { kind: NeedsYouKind | 'more' }) {
    switch (kind) {
        case 'invite':
            return (
                <svg className="w-[20px] h-[20px] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="invite">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                </svg>
            );
        case 'deal':
            return (
                <svg className="w-[20px] h-[20px] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="deal">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m11 17 2 2a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4l-2-2m-2-2-2-2a1 1 0 0 0-1.4 0L4 13.6a1 1 0 0 0 0 1.4l2 2m12-7 2.3-2.3a1 1 0 0 0 0-1.4l-2.6-2.6a1 1 0 0 0-1.4 0L12 8m1 7 2.3 2.3a1 1 0 0 0 1.4 0l2.6-2.6a1 1 0 0 0 0-1.4L17 11" />
                </svg>
            );
        case 'vote':
            return (
                <svg className="w-[20px] h-[20px] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="vote">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4" />
                </svg>
            );
        case 'message':
            return (
                <svg className="w-[20px] h-[20px] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="message">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a.75.75 0 0 1-.974-.974 5.96 5.96 0 0 1 1.057-4.035C4.54 14.654 4 13.38 4 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
                </svg>
            );
        case 'group':
            return (
                <svg className="w-[20px] h-[20px] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="group">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                </svg>
            );
        case 'more':
            return (
                <svg className="w-[20px] h-[20px] shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="more">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
                </svg>
            );
        default:
            return null;
    }
}

let needsReadPromise: Promise<any> | null = null;
function fetchNeedsDeduped(): Promise<any> {
    if (!needsReadPromise && 'getHome' in api && typeof api.getHome === 'function') {
        needsReadPromise = Promise.resolve(api.getHome({ cards: ['needs'] })).finally(() => {
            needsReadPromise = null;
        });
    }
    return needsReadPromise || Promise.resolve({ notModified: true });
}

export function NeedsYouIcons({
    identityPubkey,
    onNavigate,
    isHome: _isHome = false,
    activeTab,
    variant = 'header',
}: {
    identityPubkey?: string;
    onNavigate?: (tab: string, ctxId?: string) => void;
    isHome?: boolean;
    activeTab?: string;
    variant?: 'header' | 'sidebar';
}) {
    const [entries, setEntries] = useState<NeedsItem[]>([]);
    const [sheet, setSheet] = useState(false);
    const [availableRoom, setAvailableRoom] = useState<number | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const gate = useRef<ReturnType<typeof createRefreshGate> | null>(null);
    const identityRef = useRef(identityPubkey);
    identityRef.current = identityPubkey;
    const activeTabRef = useRef(activeTab);
    activeTabRef.current = activeTab;
    const busyRef = useRef(false);

    // Filter out 'admin' (which requires phone unlock and has no web equivalent)
    const filterAndSort = useCallback((items: NeedsItem[]) => {
        const supported = items.filter(i => (i.kind as string) !== 'admin');
        const rank = (k: NeedsYouKind) => NEEDS_YOU_PRIORITY.indexOf(k);
        return [...supported].sort((a, b) => rank(a.kind) - rank(b.kind));
    }, []);

    const isHidden = useCallback(() => {
        if (variant === 'sidebar') {
            if (typeof window !== 'undefined') {
                if (window.matchMedia?.('(max-width: 767px)').matches || window.innerWidth < 768) {
                    return true;
                }
            }
        } else {
            const el = containerRef.current;
            const header = el?.closest('header');
            if (header?.classList.contains('md:hidden')) {
                if (typeof window !== 'undefined') {
                    if (window.matchMedia?.('(min-width: 768px)').matches || window.innerWidth >= 768) {
                        return true;
                    }
                }
            }
        }
        return false;
    }, [variant]);

    const refresh = useCallback(async () => {
        const pk = identityRef.current;
        if (!pk || busyRef.current || isHidden()) return;
        busyRef.current = true;
        try {
            const onHome = activeTabRef.current === 'home';
            const ans = await homeForHeader(pk, onHome ? HOME_HEADER_WAIT_MS : 0);
            if (ans?.cards?.needs?.items) {
                setEntries(filterAndSort(ans.cards.needs.items));
            } else if (!onHome) {
                const read = await fetchNeedsDeduped();
                if (read && !read.notModified && read.answer) {
                    recordHomeAnswer(read.answer, pk);
                    if (read.answer.cards?.needs?.items) {
                        setEntries(filterAndSort(read.answer.cards.needs.items));
                    }
                }
            }
        } catch {
            // Network errors keep whatever was drawn
        } finally {
            busyRef.current = false;
        }
    }, [filterAndSort, isHidden]);

    // Load initial data and subscribe to Home reads and refresh gate
    useEffect(() => {
        if (!identityPubkey) {
            setEntries([]);
            return;
        }

        // Draw initial data if already fresh in store
        const fresh = freshHomeForHeader(identityPubkey);
        if (fresh?.cards?.needs?.items) {
            setEntries(filterAndSort(fresh.cards.needs.items));
        }

        const g = createRefreshGate(NODE_MIN_GAP_MS, () => {
            refresh();
        });
        gate.current = g;

        // Initial poke
        g.request();

        // Listen for future Home reads settling
        const unsubscribe = onHomeRead((ans, pk) => {
            if (pk === identityPubkey && ans?.cards?.needs?.items) {
                setEntries(filterAndSort(ans.cards.needs.items));
            }
        });

        return () => {
            g.cancel();
            if (gate.current === g) gate.current = null;
            unsubscribe();
        };
    }, [identityPubkey, filterAndSort, refresh]);

    // Each tab change requests a refresh through the gate (copying phone's refresh rule)
    useEffect(() => {
        gate.current?.request();
    }, [activeTab]);

    // Returning to the tab, debounced WebSocket activity, and safety poll
    useEffect(() => {
        if (!identityPubkey) return;

        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;
        const poke = () => gate.current?.request();

        const startPoll = () => { if (!poll) poll = setInterval(poke, SAFETY_POLL_MS); };
        const stopPoll = () => { if (poll) clearInterval(poll); poll = null; };

        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
            startPoll();
        }

        const onVisibilityChange = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
                poke();
                startPoll();
            } else {
                stopPoll();
            }
        };

        const onFocus = () => {
            poke();
        };

        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', onVisibilityChange);
        }
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', onFocus);
        }

        const unsubSync = onSyncActivity((data?: unknown) => {
            if (isOwnInviteChange(data, identityPubkey)) {
                forgetHomeForHeader();
            }
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(poke, WS_SETTLE_MS);
        });

        return () => {
            stopPoll();
            if (typeof document !== 'undefined') {
                document.removeEventListener('visibilitychange', onVisibilityChange);
            }
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', onFocus);
            }
            unsubSync();
            if (settleTimer) clearTimeout(settleTimer);
        };
    }, [identityPubkey]);

    // Measure available room dynamically to keep tab titles unclipped and map logo uncovered
    useLayoutEffect(() => {
        if (variant === 'sidebar') return;

        const el = containerRef.current;
        if (!el) return;

        const header = el.closest('header');
        if (!header) return;

        const measure = () => {
            const headerRect = header.getBoundingClientRect();
            if (headerRect.width <= 0) return;

            const pill = header.querySelector<HTMLElement>('[data-testid="header-pill"]');
            const pillRect = pill?.getBoundingClientRect();
            const pillWidth = (pillRect && pillRect.width > 0) ? pillRect.width : 100;

            const titleSpan = header.querySelector<HTMLElement>('[data-testid="header-title"]');
            const logo = header.querySelector<HTMLElement>('.absolute.left-1\\/2') ?? header.querySelector<HTMLElement>('[data-testid="header-logo"]');

            if (titleSpan) {
                // Non-map tab: HeaderTitle must keep its full width
                let titleNeeded: number;
                try {
                    const range = document.createRange();
                    range.selectNodeContents(titleSpan);
                    const rect = range.getBoundingClientRect();
                    titleNeeded = rect.width || titleSpan.getBoundingClientRect().width;
                } catch {
                    titleNeeded = titleSpan.getBoundingClientRect().width;
                }
                const cs = typeof window !== 'undefined' ? window.getComputedStyle(titleSpan) : null;
                const titlePadding = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;

                const chip = header.querySelector<HTMLElement>('[data-testid="sync-chip"]');
                const chipBox = chip?.parentElement;
                const chipWidth = chipBox ? chipBox.getBoundingClientRect().width : (chip?.getBoundingClientRect().width ?? 0);

                const headerStyle = typeof window !== 'undefined' ? window.getComputedStyle(header) : null;
                const padL = (headerStyle && parseFloat(headerStyle.paddingLeft)) || 12;
                const padR = (headerStyle && parseFloat(headerStyle.paddingRight)) || 12;
                const headerPadding = padL + padR;
                const totalInnerWidth = headerRect.width - headerPadding;

                // Title container has padding 0 6px (12px total)
                const neededTitleSpace = titleNeeded + titlePadding + 12;
                // Available for right controls (icons + gap + pill)
                const maxRightSpace = totalInnerWidth - chipWidth - neededTitleSpace;
                const room = Math.max(0, maxRightSpace - pillWidth - 6);
                setAvailableRoom(room);
            } else if (logo) {
                // Map tab: logo is absolutely centred, nothing may overlap it
                const logoRect = logo.getBoundingClientRect();
                const pillLeft = (pillRect && pillRect.width > 0 && pillRect.left > 0) ? pillRect.left : (headerRect.width - 12 - pillWidth);
                // Icons sit between logo.right and pill.left (leaving 4px margin from logo)
                const room = Math.max(0, (pillLeft - 6) - (logoRect.right + 4));
                setAvailableRoom(room);
            } else {
                const total = headerRect.width;
                if (total > 0 && total <= 360) {
                    setAvailableRoom(HEADER_ALERT_SLOT_PX + 2);
                } else if (total > 0 && total <= 480) {
                    setAvailableRoom(HEADER_ALERT_SLOT_PX * 2 + 4);
                } else if (total > 0 && total <= 640) {
                    setAvailableRoom(HEADER_ALERT_SLOT_PX * 3 + 4);
                } else {
                    setAvailableRoom(undefined);
                }
            }
        };

        measure();

        const scheduleMeasure = () => {
            measure();
        };

        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(scheduleMeasure);
            observer.observe(header);
            const titleSpan = header.querySelector('[data-testid="header-title"]');
            if (titleSpan) observer.observe(titleSpan);
            const logo = header.querySelector('.absolute.left-1\\/2');
            if (logo) observer.observe(logo);
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('resize', scheduleMeasure);
        }

        let live = true;
        document.fonts?.ready?.then(() => {
            if (live) measure();
        });

        return () => {
            live = false;
            if (observer) observer.disconnect();
            if (typeof window !== 'undefined') {
                window.removeEventListener('resize', scheduleMeasure);
            }
        };
    }, [entries.length, activeTab, variant]);

    if (!identityPubkey) return null;

    if (isHidden() || entries.length === 0) {
        return <div ref={containerRef} style={{ display: 'none' }} />;
    }

    const slotPx = HEADER_ALERT_SLOT_PX;
    const countChipPx = 28;

    // In unmeasured/jsdom test environments, default allows showing icons without collapsing
    const effectiveWidth = availableRoom !== undefined ? availableRoom : 240;

    if (effectiveWidth < countChipPx) {
        return null;
    }

    const isChipOnly = effectiveWidth < slotPx;
    const hasAccent = entries.some(e => e.accent);

    if (isChipOnly) {
        const totalCount = entries.reduce((acc, e) => acc + (e.count || 1), 0);
        const label = moreLabel(entries.length);
        return (
            <div
                ref={containerRef}
                data-testid="header-needs-icons"
                className="flex items-center justify-end min-w-0 flex-shrink"
                style={{ height: '38px', maxWidth: `${countChipPx}px` }}
            >
                <button
                    onClick={() => setSheet(true)}
                    aria-label={label}
                    title={label}
                    data-testid="header-needs-chip"
                    className={`relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer rounded-full transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px] -my-[3px]`}
                    style={{ width: `${countChipPx}px`, height: '44px' }}
                >
                    <span
                        className={`min-w-[20px] h-[20px] px-1 rounded-full text-[11px] font-black flex items-center justify-center leading-none ${
                            hasAccent ? 'bg-amber-300 text-stone-900' : 'bg-white/90 text-stone-900'
                        }`}
                    >
                        {totalCount > 9 ? '9+' : totalCount}
                    </span>
                </button>
                {sheet && (
                    <NeedsSheet
                        entries={entries}
                        onClose={() => setSheet(false)}
                        onNavigate={onNavigate}
                    />
                )}
            </div>
        );
    }

    const fit = fitNeedsYou(entries, effectiveWidth, slotPx);
    const byKind = new Map(fit.shown.map(e => [e.kind, e]));
    const rowOrder = needsYouRowOrder(fit);
    const isSidebar = variant === 'sidebar';

    return (
        <div
            ref={containerRef}
            data-testid="header-needs-icons"
            className="flex items-center justify-end min-w-0 flex-shrink"
            style={{
                height: isSidebar ? undefined : '38px',
                maxWidth: availableRoom !== undefined ? `${availableRoom}px` : undefined,
            }}
        >
            {rowOrder.map(k => {
                if (k === 'more') {
                    const label = moreLabel(fit.hidden);
                    return (
                        <button
                            key="more"
                            onClick={() => setSheet(true)}
                            aria-label={label}
                            title={label}
                            data-testid="header-needs-more"
                            className={`relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px] -my-[3px] ${
                                isSidebar
                                    ? 'rounded-lg text-nature-700 dark:text-nature-200 hover:bg-nature-200/60 dark:hover:bg-nature-800/60'
                                    : 'rounded-full text-white hover:bg-white/15'
                            }`}
                            style={{ width: `${HEADER_ALERT_SLOT_PX}px`, height: '44px' }}
                        >
                            <NeedSvg kind="more" />
                        </button>
                    );
                }

                const entry = byKind.get(k);
                if (!entry) return null;
                const isAccent = entry.accent;

                const iconColor = isSidebar
                    ? (isAccent ? 'text-amber-600 dark:text-amber-400' : 'text-nature-700 dark:text-nature-200')
                    : (isAccent ? 'text-amber-300' : 'text-white');

                return (
                    <button
                        key={k}
                        onClick={() => goToWebNeedsTarget(entry.target, onNavigate)}
                        aria-label={entry.label}
                        title={entry.label}
                        data-testid={`header-needs-${k}`}
                        data-kind={k}
                        className={`relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px] -my-[3px] ${iconColor} ${
                            isSidebar
                                ? 'rounded-lg hover:bg-nature-200/60 dark:hover:bg-nature-800/60'
                                : 'rounded-full hover:bg-white/15'
                        }`}
                        style={{ width: `${HEADER_ALERT_SLOT_PX}px`, height: '44px' }}
                    >
                        <NeedSvg kind={k} />
                        {entry.count > 1 && (
                            <span
                                className={`absolute top-2 right-1.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-black flex items-center justify-center leading-none pointer-events-none ${
                                    isAccent ? 'bg-amber-300 text-stone-900' : 'bg-white/90 text-stone-900'
                                }`}
                            >
                                {entry.count > 9 ? '9+' : entry.count}
                            </span>
                        )}
                    </button>
                );
            })}

            {sheet && (
                <NeedsSheet
                    entries={entries}
                    onClose={() => setSheet(false)}
                    onNavigate={onNavigate}
                />
            )}
        </div>
    );
}

function NeedsSheet({
    entries,
    onClose,
    onNavigate,
}: {
    entries: NeedsItem[];
    onClose: () => void;
    onNavigate?: (tab: string, ctxId?: string) => void;
}) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialogRef, onClose);

    return (
        <div
            className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center pt-16 px-4"
            onClick={onClose}
            data-testid="needs-sheet-backdrop"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="needs-sheet-title"
                className="w-full max-w-sm bg-surface-card rounded-2xl shadow-xl overflow-hidden border border-border-secondary p-3 animate-fade-in"
                onClick={e => e.stopPropagation()}
                data-testid="needs-sheet"
            >
                <div className="flex items-center justify-between pb-2 border-b border-border-secondary px-2">
                    <h2
                        id="needs-sheet-title"
                        tabIndex={-1}
                        className="text-xs font-bold uppercase tracking-wider text-text-secondary outline-none"
                    >
                        {t('Needs you')}
                    </h2>
                    <button
                        onClick={onClose}
                        aria-label={t('Close')}
                        className="text-text-muted hover:text-text-primary p-1 rounded-full cursor-pointer"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="py-1 max-h-[60vh] overflow-y-auto">
                    {entries.map((e) => (
                        <button
                            key={e.kind}
                            onClick={() => {
                                onClose();
                                goToWebNeedsTarget(e.target, onNavigate);
                            }}
                            aria-label={e.label}
                            className="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-surface-subtle text-left transition-colors cursor-pointer min-h-[44px]"
                        >
                            <span className={e.accent ? 'text-amber-500 dark:text-amber-400' : 'text-text-secondary'}>
                                <NeedSvg kind={e.kind} />
                            </span>
                            <span className={`flex-1 text-sm text-text-heading ${e.accent ? 'font-bold' : 'font-medium'} line-clamp-2`}>
                                {e.label}
                            </span>
                            <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                            </svg>
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
