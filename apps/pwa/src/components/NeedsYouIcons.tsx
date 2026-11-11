/**
 * The bell in the top bar (scratch/fable-design/DESIGN-web-notifications-fable.md §2.1, slice W0; Marty, 9 Nov 2026: the
 * bell takes the needs-you row): parity with the phone's apps/native/components/NeedsYouIcons.tsx. One control: a red count
 * of the notices not yet opened (@beanpool/core notice-bell.ts), an amber dot when nothing is new but something needs the
 * member, and a sheet with what needs them now at the top ("Needs you", the open things, as the icons were) and what
 * happened under it, newest first, with the real words. A row leaves when it is tapped (it opens its thing and is
 * marked), when its ✕ is pressed (marked, opens nothing), when "Clear all" is pressed (every notice, one request), or when
 * its thing is opened (a chat read: the node marks it and tells the sockets); opening the sheet marks nothing. "Needs you"
 * is none of those: its rows are the open things, and leave when they are done (Marty, 10 Nov 2026). Members only.
 *
 * Where it is drawn (AppHeader.tsx):
 * - The mobile header (under 768 px): beside the tab's name, in the room between the sync chip and the pill
 *   (HeaderTitle's `end`). The row's CSS gives the name its words first and this slot what is left, up to the bell's 44 px,
 *   so nothing measured here can cut the name. The slot measures its own width (onLayout, as the phone's), and stays
 *   mounted on every tab. On the map the logo is drawn over that room: the slot stops 4 px short of it. Between 28 and
 *   44 px, a 28 px bell.
 * - The side bar (768 px and up): a row of its own above the connection status, the "?" and Settings. The header row still
 *   shows beside the side bar there (its md:hidden loses to its inline display), and its slot draws nothing.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
    BELL_EVENTS, BELL_PAGE_EVENT, bellBadge, bellClearWords, bellLabel, capitalFirst, createRefreshGate, inviteAskNeedsLine, isOwnInviteChange,
    isPushNoticeKind, NEEDS_YOU_PRIORITY, needsYouCounts, PUSH_NOTICE_KINDS, timeAgo, withoutBellNotices, type BellNotice, type NeedsYouKind,
} from '@beanpool/core';
import { t } from '@beanpool/core';
import type { NeedsItem, NeedsTarget } from '../lib/home-cards';
import { freshHomeForHeader, homeForHeader, onHomeRead, HOME_HEADER_WAIT_MS, forgetHomeForHeader } from '../lib/home-store';
import { onConversationRead } from '../lib/conversation-read';
import { onSyncActivity } from '../lib/sync';
import { useDialogFocus } from './dialog-focus';
import * as api from '../lib/api';

const NODE_MIN_GAP_MS = 15_000;
const SAFETY_POLL_MS = 120_000;
const WS_SETTLE_MS = 3_000;
/** On the map: the room kept between the logo's right edge and the bell. */
const LOGO_CLEAR_PX = 4;
/** The small bell, where the slot has room for it but not for the full one. */
const SMALL_BELL_PX = 28;
/** A notice kept: the list is read again this long after, so a burst is one read. */
const BELL_SETTLE_MS = 300;

/** Where a tap on a need lands in the web app. Parity with HomePage.tsx:1802-1820. */
export function goToWebNeedsTarget(target: NeedsTarget, onNavigate?: (tab: string, ctxId?: string, txId?: string) => void, kind?: NeedsItem['kind']): void {
    if (!onNavigate) return;
    switch (target.to) {
        // On the deal itself, not only its listing: a recurring listing's author lands on this one (deals S4).
        case 'deal': return onNavigate('marketplace', target.postId, target.txId);
        case 'my-deals': return onNavigate('marketplace');
        case 'decide': return onNavigate('projects');
        case 'chat': return onNavigate('messages', target.conversationId);
        case 'unread-messages': case 'your-groups': return onNavigate('messages');
        case 'enterprise': return onNavigate('enterprise', target.id);
        case 'group': return onNavigate('group', target.id);
        case 'invite': return onNavigate('group', target.id);
        case 'invites': return onNavigate('projects');
        // The line "N people asked to join" (not "N asked for an invite", which lands here too) is a notice: 'asked' tells Invites
        // so, and it says so if they are answered by now instead of showing nothing (WantsToJoin).
        case 'people': return kind === 'knock' ? onNavigate('people-invites', 'asked') : onNavigate('people-invites');
        default: return undefined;
    }
}

