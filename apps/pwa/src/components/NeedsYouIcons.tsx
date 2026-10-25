/**
 * Small icons showing what needs you right now: parity with the phone's apps/native/components/NeedsYouIcons.tsx. One
 * icon per kind, only while something of that kind does; the highest-priority icon sits nearest the "?" and Settings,
 * and the lowest fold first into "•••", which opens the "Needs you" sheet (@beanpool/core needs-you.ts, as the phone's).
 * Members only.
 *
 * Where they are drawn (AppHeader.tsx):
 * - The mobile header (under 768 px): beside the tab's name, in the room between the sync chip and the pill
 *   (HeaderTitle's `end`). The row's CSS gives the name its words first and this slot what is left, up to a slot per kind,
 *   so nothing measured here can cut the name. The slot measures its own width, as the phone's row does (onLayout), and
 *   draws what fits in it; what it draws never changes that width, and it stays mounted on every tab, so every change of
 *   tab, needs or width is measured. On the map the logo is drawn over that room: the slot stops 4 px short of it (at
 *   320–430 px there is no room at all). Between 28 and 44 px, a count chip in place of the icons.
 * - The side bar (768 px and up): a row of their own above the connection status, the "?" and Settings, wrapping rather
 *   than pushing them (five kinds fit in its 232 px).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createRefreshGate, fitNeedsYou, isOwnInviteChange, needsYouRowOrder, NEEDS_YOU_PRIORITY, type NeedsYouKind } from '@beanpool/core';
import { t, tn } from '@beanpool/core';
import type { NeedsItem, NeedsTarget } from '../lib/home-cards';
import { freshHomeForHeader, homeForHeader, onHomeRead, HOME_HEADER_WAIT_MS, forgetHomeForHeader } from '../lib/home-store';
import { onSyncActivity } from '../lib/sync';
import { useDialogFocus } from './dialog-focus';
import * as api from '../lib/api';

const NODE_MIN_GAP_MS = 15_000;
const SAFETY_POLL_MS = 120_000;
const WS_SETTLE_MS = 3_000;
/** On the map: the room kept between the logo's right edge and the first icon. */
const LOGO_CLEAR_PX = 4;
/** The count chip, where the slot has room for it but not for one icon. */
const COUNT_CHIP_PX = 28;

export function moreLabel(hidden: number): string {
    return tn(hidden, '{n} more thing needs you', '{n} more things need you');
}

