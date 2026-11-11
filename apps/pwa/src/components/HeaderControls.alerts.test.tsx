import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import * as sync from '../lib/sync';
import { HeaderControls, HeaderTitle } from './HeaderControls';
import { goToNoticeTarget, NeedsYouIcons } from './NeedsYouIcons';
import { BELL_PAGE_EVENT, type BellNotice } from '@beanpool/core';
import { HomePage } from '../pages/HomePage';
import type { NeedsItem } from '../lib/home-cards';
import { freshHomeForHeader, recordHomeAnswer, resetHomeStoreForTests } from '../lib/home-store';

beforeEach(() => {
    resetHomeStoreForTests();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetHomeStoreForTests();
});

const ME = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Zara', createdAt: '2026-01-01T00:00:00.000Z' };

const makeHomeAnswer = (items: NeedsItem[] = []) => ({
    generatedAt: new Date().toISOString(),
    profile: 'local',
    features: { beans: true, decisions: true, invites: true },
    me: {
        joinedAt: '2026-01-01T00:00:00.000Z',
        isKeeper: false,
        probation: null,
        interests: [],
        area: null,
        firstOffer: true,
        standing: 'member' as const,
    },
    layout: { v: 2 as const, cards: [{ id: 'c1', type: 'community' }], dismissed: {}, updatedAt: null },
    cards: {
        community: { name: 'Mullumbimby', members: 42 },
        needs: { items },
    },
});

/**
 * App's mobile header row as MobileHeader (AppHeader.tsx) composes it: the tab's name with the bell beside it
 * (HeaderTitle's `end`), the map's logo where there is no name (`title` null), then the pill.
 */