/**
 * Where a tap on a notice lands in the web app: parity with the phone's push tap (apps/native utils/push-notice-check.ts
 * noticeRoute). A post, a chat, an enterprise, a group or an invitation when the notice names one; else its kind's tab.
 */
export function goToNoticeTarget(kind: string, data: Record<string, unknown>, onNavigate?: (tab: string, ctxId?: string, txId?: string) => void): void {
    if (!onNavigate) return;
    const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);
    switch (data.screen) {
        case 'requests': return onNavigate('messages');
        case 'post': if (id(data.postId)) return onNavigate('marketplace', id(data.postId), id(data.txId)); break;
        case 'chat': if (id(data.conversationId)) return onNavigate('messages', id(data.conversationId)); break;
        case 'enterprise': if (id(data.publicKey)) return onNavigate('enterprise', id(data.publicKey)); break;
        case 'group': case 'invite': if (id(data.groupId)) return onNavigate('group', id(data.groupId)); break;
        case 'decide': return onNavigate('projects');
        case 'settings': return onNavigate('settings');
        default: break;
    }
    const tab = isPushNoticeKind(kind) ? PUSH_NOTICE_KINDS[kind].tab : 'home';
    // A request to join lands on Invites as a notice's visit, as the phone's `from=notice` and the "N people asked to join"
    // line: if every request is answered by now, Invites says so instead of showing nothing (WantsToJoin, #3003).
    if (kind === 'community.knock') return onNavigate('people-invites', 'asked');
    const web: Record<string, string> = { home: 'home', market: 'marketplace', chats: 'messages', settings: 'settings', people: 'people-invites' };
    return onNavigate(web[tab] ?? 'home');
}

/** The bell's size: 44 px matches tour-check and pill height. */
export const HEADER_ALERT_SLOT_PX = 44;