/** The name of a control that stands for every need at once (the count chip, or "•••" with no icon beside it). */
export function allNeedsLabel(kinds: number): string {
    return tn(kinds, '{n} thing needs you', '{n} things need you');
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
    activeTab,
    besideLogo = false,
    variant = 'header',
}: {
    identityPubkey?: string;
    onNavigate?: (tab: string, ctxId?: string) => void;
    activeTab?: string;
    /** The map's header row: its logo is drawn over the room, and the slot stops short of it. */
    besideLogo?: boolean;
    variant?: 'header' | 'sidebar';
}) {
    const [entries, setEntries] = useState<NeedsItem[]>([]);
    const [sheet, setSheet] = useState(false);
    // The header's slot: the element (a callback ref, so the effects below measure whichever is mounted), its width as laid
    // out (null until measured: with no ResizeObserver, as in jsdom, everything is drawn), and on the map how far it may
    // reach before the logo.
    const [slot, setSlotState] = useState<HTMLDivElement | null>(null);
    const [slotWidth, setSlotWidth] = useState<number | null>(null);
    const [logoRoom, setLogoRoom] = useState<number | undefined>(undefined);
    const slotRef = useRef<HTMLDivElement | null>(null);
    const setSlot = useCallback((el: HTMLDivElement | null) => {
        slotRef.current = el;
        setSlotState(el);
    }, []);

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

    // Not on screen: the side bar shows from 768 px, the mobile header (md:hidden) below it. Only the one on screen reads.
    const isHidden = useCallback(() => {
        if (typeof window === 'undefined') return false;
        const wide = !!window.matchMedia?.('(min-width: 768px)').matches || window.innerWidth >= 768;
        if (variant === 'sidebar') return !wide;
        return wide && !!slotRef.current?.closest('header')?.classList.contains('md:hidden');
    }, [variant]);

    const refresh = useCallback(async () => {
        const pk = identityRef.current;
        if (!pk || busyRef.current || isHidden()) return;
        busyRef.current = true;
        try {
            const onHome = activeTabRef.current === 'home';
            // On Home: Home's answer (fresher than two minutes, or the read Home has under way). Elsewhere it stands in only
            // while it is younger than the gap between the header's own reads: the phone reads its deals and unread
            // messages again on every page change, so a need dealt with goes at the next tab change here too.
            const ans = onHome ? await homeForHeader(pk, HOME_HEADER_WAIT_MS) : await homeForHeader(pk, 0, NODE_MIN_GAP_MS);
            if (ans?.cards?.needs?.items) {
                setEntries(filterAndSort(ans.cards.needs.items));
            } else if (!onHome) {
                // The header's own read is the header's: never recorded as Home's answer (only Home's reads stand in).
                const read = await fetchNeedsDeduped();
                if (identityRef.current === pk && read && !read.notModified && read.answer?.cards?.needs?.items) {
                    setEntries(filterAndSort(read.answer.cards.needs.items));
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

    // Returning to the tab, debounced WebSocket activity, the safety poll, and the window crossing 768 px (the header and
    // the side bar trade places, and the one now on screen hasn't read)
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
        const wide = typeof window !== 'undefined' ? window.matchMedia?.('(min-width: 768px)') : undefined;
        wide?.addEventListener?.('change', poke);

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
            wide?.removeEventListener?.('change', poke);
            unsubSync();
            if (settleTimer) clearTimeout(settleTimer);
        };
    }, [identityPubkey]);

    // The slot's own width as the row lays it out (the phone's onLayout), again whenever it changes: a tab's name, the
    // needs, the window, the text size. Its width is the row's CSS, never what is drawn in it, so this can't loop.
    useLayoutEffect(() => {
        if (!slot || typeof ResizeObserver === 'undefined') return;
        const measure = () => setSlotWidth(slot.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(slot);
        return () => observer.disconnect();
    }, [slot]);

    // On the map: the logo, centred on the header, is drawn over the room, and the slot reaches no further left than 4 px
    // short of its right edge. Both are where the row puts them whatever the slot draws.
    useLayoutEffect(() => {
        const room = slot?.parentElement;
        const logo = besideLogo ? slot?.closest('header')?.querySelector<HTMLElement>('[data-testid="header-logo"]') : null;
        if (!room || !logo) {
            setLogoRoom(undefined);
            return;
        }
        const measure = () => {
            const r = room.getBoundingClientRect();
            if (!r.width) return; // hidden (the md: layout)
            setLogoRoom(Math.max(0, Math.floor(r.right - logo.getBoundingClientRect().right - LOGO_CLEAR_PX)));
        };
        measure();
        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure);
            observer.observe(room);
            observer.observe(logo);
        }
        let live = true;
        document.fonts?.ready?.then(() => {
            if (live) measure();
        });
        return () => {
            live = false;
            observer?.disconnect();
        };
    }, [slot, besideLogo]);

    // And at once, before the browser paints, when the slot's own rule changes: the needs (its basis), the logo's room (its
    // max-width) or the tab (the name beside it). The observer above would hear of it too, but a frame late.
    useLayoutEffect(() => {
        if (slot && typeof ResizeObserver !== 'undefined') setSlotWidth(slot.getBoundingClientRect().width);
    }, [slot, logoRoom, entries.length, activeTab]);

    if (!identityPubkey) return null;

    const isSidebar = variant === 'sidebar';
    // A tap on a need: that need is about to change, so Home's copy of it no longer stands in.
    const go = (target: NeedsTarget) => {
        forgetHomeForHeader();
        goToWebNeedsTarget(target, onNavigate);
    };
    const sheetEl = sheet && (
        <NeedsSheet
            entries={entries}
            onClose={() => setSheet(false)}
            onPick={go}
        />
    );

    const needButton = (entry: NeedsItem) => {
        const k = entry.kind;
        const isAccent = entry.accent;
        const iconColor = isSidebar
            ? (isAccent ? 'text-bp-ink-warning' : 'text-text-secondary')
            : (isAccent ? 'text-amber-300' : 'text-white');
        return (
            <button
                key={k}
                onClick={() => go(entry.target)}
                aria-label={entry.label}
                title={entry.label}
                data-testid={`header-needs-${k}`}
                data-kind={k}
                className={`relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px] ${iconColor} ${
                    isSidebar
                        ? 'rounded-lg hover:bg-nature-200/60 dark:hover:bg-nature-800/60'
                        : 'rounded-full focus-visible:ring-inset hover:bg-white/15'
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
    };

    if (isSidebar) {
        if (entries.length === 0) return null;
        return (
            <div data-testid="sidebar-needs-row" className="flex flex-wrap items-center justify-end">
                {needsYouRowOrder({ shown: entries, hidden: 0 }).map(k => {
                    const entry = entries.find(e => e.kind === k);
                    return entry ? needButton(entry) : null;
                })}
            </div>
        );
    }

    const room = slotWidth ?? Infinity;
    const fit = fitNeedsYou(entries, room, HEADER_ALERT_SLOT_PX);
    const byKind = new Map(fit.shown.map(e => [e.kind, e]));
    const countChip = entries.length > 0 && fit.shown.length === 0 && fit.hidden === 0 && room >= COUNT_CHIP_PX;
    const hasAccent = entries.some(e => e.accent);

    let drawn: ReactNode = null;
    if (countChip) {
        const label = allNeedsLabel(entries.length);
        drawn = (
            <button
                onClick={() => setSheet(true)}
                aria-label={label}
                title={label}
                data-testid="header-needs-chip"
                className="relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer rounded-full transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px]"
                style={{ width: `${COUNT_CHIP_PX}px`, height: '44px' }}
            >
                <span
                    className={`min-w-[20px] h-[20px] px-1 rounded-full text-[11px] font-black flex items-center justify-center leading-none ${
                        hasAccent ? 'bg-amber-300 text-stone-900' : 'bg-white/90 text-stone-900'
                    }`}
                >
                    {entries.length > 9 ? '9+' : entries.length}
                </span>
            </button>
        );
    } else if (fit.shown.length > 0 || fit.hidden > 0) {
        drawn = needsYouRowOrder(fit).map(k => {
            if (k === 'more') {
                // With icons beside it, "•••" is the rest; alone, it is all of them.
                const label = fit.shown.length > 0 ? moreLabel(fit.hidden) : allNeedsLabel(entries.length);
                return (
                    <button
                        key="more"
                        onClick={() => setSheet(true)}
                        aria-label={label}
                        title={label}
                        data-testid="header-needs-more"
                        className="relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px] rounded-full text-white hover:bg-white/15"
                        style={{ width: `${HEADER_ALERT_SLOT_PX}px`, height: '44px' }}
                    >
                        <NeedSvg kind="more" />
                    </button>
                );
            }
            const entry = byKind.get(k);
            return entry ? needButton(entry) : null;
        });
    }

    return (
        <>
            {/* The slot: a slot per kind wide at most, shrinking to nothing before the title gives way (HeaderTitle), and on
                the map no further than the logo. 44 px tall for the targets, 38 px in the row (as the pill's). */}
            <div
                ref={setSlot}
                data-needs-slot
                className="flex items-center justify-end"
                style={{
                    flex: `0 1 ${entries.length * HEADER_ALERT_SLOT_PX}px`,
                    minWidth: 0,
                    maxWidth: logoRoom !== undefined ? `${logoRoom}px` : undefined,
                    height: '44px',
                    margin: '-3px 0',
                    overflow: 'hidden',
                }}
            >
                {drawn && (
                    <div data-testid="header-needs-icons" className="flex items-center justify-end h-full">
                        {drawn}
                    </div>
                )}
            </div>
            {sheetEl}
        </>
    );
}

function NeedsSheet({
    entries,
    onClose,
    onPick,
}: {
    entries: NeedsItem[];
    onClose: () => void;
    onPick: (target: NeedsTarget) => void;
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
                                onPick(e.target);
                            }}
                            aria-label={e.label}
                            className="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-surface-subtle text-left transition-colors cursor-pointer min-h-[44px]"
                        >
                            <span className={e.accent ? 'text-bp-ink-warning' : 'text-text-secondary'}>
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