function HeaderRow({ title = 'Commons', activeTab, onNavigate, className }: {
    title?: string | null;
    activeTab?: string;
    onNavigate?: (tab: string, ctxId?: string) => void;
    className?: string;
}) {
    return (
        <header className={className}>
            <HeaderTitle
                title={title}
                end={<NeedsYouIcons identityPubkey={ME.publicKey} onNavigate={onNavigate} activeTab={activeTab} besideLogo={title === null} />}
            />
            {title === null && <div data-testid="header-logo" className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center z-10" />}
            <HeaderControls showSettings={false} setShowSettings={() => {}} identityPubkey={ME.publicKey} onOpenProfile={() => {}} />
        </header>
    );
}

/**
 * The row as Chromium lays it out, for jsdom (which lays nothing out): the needs slot is as wide as the row's CSS makes it,
 * here `layout.slot` px (no wider than its own max-width, which the map's logo sets), the row's middle ends at
 * `layout.middleRight` and the map's logo at `layout.logoRight`. ResizeObserver tells every observer at once, as after a
 * layout; `relayout()` does it again after the test changes `layout`.
 */
function stubRowLayout(layout: { slot: number; middleRight?: number; logoRight?: number }) {
    const observers = new Set<{ cb: ResizeObserverCallback; targets: Set<Element> }>();
    vi.stubGlobal('ResizeObserver', class {
        private entry: { cb: ResizeObserverCallback; targets: Set<Element> };
        constructor(cb: ResizeObserverCallback) { this.entry = { cb, targets: new Set() }; observers.add(this.entry); }
        observe(target: Element) {
            this.entry.targets.add(target);
            this.entry.cb([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve(target: Element) { this.entry.targets.delete(target); }
        disconnect() { observers.delete(this.entry); }
    });
    const box = (left: number, right: number) => ({ width: right - left, height: 44, top: 0, left, right, bottom: 44, x: left, y: 0, toJSON() {} }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        const el = this as HTMLElement;
        const middleRight = layout.middleRight ?? 300;
        if (el.dataset.needsSlot !== undefined) {
            const cap = el.style.maxWidth ? parseFloat(el.style.maxWidth) : Infinity;
            const width = Math.min(layout.slot, cap);
            return box(middleRight - width, middleRight);
        }
        if (el.dataset.headerMiddle !== undefined) return box(0, middleRight);
        if (el.dataset.testid === 'header-logo') return box(0, layout.logoRight ?? 0);
        return box(0, 0);
    });
    return () => act(() => {
        for (const o of [...observers]) {
            const entries = [...o.targets].map(target => ({ target, contentRect: target.getBoundingClientRect() })) as unknown as ResizeObserverEntry[];
            if (entries.length) o.cb(entries, {} as ResizeObserver);
        }
    });
}

const INVITE: NeedsItem = { kind: 'invite', count: 1, accent: false, label: "You're invited to join Garden Club", target: { to: 'invite', id: 'group-garden' } };
const DEAL: NeedsItem = { kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you', target: { to: 'deal', postId: 'p1', txId: 't1' } };
const VOTE: NeedsItem = { kind: 'vote', count: 1, accent: true, label: 'Vote closes tomorrow', target: { to: 'decide' } };
const MESSAGE: NeedsItem = { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat', conversationId: 'dm-ana' } };
const GROUP: NeedsItem = { kind: 'group', count: 3, accent: false, label: '3 new lines in Choir', target: { to: 'chat', conversationId: 'grp-choir' } };

const notice = (id: string, over: Partial<BellNotice> = {}): BellNotice => ({
    id, kind: 'chat.message', title: '💬 New Message', body: 'Maya sent you a message',
    data: { screen: 'chat', conversationId: 'dm-maya' }, sentAt: Math.floor(Date.now() / 1000) - 120, seenAt: null, ...over,
});

/** The bell's socket events, as lib/sync hands them to the page (the server's push_notice and push_notices_seen). */
function catchBellEvents() {
    return (event: { type: string; id?: unknown; kind?: unknown; ids?: unknown }) =>
        act(() => { window.dispatchEvent(new CustomEvent(BELL_PAGE_EVENT, { detail: event })); });
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });
const bellButton = () => screen.getByTestId('header-bell');
const openSheet = () => { fireEvent.click(bellButton()); return screen.getByRole('dialog'); };

describe('The bell takes the needs-you row: what needs you sits at the top of its sheet', () => {
    beforeEach(() => {
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([]);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('an invite → the bell shows a dot, its sheet names the invitation, and a tap opens it', async () => {
        const onNavigate = vi.fn();
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-1"', answer: makeHomeAnswer([INVITE]) as any });
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();

        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
        expect(screen.queryByTestId('bell-count')).toBeNull();
        expect(bellButton()).toHaveAccessibleName('Notifications: 1 thing needs you');
        // No icon of its own in the header: the bell is the one control there.
        expect(within(screen.getByTestId('header-needs-icons')).getAllByRole('button')).toHaveLength(1);

        const sheet = openSheet();
        const line = within(sheet).getByRole('button', { name: "You're invited to join Garden Club" });
        expect(line.querySelector('[data-kind="invite"]')).toBeTruthy();
        fireEvent.click(line);
        expect(onNavigate).toHaveBeenCalledWith('group', 'group-garden');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('nothing pending and nothing new → a plain bell, and its sheet says so and how long notices keep', async () => {
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-empty"', answer: makeHomeAnswer([]) as any });
        render(<HeaderRow />);
        await settle();

        expect(bellButton()).toHaveAccessibleName('Notifications');
        expect(screen.queryByTestId('bell-count')).toBeNull();
        expect(screen.queryByTestId('bell-dot')).toBeNull();
        const sheet = openSheet();
        expect(within(sheet).getByTestId('needs-sheet-empty')).toHaveTextContent('Nothing new.');
        expect(within(sheet).getByTestId('needs-sheet-lifetime')).toHaveTextContent('Older notices are gone after 7 days.');
        expect(within(sheet).queryByRole('button', { name: /invited|deal|vote|unread|new lines/i })).toBeNull();
    });

    it('every kind of need → a line of the sheet, in priority order, each opening its place', async () => {
        const onNavigate = vi.fn();
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-all"', answer: makeHomeAnswer([MESSAGE, GROUP, VOTE, DEAL]) as any });
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();

        const lines = () => within(openSheet()).getAllByRole('button').filter(b => b.dataset.kind);
        expect(lines().map(b => b.dataset.kind)).toEqual(['deal', 'vote', 'message', 'group']);
        const routes: Array<[string, unknown[]]> = [
            ['A deal is waiting for you', ['marketplace', 'p1', 't1']], ['Vote closes tomorrow', ['projects']],
            ['Unread message from Ana', ['messages', 'dm-ana']], ['3 new lines in Choir', ['messages', 'grp-choir']],
        ];
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        for (const [name, args] of routes) {
            fireEvent.click(within(openSheet()).getByRole('button', { name }));
            expect(onNavigate).toHaveBeenLastCalledWith(...args);
        }
    });

    it('"N people asked to join" in the sheet opens Invites as a notice\'s visit; "N asked for an invite" as an ordinary one (#3003)', async () => {
        const onNavigate = vi.fn();
        const KNOCK: NeedsItem = { kind: 'knock', count: 2, accent: true, label: '2 people asked to join', target: { to: 'people' } };
        const ASK: NeedsItem = { kind: 'ask', count: 1, accent: true, label: '1 person asked for an invite', target: { to: 'people' } };
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-people"', answer: makeHomeAnswer([KNOCK, ASK]) as any });
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();

        const line = (kind: string) => within(openSheet()).getAllByRole('button').find(b => b.dataset.kind === kind)!;
        fireEvent.click(line('knock'));
        expect(onNavigate).toHaveBeenLastCalledWith('people-invites', 'asked');
        fireEvent.click(line('ask'));
        expect(onNavigate).toHaveBeenLastCalledWith('people-invites');
    });

    it('one home fetch shared with Home', async () => {
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-shared"', answer: makeHomeAnswer([INVITE]) as any });
        render(
            <div>
                <HeaderRow title="Home" activeTab="home" />
                <HomePage identity={ME} onNavigate={() => {}} />
            </div>
        );
        await screen.findByTestId('home-card-community');
        await settle();
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
        expect(within(openSheet()).getByRole('button', { name: "You're invited to join Garden Club" })).toBeInTheDocument();
        expect(getHomeSpy).toHaveBeenCalledTimes(1);
    });

    it('a slot under 44 px draws the small bell; under 28 px, on the map at 320 px where the logo meets the pill, none', async () => {
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-map"', answer: makeHomeAnswer([INVITE]) as any });
        const relayout = stubRowLayout({ slot: 36 });
        const { unmount } = render(<HeaderRow />);
        await settle();
        relayout();
        expect(bellButton().style.width).toBe('28px');
        unmount();

        const relayoutMap = stubRowLayout({ slot: 88, middleRight: 208, logoRight: 247 });
        render(<HeaderRow title={null} activeTab="map" />);
        const pill = screen.getByTestId('header-pill');
        expect(pill.className).toContain('z-[5]');
        expect(pill.className).not.toContain('z-10');
        await settle();
        relayoutMap();
        expect(document.querySelector<HTMLElement>('[data-needs-slot]')!.style.maxWidth).toBe('0px');
        expect(screen.queryByTestId('header-bell')).toBeNull();
    });

    it('away from Home: refreshes on activeTab changes and sync activity, clearing dealt-with needs', async () => {
        vi.useFakeTimers();
        let syncListener: ((data?: unknown) => void) | null = null;
        vi.spyOn(sync, 'onSyncActivity').mockImplementation((cb) => {
            syncListener = cb as (data?: unknown) => void;
            return () => { syncListener = null; };
        });
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-1"', answer: makeHomeAnswer([INVITE]) as any });
        const { rerender } = render(<HeaderRow title="Chat" activeTab="messages" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
        expect(getHomeSpy).toHaveBeenCalledTimes(1);

        getHomeSpy.mockResolvedValue({ notModified: false, etag: 'W/"home-empty"', answer: makeHomeAnswer([]) as any });
        act(() => { syncListener?.({ type: 'group_member_updated', member: { memberPubkey: ME.publicKey } }); });
        await act(async () => {
            rerender(<HeaderRow title="Commons" activeTab="commons" />);
            vi.advanceTimersByTime(16_000);
        });
        expect(screen.queryByTestId('bell-dot')).toBeNull();
    });

    // Capacity rehearsal 7 Nov (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §8 fix 2): a new listing by
    // someone else changes nothing in "your groups" or the needs, so the run it asks for (lib/sync-coordinator SyncScope
    // 'listings') leaves this listener out; a group or a chat bell still runs it.
    it('listens to sync activity as a chats reader, so a run asked for only by new listings leaves it out', async () => {
        const options: Array<unknown> = [];
        vi.spyOn(sync, 'onSyncActivity').mockImplementation(((_cb: unknown, o?: unknown) => { options.push(o); return () => {}; }) as typeof sync.onSyncActivity);
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-1"', answer: makeHomeAnswer([]) as any });
        render(<HeaderRow title="Chat" activeTab="messages" />);
        await act(async () => { await Promise.resolve(); });
        expect(options.length).toBeGreaterThan(0);
        for (const o of options) expect(o).toEqual({ chats: true });
    });

    it('wide screens: the bell in the side bar with rounded-lg styling, and the hidden header sends no duplicate read', async () => {
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-wide"', answer: makeHomeAnswer([INVITE]) as any });
        const getBell = vi.mocked(api.getBellNotices);
        const originalWidth = window.innerWidth;
        window.innerWidth = 1024;
        try {
            render(
                <div>
                    <div data-testid="sidebar-footer">
                        <NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" variant="sidebar" />
                    </div>
                    <HeaderRow className="md:hidden" title="Chat" activeTab="messages" />
                </div>
            );
            await settle();
            const sideBell = screen.getByTestId('sidebar-bell');
            expect(sideBell.className).toContain('rounded-lg');
            expect(within(sideBell).getByTestId('bell-dot')).toBeInTheDocument();
            expect(getHomeSpy).toHaveBeenCalledTimes(1);
            expect(getBell).toHaveBeenCalledTimes(1);
        } finally {
            window.innerWidth = originalWidth;
        }
    });

    it("away from Home, a tab change asks the node once Home's answer is older than the phone's 15 s: a need dealt with goes", async () => {
        vi.useFakeTimers();
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: null, answer: makeHomeAnswer([]) as any });
        recordHomeAnswer(makeHomeAnswer([DEAL, MESSAGE]) as any, ME.publicKey);
        const { rerender } = render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
        expect(getHomeSpy).not.toHaveBeenCalled();

        await act(async () => { vi.advanceTimersByTime(20_000); });
        await act(async () => {
            rerender(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="marketplace" />);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });
        expect(getHomeSpy).toHaveBeenCalledTimes(1);
        expect(getHomeSpy).toHaveBeenCalledWith({ cards: ['needs'] });
        expect(screen.queryByTestId('bell-dot')).toBeNull();
        expect(freshHomeForHeader(ME.publicKey)?.cards?.needs?.items.map(i => i.kind)).toEqual(['deal', 'message']);
    });

    // Deciding review on 65302617: when nothing needs the member the node leaves the needs card OUT (home-answer.ts).
    it('the node\'s answer with no needs card (nothing needs you) clears the last need, away from Home', async () => {
        vi.useFakeTimers();
        const none = makeHomeAnswer([]) as any;
        delete none.cards.needs;
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: null, answer: none });
        recordHomeAnswer(makeHomeAnswer([DEAL]) as any, ME.publicKey);
        const { rerender } = render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" />);
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();

        await act(async () => { vi.advanceTimersByTime(20_000); });
        await act(async () => {
            rerender(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="marketplace" />);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });
        expect(getHomeSpy).toHaveBeenCalledTimes(1);
        expect(screen.queryByTestId('bell-dot')).toBeNull();
    });

    it("a tap on a line of the sheet forgets Home's copy: that need is about to change", async () => {
        const onNavigate = vi.fn();
        recordHomeAnswer(makeHomeAnswer([DEAL, VOTE, MESSAGE]) as any, ME.publicKey);
        render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" onNavigate={onNavigate} />);
        await settle();
        fireEvent.click(within(openSheet()).getByRole('button', { name: 'Vote closes tomorrow' }));
        expect(onNavigate).toHaveBeenCalledWith('projects');
        expect(freshHomeForHeader(ME.publicKey)).toBeNull();
    });
});

/**
 * W0's own checks (DESIGN-web-notifications-fable.md §3): the count is the notices not yet opened; a row's tap opens its
 * thing and marks it; opening the chat marks its rows (the node does, and tells the sockets); opening the sheet marks
 * nothing. Damo: "once it's clicked (and only once it's clicked) should it disappear".
 */
describe('The bell: what happened, until it is opened', () => {
    beforeEach(() => {
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-0"', answer: makeHomeAnswer([]) as any });
    });

    it('the count is the notices not yet opened, never more than 99+', async () => {
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2'), notice('n3')]);
        const { unmount } = render(<HeaderRow />);
        await settle();
        expect(screen.getByTestId('bell-count')).toHaveTextContent('3');
        expect(bellButton()).toHaveAccessibleName('Notifications: 3 new');
        expect(screen.getByTestId('bell-count').className).toContain('bg-bp-danger-fill');
        unmount();

        vi.mocked(api.getBellNotices).mockResolvedValue(Array.from({ length: 100 }, (_, i) => notice(`m${i}`)));
        render(<HeaderRow />);
        await settle();
        expect(screen.getByTestId('bell-count')).toHaveTextContent('99+');
    });

    it('opening the sheet marks nothing: the rows and the count stay, with their real words', async () => {
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2', { kind: 'market.request', title: '🤝 Request', body: 'Ben asked for your jam', data: { screen: 'post', postId: 'p-jam' } })]);
        const mark = vi.spyOn(api, 'markBellNoticesSeen').mockResolvedValue(1);
        render(<HeaderRow />);
        await settle();
        const sheet = openSheet();
        const rows = within(sheet).getAllByTestId('bell-notice');
        expect(rows.map(r => r.dataset.noticeId)).toEqual(['n1', 'n2']);
        expect(rows[0]).toHaveTextContent('Maya sent you a message');
        expect(rows[0]).toHaveTextContent('2 minutes ago');
        expect(rows[1]).toHaveTextContent('Ben asked for your jam');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
        await settle();
        expect(mark).not.toHaveBeenCalled();
        expect(screen.getByTestId('bell-count')).toHaveTextContent('2');
    });

    it('a row tap opens its thing and marks it, and only it', async () => {
        const onNavigate = vi.fn();
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2', { data: { screen: 'post', postId: 'p-jam', txId: 'tx-9' }, kind: 'market.request' })]);
        const mark = vi.spyOn(api, 'markBellNoticesSeen').mockResolvedValue(1);
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();
        fireEvent.click(within(openSheet()).getAllByTestId('bell-notice')[0]);
        expect(onNavigate).toHaveBeenCalledWith('messages', 'dm-maya');
        expect(mark).toHaveBeenCalledWith(['n1']);
        expect(screen.getByTestId('bell-count')).toHaveTextContent('1');
        fireEvent.click(within(openSheet()).getAllByTestId('bell-notice')[0]);
        expect(onNavigate).toHaveBeenLastCalledWith('marketplace', 'p-jam', 'tx-9');
        expect(mark).toHaveBeenLastCalledWith(['n2']);
        expect(screen.queryByTestId('bell-count')).toBeNull();
    });

    it("a row's ✕ clears it without opening it: off the list and the count, marked on the node, the sheet stays open", async () => {
        const onNavigate = vi.fn();
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2', { title: '🤝 Request', body: 'Ben asked for your jam' })]);
        const mark = vi.spyOn(api, 'markBellNoticesSeen').mockResolvedValue(1);
        const clearAll = vi.spyOn(api, 'clearAllBellNotices').mockResolvedValue(2);
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();
        const sheet = openSheet();
        const x = within(sheet).getAllByRole('button', { name: 'Clear this notice' });
        expect(x).toHaveLength(2);
        // The touch floor: 44 px square, and a button of its own (a button inside a button is not valid).
        expect(x[0].className).toContain('min-w-[44px]');
        expect(x[0].className).toContain('min-h-[44px]');
        expect(x[0].closest('[data-testid="bell-notice"]')).toBeNull();
        fireEvent.click(x[1]);
        expect(mark).toHaveBeenCalledTimes(1);
        expect(mark).toHaveBeenCalledWith(['n2']);
        expect(clearAll).not.toHaveBeenCalled();
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(within(screen.getByRole('dialog')).getAllByTestId('bell-notice').map(r => r.dataset.noticeId)).toEqual(['n1']);
        expect(screen.getByTestId('bell-count')).toHaveTextContent('1');
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear this notice' }));
        expect(mark).toHaveBeenLastCalledWith(['n1']);
        expect(screen.queryByTestId('bell-count')).toBeNull();
        expect(within(screen.getByRole('dialog')).getByTestId('needs-sheet-empty')).toBeInTheDocument();
    });

    it('"Clear all" clears every notice in one request, and leaves "Needs you" alone', async () => {
        const onNavigate = vi.fn();
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-0"', answer: makeHomeAnswer([INVITE, DEAL]) as any });
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2'), notice('n3')]);
        const mark = vi.spyOn(api, 'markBellNoticesSeen').mockResolvedValue(1);
        const clearAll = vi.spyOn(api, 'clearAllBellNotices').mockResolvedValue(3);
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();
        expect(screen.getByTestId('bell-count')).toHaveTextContent('3');
        const sheet = openSheet();
        expect(within(sheet).getByTestId('needs-sheet-needs')).toBeInTheDocument();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Clear all' }));
        expect(clearAll).toHaveBeenCalledTimes(1);
        expect(mark).not.toHaveBeenCalled();
        expect(onNavigate).not.toHaveBeenCalled();
        // The three notices are gone, the count with them; the two open things are still there, and the bell is a dot again.
        const after = screen.getByRole('dialog');
        expect(within(after).queryAllByTestId('bell-notice')).toHaveLength(0);
        expect(within(after).queryByTestId('bell-clear-all')).toBeNull();
        expect(within(after).getByTestId('header-needs-invite')).toBeInTheDocument();
        expect(within(after).getByTestId('header-needs-deal')).toBeInTheDocument();
        expect(screen.queryByTestId('bell-count')).toBeNull();
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
    });

    // DESIGN-standing-deals-upfront-amend-fable §2, as the node's Home answer writes them (routes/home-answer.ts, U1).
    const PAYER_LINE: NeedsItem = { kind: 'deal', count: 1, accent: true, label: 'Vehicle Storage: 50 Beans 3 days overdue · until 24 Nov', target: { to: 'deal', postId: 'p-storage', txId: 'sd-m1' } };
    const PAYEE_LINE: NeedsItem = { kind: 'deal', count: 1, accent: false, label: "Marty's 50 Beans for Vehicle Storage: 3 days overdue · we try until 24 Nov · you can stop it now", target: { to: 'deal', postId: 'p-storage', txId: 'sd-m1' } };

    it("a short standing deal (U2): the payer's line is amber and counts; neither ✕ nor Clear all removes it; it opens the deal", async () => {
        const onNavigate = vi.fn();
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-sd"', answer: makeHomeAnswer([PAYER_LINE]) as any });
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2')]);
        vi.spyOn(api, 'markBellNoticesSeen').mockResolvedValue(1);
        vi.spyOn(api, 'clearAllBellNotices').mockResolvedValue(2);
        render(<HeaderRow onNavigate={onNavigate} />);
        await settle();
        const sheet = openSheet();
        const line = within(sheet).getByRole('button', { name: /Vehicle Storage: 50 Beans 3 days overdue · until 24 Nov/ });
        expect(line.querySelector('.text-bp-ink-warning')).toBeTruthy();
        // ✕ is on the notices only.
        expect(within(sheet).getAllByRole('button', { name: 'Clear this notice' })).toHaveLength(2);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Clear all' }));
        await settle();
        const after = screen.getByRole('dialog');
        expect(within(after).queryAllByTestId('bell-notice')).toHaveLength(0);
        expect(within(after).getByRole('button', { name: /Vehicle Storage: 50 Beans 3 days overdue/ })).toBeInTheDocument();
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
        fireEvent.click(within(after).getByRole('button', { name: /Vehicle Storage: 50 Beans 3 days overdue/ }));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'p-storage', 'sd-m1');
    });

    it("the payee's line is listed in the sheet, calm, and not counted: no dot for it alone (the step is the payer's)", async () => {
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-sd2"', answer: makeHomeAnswer([PAYEE_LINE]) as any });
        render(<HeaderRow />);
        await settle();
        expect(screen.queryByTestId('bell-dot')).toBeNull();
        const sheet = openSheet();
        const line = within(sheet).getByRole('button', { name: /Marty's 50 Beans for Vehicle Storage: 3 days overdue/ });
        expect(line.querySelector('.text-bp-ink-warning')).toBeNull();
        expect(line.textContent).not.toMatch(/short|balance/i);
    });

    it('no notices, no "Clear all": the sheet offers it only with something to clear', async () => {
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([]);
        vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: 'W/"home-0"', answer: makeHomeAnswer([INVITE]) as any });
        render(<HeaderRow />);
        await settle();
        const sheet = openSheet();
        expect(within(sheet).queryByRole('button', { name: 'Clear all' })).toBeNull();
        expect(within(sheet).getByTestId('header-needs-invite')).toBeInTheDocument();
    });

    it('a clear the node did not take: the list is read again and the rows come back', async () => {
        const getBell = vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2')]);
        vi.spyOn(api, 'clearAllBellNotices').mockRejectedValue(new Error('offline'));
        vi.spyOn(api, 'markBellNoticesSeen').mockRejectedValue(new Error('offline'));
        render(<HeaderRow />);
        await settle();
        fireEvent.click(within(openSheet()).getByRole('button', { name: 'Clear all' }));
        expect(screen.queryByTestId('bell-count')).toBeNull();
        const reads = getBell.mock.calls.length;
        await settle();
        expect(getBell.mock.calls.length).toBeGreaterThan(reads);
        expect(screen.getByTestId('bell-count')).toHaveTextContent('2');
        fireEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Clear this notice' })[0]);
        await settle();
        expect(screen.getByTestId('bell-count')).toHaveTextContent('2');
    });

    it('opening the chat marks its rows: the node tells the sockets which, and the count follows on every open app', async () => {
        const fire = catchBellEvents();
        vi.spyOn(api, 'getBellNotices').mockResolvedValue([notice('n1'), notice('n2', { data: { screen: 'chat', conversationId: 'dm-ben' } })]);
        render(<HeaderRow />);
        await settle();
        expect(screen.getByTestId('bell-count')).toHaveTextContent('2');
        fire({ type: 'push_notices_seen', ids: ['n1'] });
        expect(screen.getByTestId('bell-count')).toHaveTextContent('1');
        expect(within(openSheet()).getAllByTestId('bell-notice').map(r => r.dataset.noticeId)).toEqual(['n2']);
    });

    it('a notice kept for the member: the bell reads its list again and the count goes up', async () => {
        const fire = catchBellEvents();
        const getBell = vi.spyOn(api, 'getBellNotices').mockResolvedValue([]);
        render(<HeaderRow />);
        await settle();
        expect(screen.queryByTestId('bell-count')).toBeNull();
        getBell.mockResolvedValue([notice('n9')]);
        fire({ type: 'push_notice', id: 'n9', kind: 'chat.message' });
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });
        expect(screen.getByTestId('bell-count')).toHaveTextContent('1');
    });

    it('a node from before the bell (its read refused) leaves a plain bell, and the needs still show', async () => {
        vi.spyOn(api, 'getBellNotices').mockRejectedValue(new Error('404'));
        vi.mocked(api.getHome).mockResolvedValue({ notModified: false, etag: 'W/"h"', answer: makeHomeAnswer([INVITE]) as any });
        render(<HeaderRow />);
        await settle();
        expect(screen.queryByTestId('bell-count')).toBeNull();
        expect(screen.getByTestId('bell-dot')).toBeInTheDocument();
    });
});

describe('goToNoticeTarget: where a row lands, as the phone\'s push tap', () => {
    it('a chat, a post (with its deal), an enterprise, a group, an invitation, Decide, Settings; else its kind\'s tab', () => {
        const nav = vi.fn();
        const cases: Array<[string, Record<string, unknown>, unknown[]]> = [
            ['chat.message', { screen: 'chat', conversationId: 'c1' }, ['messages', 'c1']],
            ['market.request', { screen: 'post', postId: 'p1', txId: 't1' }, ['marketplace', 'p1', 't1']],
            ['market.request', { screen: 'post', postId: 'p1' }, ['marketplace', 'p1', undefined]],
            ['enterprise.vote', { screen: 'enterprise', publicKey: 'e'.repeat(64) }, ['enterprise', 'e'.repeat(64)]],
            ['group.vote', { screen: 'group', groupId: 'g1' }, ['group', 'g1']],
            ['group.invite', { screen: 'invite', groupId: 'g2' }, ['group', 'g2']],
            ['community.removal-vote', { screen: 'decide' }, ['projects']],
            ['account.recovery-started', { screen: 'settings' }, ['settings']],
            ['chat.message', { screen: 'requests' }, ['messages']],
            // A request to join: Invites as a notice's visit (the phone's from=notice, #3003); an answered invite-ask: Invites.
            ['community.knock', {}, ['people-invites', 'asked']],
            ['community.invite-ask', {}, ['people-invites']],
            ['market.request', {}, ['marketplace']],
            ['not.a.kind', {}, ['home']],
            ['chat.message', { screen: 'chat', conversationId: 42 }, ['messages']],
        ];
        for (const [kind, data, args] of cases) {
            nav.mockClear();
            goToNoticeTarget(kind, data, nav);
            expect(nav).toHaveBeenCalledWith(...args);
        }
    });
});