function BellSvg({ shadow = false, small = false }: { shadow?: boolean; small?: boolean }) {
    const size = small ? 'w-[18px] h-[18px]' : 'w-[22px] h-[22px]';
    return (
        <svg className={`${size} shrink-0${shadow ? ' drop-shadow-[0_1px_4px_rgba(0,0,0,0.75)]' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="bell">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
        </svg>
    );
}

/** `shadow`: on the header's photo, the phone's icon shadow (black at 75%, 1 px down, 4 px soft), so the icon reads on the vines. */
function NeedSvg({ kind, shadow = false }: { kind: NeedsYouKind; shadow?: boolean }) {
    const cls = `w-[20px] h-[20px] shrink-0${shadow ? ' drop-shadow-[0_1px_4px_rgba(0,0,0,0.75)]' : ''}`;
    switch (kind) {
        case 'invite':
            return (
                <svg className={cls} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="invite">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" />
                </svg>
            );
        case 'deal':
            return (
                <svg className={cls} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="deal">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m11 17 2 2a1 1 0 0 0 1.4 0l4.6-4.6a1 1 0 0 0 0-1.4l-2-2m-2-2-2-2a1 1 0 0 0-1.4 0L4 13.6a1 1 0 0 0 0 1.4l2 2m12-7 2.3-2.3a1 1 0 0 0 0-1.4l-2.6-2.6a1 1 0 0 0-1.4 0L12 8m1 7 2.3 2.3a1 1 0 0 0 1.4 0l2.6-2.6a1 1 0 0 0 0-1.4L17 11" />
                </svg>
            );
        case 'vote':
            return (
                <svg className={cls} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="vote">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2m-6 9 2 2 4-4" />
                </svg>
            );
        case 'message':
            return (
                <svg className={cls} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="message">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a.75.75 0 0 1-.974-.974 5.96 5.96 0 0 1 1.057-4.035C4.54 14.654 4 13.38 4 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
                </svg>
            );
        case 'group':
            return (
                <svg className={cls} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="group">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                </svg>
            );
        case 'ask':
            return (
                <svg className={cls} fill="none" viewBox="0 0 24 24" strokeWidth={1.75} stroke="currentColor" aria-hidden="true" data-kind="ask">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
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

/** A Home answer's needs, or null when there is no answer to go by. The node leaves the needs card out when nothing needs
 *  the member (home-answer.ts), so an answer whose cards have no needs is an empty list, as the phone reads it. */
function needsOf(ans: { cards?: { needs?: { items?: NeedsItem[] } } } | null | undefined): NeedsItem[] | null {
    if (!ans?.cards) return null;
    return ans.cards.needs?.items ?? [];
}

export function NeedsYouIcons({
    identityPubkey,
    onNavigate,
    activeTab,
    besideLogo = false,
    variant = 'header',
}: {
    identityPubkey?: string;
    onNavigate?: (tab: string, ctxId?: string, txId?: string) => void;
    activeTab?: string;
    /** The map's header row: its logo is drawn over the room, and the slot stops short of it. */
    besideLogo?: boolean;
    variant?: 'header' | 'sidebar';
}) {
    const [entries, setEntries] = useState<NeedsItem[]>([]);
    const [notices, setNotices] = useState<BellNotice[]>([]);
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
        const supported = items.filter(i => (i.kind as string) !== 'admin')
            .map(i => (i.kind === 'ask' ? { ...i, label: capitalFirst(inviteAskNeedsLine(i.count)) } : i));
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
            const items = needsOf(ans);
            if (items) {
                setEntries(filterAndSort(items));
            } else if (!onHome) {
                // The header's own read is the header's: never recorded as Home's answer (only Home's reads stand in).
                const read = await fetchNeedsDeduped();
                const readItems = read && !read.notModified ? needsOf(read.answer) : null;
                if (identityRef.current === pk && readItems) {
                    setEntries(filterAndSort(readItems));
                }
            }
        } catch {
            // Network errors keep whatever was drawn
        } finally {
            busyRef.current = false;
        }
    }, [filterAndSort, isHidden]);

    // The bell's list: read when the app opens, when a notice is kept or a chat is read, with the needs' own gated reads
    // (a reconnect's sync among them), on the way back to the tab, and on the safety poll. A read under way is the read;
    // never on the copy that is not on screen.
    const bellBusy = useRef(false);
    const refreshBell = useCallback(async () => {
        const pk = identityRef.current;
        if (!pk || bellBusy.current || isHidden()) return;
        bellBusy.current = true;
        try {
            const list = await api.getBellNotices();
            if (identityRef.current === pk) setNotices(list);
        } catch {
            // A node from before the bell answers 404, a dropped network nothing: keep what was drawn
        } finally {
            bellBusy.current = false;
        }
    }, [isHidden]);

    useEffect(() => {
        if (!identityPubkey) {
            setNotices([]);
            return;
        }
        // The first read is the gate's first (below), with the needs'.
        let settle: ReturnType<typeof setTimeout> | null = null;
        const onBell = (e: Event) => {
            const event = (e as CustomEvent<{ type?: unknown; ids?: unknown }>).detail ?? {};
            if (event.type === BELL_EVENTS.seen && Array.isArray(event.ids)) {
                setNotices(list => withoutBellNotices(list, event.ids as unknown[]));
                return;
            }
            if (settle) clearTimeout(settle);
            settle = setTimeout(refreshBell, BELL_SETTLE_MS);
        };
        if (typeof window !== 'undefined') window.addEventListener(BELL_PAGE_EVENT, onBell);
        const unsubRead = onConversationRead(() => { refreshBell(); });
        const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
        const poll = setInterval(() => { if (visible()) refreshBell(); }, SAFETY_POLL_MS);
        const onBack = () => { if (visible()) refreshBell(); };
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onBack);
        const wide = typeof window !== 'undefined' ? window.matchMedia?.('(min-width: 768px)') : undefined;
        wide?.addEventListener?.('change', onBack);
        return () => {
            if (settle) clearTimeout(settle);
            if (typeof window !== 'undefined') window.removeEventListener(BELL_PAGE_EVENT, onBell);
            unsubRead();
            clearInterval(poll);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onBack);
            wide?.removeEventListener?.('change', onBack);
        };
    }, [identityPubkey, refreshBell]);

    // Load initial data and subscribe to Home reads and refresh gate
    useEffect(() => {
        if (!identityPubkey) {
            setEntries([]);
            return;
        }

        // Draw initial data if already fresh in store
        const fresh = freshHomeForHeader(identityPubkey);
        const freshItems = needsOf(fresh);
        if (freshItems) {
            setEntries(filterAndSort(freshItems));
        }

        const g = createRefreshGate(NODE_MIN_GAP_MS, () => {
            refresh();
            refreshBell();
        });
        gate.current = g;

        // Initial poke
        g.request();

        // Listen for future Home reads settling
        const unsubscribe = onHomeRead((ans, pk) => {
            const readItems = needsOf(ans);
            if (pk === identityPubkey && readItems) {
                setEntries(filterAndSort(readItems));
            }
        });

        return () => {
            g.cancel();
            if (gate.current === g) gate.current = null;
            unsubscribe();
        };
    }, [identityPubkey, filterAndSort, refresh, refreshBell]);

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

        // `chats`: a run asked for only by new listings by someone else leaves this out (lib/sync-coordinator SyncScope). Nothing
        // in "your groups" or this row changes with one, and Home's own read of it is what the row draws from while fresh.
        const unsubSync = onSyncActivity((data?: unknown) => {
            if (isOwnInviteChange(data, identityPubkey)) {
                forgetHomeForHeader();
            }
            if (settleTimer) clearTimeout(settleTimer);
            settleTimer = setTimeout(poke, WS_SETTLE_MS);
        }, { chats: true });

        const unsubRead = onConversationRead(() => {
            forgetHomeForHeader();
            poke();
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
            unsubRead();
            if (settleTimer) clearTimeout(settleTimer);
        };
    }, [identityPubkey]);

    // The slot's own width as the row lays it out (the phone's onLayout), again whenever it changes: a tab's name, the
    // needs, the window, the text size. Its width is the row's CSS, never what is drawn in it, so this can't loop. After
    // the first, only the observer measures: it reports the width each frame settles on, where a measure in a layout
    // effect can catch the row half-way (a tab change lays the new name beside the chip's words just before the chip
    // goes to its dot) and keep it, with the observer never seeing a change to report.
    useLayoutEffect(() => {
        if (!slot || typeof ResizeObserver === 'undefined') return;
        const measure = () => setSlotWidth(slot.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(slot);
        return () => observer.disconnect();
    }, [slot]);

    // On the map: the logo, centred on the header, is drawn over the room, and the slot reaches no further left than 4 px
    // short of its right edge: the bean, the word and the version under its end, which hangs past the logo's own box
    // (12 px at 100% text, 19 at 130%). Both are where the row puts them whatever the slot draws.
    useLayoutEffect(() => {
        const room = slot?.parentElement;
        const logo = besideLogo ? slot?.closest('header')?.querySelector<HTMLElement>('[data-testid="header-logo"]') : null;
        if (!room || !logo) {
            setLogoRoom(undefined);
            return;
        }
        // The logo's mark (its first child; the second is the community's status, which opens below the row).
        const parts = [logo, ...Array.from(logo.firstElementChild?.children ?? [])];
        const measure = () => {
            const r = room.getBoundingClientRect();
            if (!r.width) return; // hidden (the md: layout)
            const logoRight = Math.max(...parts.map(p => p.getBoundingClientRect().right));
            setLogoRoom(Math.max(0, Math.floor(r.right - logoRight - LOGO_CLEAR_PX)));
        };
        measure();
        let observer: ResizeObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measure);
            observer.observe(room);
            for (const p of parts) observer.observe(p);
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

    if (!identityPubkey) return null;

    const isSidebar = variant === 'sidebar';
    // A tap on a need: that need is about to change, so Home's copy of it no longer stands in.
    const go = (target: NeedsTarget, kind?: NeedsItem['kind']) => {
        forgetHomeForHeader();
        goToWebNeedsTarget(target, onNavigate, kind);
    };
    // A tap on a notice: off the bell at once (and on the node, which tells the member's other apps), then to its thing.
    const openNotice = (n: BellNotice) => {
        setNotices(list => withoutBellNotices(list, [n.id]));
        api.markBellNoticesSeen([n.id]).catch(() => { refreshBell(); });
        goToNoticeTarget(n.kind, n.data, onNavigate);
    };
    // A notice's ✕: the same mark, and it opens nothing. A failed mark reads the list again, so the row comes back.
    const clearNotice = (n: BellNotice) => {
        setNotices(list => withoutBellNotices(list, [n.id]));
        api.markBellNoticesSeen([n.id]).catch(() => { refreshBell(); });
    };
    // "Clear all": every notice (never "Needs you": those are the `entries`, which leave when they are done), in one request.
    const clearAll = () => {
        setNotices([]);
        api.clearAllBellNotices().catch(() => { refreshBell(); });
    };
    const unseen = notices.length;
    // The payee's line of a short standing deal is listed, not counted (core needsYouCounts).
    const counted = entries.filter(needsYouCounts).length;
    const label = bellLabel(unseen, counted);
    const bell = (small: boolean) => (
        <button
            type="button"
            onClick={() => setSheet(true)}
            aria-label={label}
            title={label}
            aria-haspopup="dialog"
            data-testid={isSidebar ? 'sidebar-bell' : 'header-bell'}
            data-unseen={unseen}
            className={`relative flex items-center justify-center p-0 border-0 bg-transparent cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill shrink-0 h-[44px] min-h-[44px] ${
                isSidebar
                    ? 'rounded-lg text-text-secondary hover:bg-nature-200/60 dark:hover:bg-nature-800/60'
                    : 'rounded-full focus-visible:ring-inset text-white hover:bg-white/15'
            }`}
            style={{ width: `${small ? SMALL_BELL_PX : HEADER_ALERT_SLOT_PX}px`, height: '44px' }}
        >
            <BellSvg shadow={!isSidebar} small={small} />
            {unseen > 0 ? (
                <span
                    data-testid="bell-count"
                    className={`absolute ${small ? 'top-1 right-0' : 'top-1.5 right-0.5'} min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-black flex items-center justify-center leading-none pointer-events-none bg-bp-danger-fill text-bp-danger-on`}
                >
                    {bellBadge(unseen)}
                </span>
            ) : counted > 0 ? (
                <span
                    data-testid="bell-dot"
                    className={`absolute top-2.5 ${small ? 'right-0' : 'right-2'} w-[9px] h-[9px] rounded-full pointer-events-none ${isSidebar ? 'bg-bp-gold-fill' : 'bg-amber-300'}`}
                />
            ) : null}
        </button>
    );
    const sheetEl = sheet && (
        <NeedsSheet
            entries={entries}
            notices={notices}
            onClose={() => setSheet(false)}
            onPick={go}
            onOpenNotice={openNotice}
            onClearNotice={clearNotice}
            onClearAll={clearAll}
        />
    );

    if (isSidebar) {
        return (
            <>
                <div data-testid="sidebar-needs-row" className="flex flex-wrap items-center justify-end">
                    {bell(false)}
                </div>
                {sheetEl}
            </>
        );
    }

    const room = slotWidth ?? Infinity;
    // Half a pixel either way: the row lays out in fractions (a 43.8 px slot has room for the 44 px bell's drawing).
    const drawn = room >= HEADER_ALERT_SLOT_PX - 0.5 ? bell(false) : room >= SMALL_BELL_PX - 0.5 ? bell(true) : null;

    return (
        <>
            {/* The slot: the bell's 44 px at most, shrinking to nothing before the title gives way (HeaderTitle), and on the
                map no further than the logo. 44 px tall for the target, 38 px in the row (as the pill's). From 768 px none:
                the side bar has the bell there (SidebarStatus), and the header row, though its md:hidden loses to its own
                inline display and it still shows beside the side bar, mustn't draw it a second time. */}
            <div
                ref={setSlot}
                data-needs-slot
                className="flex items-center justify-end md:hidden"
                style={{
                    flex: `0 1 ${HEADER_ALERT_SLOT_PX}px`,
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
    notices,
    onClose,
    onPick,
    onOpenNotice,
    onClearNotice,
    onClearAll,
}: {
    entries: NeedsItem[];
    notices: BellNotice[];
    onClose: () => void;
    onPick: (target: NeedsTarget, kind: NeedsItem['kind']) => void;
    onOpenNotice: (notice: BellNotice) => void;
    onClearNotice: (notice: BellNotice) => void;
    onClearAll: () => void;
}) {
    const dialogRef = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialogRef, onClose);
    const now = Date.now();
    const clearWords = bellClearWords();
    // A cleared row takes the button with it: keep the keyboard inside the sheet, on its title.
    const focusSheetTitle = () => { dialogRef.current?.querySelector<HTMLElement>('#needs-sheet-title')?.focus(); };

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
                className="w-full max-w-sm bg-bg-card rounded-2xl shadow-xl overflow-hidden border border-border-secondary p-3 animate-fade-in"
                onClick={e => e.stopPropagation()}
                data-testid="needs-sheet"
            >
                <div className="flex items-center justify-between pb-2 border-b border-border-secondary px-2">
                    <h2
                        id="needs-sheet-title"
                        tabIndex={-1}
                        className="text-xs font-bold uppercase tracking-wider text-text-secondary outline-none"
                    >
                        {t('Notifications')}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('Close')}
                        className="text-text-muted hover:text-text-primary min-w-[44px] min-h-[44px] w-11 h-11 flex items-center justify-center rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="py-1 max-h-[65vh] overflow-y-auto">
                    {entries.length > 0 && (
                        <div data-testid="needs-sheet-needs" className="pb-1 mb-1 border-b border-border-secondary">
                            <h3 className="px-2 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-text-muted">{t('Needs you')}</h3>
                            {entries.map((e) => (
                                <button
                                    key={e.kind}
                                    type="button"
                                    onClick={() => {
                                        onClose();
                                        onPick(e.target, e.kind);
                                    }}
                                    aria-label={e.label}
                                    data-testid={`header-needs-${e.kind}`}
                                    data-kind={e.kind}
                                    className="w-full flex items-center gap-3 py-2.5 px-2 rounded-lg hover:bg-bg-hover text-left transition-colors cursor-pointer min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill"
                                >
                                    <span className={e.accent ? 'text-bp-ink-warning' : 'text-text-secondary'}>
                                        <NeedSvg kind={e.kind} />
                                    </span>
                                    <span className={`flex-1 min-w-0 text-sm text-text-primary ${e.accent ? 'font-bold' : 'font-medium'} line-clamp-2`}>
                                        {e.label}
                                    </span>
                                    {e.count > 1 && (
                                        <span className="shrink-0 min-w-[20px] h-[20px] px-1 rounded-full text-[11px] font-black flex items-center justify-center leading-none bg-bp-gold-fill text-bp-gold-on">
                                            {e.count > 9 ? '9+' : e.count}
                                        </span>
                                    )}
                                    <svg className="w-4 h-4 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                                    </svg>
                                </button>
                            ))}
                        </div>
                    )}
                    {notices.length === 0 && entries.length === 0 && (
                        <p data-testid="needs-sheet-empty" className="px-2 py-4 text-sm text-text-secondary text-center">{t('Nothing new.')}</p>
                    )}
                    {notices.length > 0 && (
                        <div className="flex justify-end">
                            <button
                                type="button"
                                onClick={() => {
                                    onClearAll();
                                    focusSheetTitle();
                                }}
                                data-testid="bell-clear-all"
                                className="min-h-[44px] px-3 rounded-lg text-sm font-semibold text-bp-ink-accent hover:bg-bg-hover transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill"
                            >
                                {clearWords.all}
                            </button>
                        </div>
                    )}
                    {notices.map((n) => (
                        <div key={n.id} data-testid="bell-notice-row" className="flex items-start gap-1">
                            <button
                                type="button"
                                onClick={() => {
                                    onClose();
                                    onOpenNotice(n);
                                }}
                                data-testid="bell-notice"
                                data-notice-id={n.id}
                                className="flex-1 min-w-0 flex items-start gap-3 py-2.5 px-2 rounded-lg hover:bg-bg-hover text-left transition-colors cursor-pointer min-h-[48px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill"
                            >
                                <span className="mt-1.5 w-2 h-2 rounded-full shrink-0 bg-bp-danger-fill" aria-hidden="true" />
                                <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-bold text-text-primary line-clamp-2 break-words">{n.title || n.body}</span>
                                    {n.title && n.body && <span className="block text-sm text-text-primary line-clamp-3 break-words">{n.body}</span>}
                                    <span className="block text-xs text-text-secondary">{timeAgo(Math.max(0, now - n.sentAt * 1000))}</span>
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    onClearNotice(n);
                                    focusSheetTitle();
                                }}
                                aria-label={clearWords.one}
                                title={clearWords.one}
                                data-testid="bell-notice-clear"
                                data-notice-id={n.id}
                                className="shrink-0 w-11 h-11 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-hover cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-gold-fill"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    ))}
                    <p data-testid="needs-sheet-lifetime" className="px-2 pt-2 pb-1 text-xs text-text-muted text-center">{t('Older notices are gone after 7 days.')}</p>
                </div>
            </div>
        </div>
    );
}
