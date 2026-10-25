import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import * as sync from '../lib/sync';
import { HeaderControls, HeaderTitle } from './HeaderControls';
import { NeedsYouIcons } from './NeedsYouIcons';
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
 * App's mobile header row as MobileHeader (AppHeader.tsx) composes it: the tab's name with the needs-you icons beside it
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

describe('HeaderControls needs-you alert icons', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('an invite → the envelope shows with its accessible name and opens the invitation', async () => {
        const onNavigate = vi.fn();
        const inviteItem: NeedsItem = {
            kind: 'invite',
            count: 1,
            accent: false,
            label: "You're invited to join Garden Club",
            target: { to: 'invite', id: 'group-garden' },
        };

        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-1"',
            answer: makeHomeAnswer([inviteItem]) as any,
        });

        render(<HeaderRow onNavigate={onNavigate} />);

        const envelope = await screen.findByRole('button', { name: "You're invited to join Garden Club" });
        expect(envelope).toBeInTheDocument();
        expect(envelope.querySelector('[data-kind="invite"]') || envelope.getAttribute('data-kind')).toBeTruthy();

        fireEvent.click(envelope);
        expect(onNavigate).toHaveBeenCalledWith('group', 'group-garden');
    });

    it('nothing pending → no icons', async () => {
        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-empty"',
            answer: makeHomeAnswer([]) as any,
        });

        render(<HeaderRow />);

        // Allow any background loads to complete
        await act(async () => {
            await new Promise(r => setTimeout(r, 50));
        });

        // Only the standard 3 pill buttons should be present (profile, help, settings)
        expect(screen.queryByTestId('header-needs-icons')).toBeNull();
        expect(screen.queryByRole('button', { name: /invited|deal|vote|unread|new lines/i })).toBeNull();
    });

    it('each other icon you add → shows + routes', async () => {
        const onNavigate = vi.fn();
        const dealItem: NeedsItem = {
            kind: 'deal',
            count: 1,
            accent: true,
            label: 'A deal is waiting for you',
            target: { to: 'deal', postId: 'post-123', txId: 'tx-456' },
        };
        const voteItem: NeedsItem = {
            kind: 'vote',
            count: 1,
            accent: true,
            label: 'Vote closes tomorrow',
            target: { to: 'decide' },
        };
        const messageItem: NeedsItem = {
            kind: 'message',
            count: 1,
            accent: false,
            label: 'Unread message from Ana',
            target: { to: 'chat', conversationId: 'dm-ana' },
        };
        const groupItem: NeedsItem = {
            kind: 'group',
            count: 1,
            accent: false,
            label: '3 new lines in Choir',
            target: { to: 'chat', conversationId: 'grp-choir' },
        };

        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-all"',
            answer: makeHomeAnswer([dealItem, voteItem, messageItem, groupItem]) as any,
        });

        render(<HeaderRow onNavigate={onNavigate} />);

        // 1. Deal
        const dealBtn = await screen.findByRole('button', { name: 'A deal is waiting for you' });
        expect(dealBtn).toBeInTheDocument();
        fireEvent.click(dealBtn);
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'post-123');

        // 2. Vote
        const voteBtn = screen.getByRole('button', { name: 'Vote closes tomorrow' });
        expect(voteBtn).toBeInTheDocument();
        fireEvent.click(voteBtn);
        expect(onNavigate).toHaveBeenCalledWith('projects');

        // 3. Message
        const msgBtn = screen.getByRole('button', { name: 'Unread message from Ana' });
        expect(msgBtn).toBeInTheDocument();
        fireEvent.click(msgBtn);
        expect(onNavigate).toHaveBeenCalledWith('messages', 'dm-ana');

        // 4. Group
        const grpBtn = screen.getByRole('button', { name: '3 new lines in Choir' });
        expect(grpBtn).toBeInTheDocument();
        fireEvent.click(grpBtn);
        expect(onNavigate).toHaveBeenCalledWith('messages', 'grp-choir');
    });

    it('one home fetch shared with Home', async () => {
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-shared"',
            answer: makeHomeAnswer([{
                kind: 'invite',
                count: 1,
                accent: false,
                label: "You're invited to join Garden Club",
                target: { to: 'invite', id: 'group-garden' },
            }]) as any,
        });

        // Render Home page and the header row on Home tab together
        render(
            <div>
                <HeaderRow title="Home" activeTab="home" />
                <HomePage identity={ME} onNavigate={() => {}} />
            </div>
        );

        // Wait for Home page to load
        await screen.findByTestId('home-card-community');

        // Header controls alert icon shows the envelope!
        const headerIcons = await screen.findByTestId('header-needs-icons');
        const headerEnvelope = within(headerIcons).getByRole('button', { name: "You're invited to join Garden Club" });
        expect(headerEnvelope).toBeInTheDocument();

        // Exactly one getHome fetch was made, shared between Home and HeaderControls!
        expect(getHomeSpy).toHaveBeenCalledTimes(1);
    });

    it('collapses into ••• when width is narrow and opens Needs you sheet', async () => {
        const onNavigate = vi.fn();
        const dealItem: NeedsItem = {
            kind: 'deal',
            count: 1,
            accent: true,
            label: 'A deal is waiting for you',
            target: { to: 'deal', postId: 'post-1', txId: 'tx-1' },
        };
        const voteItem: NeedsItem = {
            kind: 'vote',
            count: 1,
            accent: true,
            label: 'Vote closes tomorrow',
            target: { to: 'decide' },
        };
        const msgItem: NeedsItem = {
            kind: 'message',
            count: 1,
            accent: false,
            label: 'Unread message from Ana',
            target: { to: 'chat', conversationId: 'dm-ana' },
        };
        const grpItem: NeedsItem = {
            kind: 'group',
            count: 1,
            accent: false,
            label: '2 new lines in Choir',
            target: { to: 'chat', conversationId: 'grp-choir' },
        };

        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-all"',
            answer: makeHomeAnswer([dealItem, voteItem, msgItem, grpItem]) as any,
        });

        // The row leaves the slot 88 px beside the title: two 44 px slots, one icon and •••.
        stubRowLayout({ slot: 88 });

        render(<HeaderRow onNavigate={onNavigate} />);

        // With 88px room, 2 slots: highest priority (deal) + more (3 more things need you)
        const dealBtn = await screen.findByRole('button', { name: 'A deal is waiting for you' });
        expect(dealBtn).toBeInTheDocument();

        const moreBtn = screen.getByRole('button', { name: '3 more things need you' });
        expect(moreBtn).toBeInTheDocument();
        // Tap targets floor: 44 px tall, matching pill and tour-check
        expect(moreBtn.className).toContain('h-[44px]');

        // Clicking more opens the dialog sheet (focusing opener first as real user click)
        moreBtn.focus();
        fireEvent.click(moreBtn);
        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'needs-sheet-title');

        // Escape closes the dialog and returns focus to opener
        fireEvent.keyDown(dialog, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(moreBtn);

        // Reopen to test item selection
        moreBtn.focus();
        fireEvent.click(moreBtn);
        expect(screen.getByRole('dialog')).toBeInTheDocument();

        // Clicking an item in the sheet navigates and closes sheet
        const sheetMsg = screen.getByRole('button', { name: 'Unread message from Ana' });
        fireEvent.click(sheetMsg);
        expect(onNavigate).toHaveBeenCalledWith('messages', 'dm-ana');
        expect(screen.queryByTestId('needs-sheet')).toBeNull();
    });

    // The slot measures its own width (the phone's onLayout) whenever the row lays it out again: a window resized or turned
    // is a new width for it, and the old header-width breakpoints (and their max-width strings) are gone.
    it('responds dynamically to header and window resize events', async () => {
        const dealItem: NeedsItem = {
            kind: 'deal',
            count: 1,
            accent: true,
            label: 'A deal is waiting for you',
            target: { to: 'deal', postId: 'post-1', txId: 'tx-1' },
        };
        const voteItem: NeedsItem = {
            kind: 'vote',
            count: 1,
            accent: true,
            label: 'Vote closes tomorrow',
            target: { to: 'decide' },
        };

        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-resize"',
            answer: makeHomeAnswer([dealItem, voteItem]) as any,
        });

        // Wide: the slot has its two 44 px slots.
        const layout = { slot: 88 };
        const relayout = stubRowLayout(layout);

        render(<HeaderRow />);

        const iconsContainer = await screen.findByTestId('header-needs-icons');
        expect(iconsContainer).toBeInTheDocument();
        // Initially wide: all items show
        expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
        expect(screen.getByTestId('header-needs-vote')).toBeInTheDocument();
        expect(screen.queryByTestId('header-needs-more')).toBeNull();

        // A narrow window (320 px): the row leaves the slot one slot
        layout.slot = 46;
        relayout();
        expect(screen.getByTestId('header-needs-more')).toBeInTheDocument();
        expect(screen.queryByTestId('header-needs-deal')).toBeNull();
        expect(screen.queryByTestId('header-needs-vote')).toBeNull();

        // Back up to a wide window
        layout.slot = 88;
        relayout();
        expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
        expect(screen.getByTestId('header-needs-vote')).toBeInTheDocument();
        expect(screen.queryByTestId('header-needs-more')).toBeNull();

        // And again, without a ratchet: what is drawn never narrows the slot
        layout.slot = 46;
        relayout();
        expect(screen.getByTestId('header-needs-more')).toBeInTheDocument();

        layout.slot = 88;
        relayout();
        expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
        expect(screen.getByTestId('header-needs-vote')).toBeInTheDocument();
        expect(screen.queryByTestId('header-needs-more')).toBeNull();
    });

    it('collapses to a single count chip if even ••• does not fit beside title', async () => {
        const inviteItem: NeedsItem = {
            kind: 'invite',
            count: 1,
            accent: false,
            label: "You're invited to join Garden Club",
            target: { to: 'invite', id: 'group-garden' },
        };
        const dealItem: NeedsItem = {
            kind: 'deal',
            count: 1,
            accent: true,
            label: 'A deal is waiting for you',
            target: { to: 'deal', postId: 'post-1', txId: 'tx-1' },
        };

        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-chip"',
            answer: makeHomeAnswer([dealItem, inviteItem]) as any,
        });

        // 320px header where "Commons" title leaves only 35px (< 44px)
        stubRowLayout({ slot: 35 });

        render(<HeaderRow />);

        // When room is < 44px, it must collapse to a single count chip, not cut title
        const chip = await screen.findByTestId('header-needs-chip');
        expect(chip).toBeInTheDocument();
        expect(screen.queryByTestId('header-needs-more')).toBeNull();
        expect(screen.queryByTestId('header-needs-deal')).toBeNull();

        // Clicking the count chip opens the dialog sheet
        chip.focus();
        fireEvent.click(chip);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('on Map tab: icons stay out of logo box, and HeaderControls has z-[5] below logo', async () => {
        const inviteItem: NeedsItem = {
            kind: 'invite',
            count: 1,
            accent: false,
            label: "You're invited to join Garden Club",
            target: { to: 'invite', id: 'group-garden' },
        };

        vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-map"',
            answer: makeHomeAnswer([inviteItem]) as any,
        });

        // At 320px, Map tab logo right edge is at 247px, pill left (the row's middle's right) is at 208px (overlap)
        stubRowLayout({ slot: 88, middleRight: 208, logoRight: 247 });

        render(<HeaderRow title={null} activeTab="map" />);

        // Layering: the pill (HeaderControls) must have z-[5] and NOT z-10, under the logo's z-10
        const pill = screen.getByTestId('header-pill');
        expect(pill.className).toContain('z-[5]');
        expect(pill.className).not.toContain('z-10');

        // At 320px on map tab, logo meets pill, so icons must be hidden (0 slots)
        await act(async () => {
            await new Promise(r => setTimeout(r, 60));
        });
        expect(screen.queryByTestId('header-needs-invite')).toBeNull();
        expect(screen.queryByTestId('header-needs-chip')).toBeNull();
    });

    it('away from Home: refreshes on activeTab changes and sync activity, clearing dealt-with needs', async () => {
        vi.useFakeTimers();
        try {
            let syncListener: ((data?: unknown) => void) | null = null;
            vi.spyOn(sync, 'onSyncActivity').mockImplementation((cb) => {
                syncListener = cb;
                return () => { syncListener = null; };
            });

            const inviteItem: NeedsItem = {
                kind: 'invite',
                count: 1,
                accent: false,
                label: "You're invited to join Garden Club",
                target: { to: 'invite', id: 'group-garden' },
            };

            const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({
                notModified: false,
                etag: 'W/"home-1"',
                answer: makeHomeAnswer([inviteItem]) as any,
            });

            const { rerender } = render(<HeaderRow title="Chat" activeTab="messages" />);

            // Wait for initial render and promise resolution
            await act(async () => {
                await Promise.resolve();
            });

            // Invite button shows initially away from Home
            const inviteBtn = screen.getByTestId('header-needs-invite');
            expect(inviteBtn).toBeInTheDocument();
            expect(getHomeSpy).toHaveBeenCalledTimes(1);

            // User accepted the invite or dealt with it, server now has empty needs
            getHomeSpy.mockResolvedValue({
                notModified: false,
                etag: 'W/"home-empty"',
                answer: makeHomeAnswer([]) as any,
            });

            // Simulating invite update event clears cache via forgetHomeForHeader
            act(() => {
                syncListener?.({
                    type: 'group_member_updated',
                    member: { memberPubkey: ME.publicKey },
                });
            });

            // Tab change (e.g. going to commons) triggers refresh via gate
            await act(async () => {
                rerender(<HeaderRow title="Commons" activeTab="commons" />);
                // Advance past NODE_MIN_GAP_MS
                vi.advanceTimersByTime(16_000);
            });

            // Needs are refreshed: invite is cleared
            expect(screen.queryByTestId('header-needs-invite')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('wide screens: shows icons in sidebar with rounded-lg styling, and hidden header sends no duplicate read', async () => {
        const inviteItem: NeedsItem = {
            kind: 'invite',
            count: 1,
            accent: false,
            label: "You're invited to join Garden Club",
            target: { to: 'invite', id: 'group-garden' },
        };

        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({
            notModified: false,
            etag: 'W/"home-wide"',
            answer: makeHomeAnswer([inviteItem]) as any,
        });

        const originalWidth = window.innerWidth;
        window.innerWidth = 1024;
        try {
            render(
                <div>
                    {/* Wide sidebar footer */}
                    <div data-testid="sidebar-footer">
                        <NeedsYouIcons
                            identityPubkey={ME.publicKey}
                            activeTab="messages"
                            variant="sidebar"
                        />
                    </div>
                    {/* Mobile header (md:hidden), with its own icons beside the title */}
                    <HeaderRow className="md:hidden" title="Chat" activeTab="messages" />
                </div>
            );

            // Wait for items to settle
            const sidebarEnvelope = await screen.findByTestId('header-needs-invite');
            expect(sidebarEnvelope).toBeInTheDocument();
            // Sidebar buttons have rounded-lg matching SidebarControls
            expect(sidebarEnvelope.className).toContain('rounded-lg');

            // Exactly ONE getHome read was sent across both components
            expect(getHomeSpy).toHaveBeenCalledTimes(1);
        } finally {
            window.innerWidth = originalWidth;
        }
    });
});

/**
 * Round 3 of the deciding review (6113c9ad): what the count chip says, and when a tab change away from Home asks the node.
 * The header's slot is measured as the phone's row is (onLayout): its own width, from a ResizeObserver; here that width is
 * given (jsdom lays nothing out).
 */
describe('NeedsYouIcons: the count chip and the refresh away from Home', () => {
    const DEAL: NeedsItem = { kind: 'deal', count: 1, accent: true, label: 'A deal is waiting for you', target: { to: 'deal', postId: 'p1', txId: 't1' } };
    const VOTE: NeedsItem = { kind: 'vote', count: 1, accent: true, label: 'Vote closes tomorrow', target: { to: 'decide' } };
    const MESSAGE: NeedsItem = { kind: 'message', count: 1, accent: false, label: 'Unread message from Ana', target: { to: 'chat', conversationId: 'dm-ana' } };
    const GROUP: NeedsItem = { kind: 'group', count: 3, accent: false, label: '3 new lines in Choir', target: { to: 'chat', conversationId: 'grp-choir' } };

    /** The slot is `width` px wide; every observer hears of it at once, as the browser's first layout does. */
    function slotWidth(width: number) {
        vi.stubGlobal('ResizeObserver', class {
            constructor(private cb: ResizeObserverCallback) {}
            observe(target: Element) { this.cb([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver); }
            unobserve() {}
            disconnect() {}
        });
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
            const w = (this as HTMLElement).dataset.needsSlot !== undefined ? width : 0;
            return { width: w, height: 44, top: 0, left: 0, right: w, bottom: 44, x: 0, y: 0, toJSON() {} } as DOMRect;
        });
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('the count chip, when it is all there is room for, says how many things need you: the number it draws', async () => {
        slotWidth(30);
        recordHomeAnswer(makeHomeAnswer([DEAL, VOTE, GROUP]) as any, ME.publicKey);
        render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" />);

        const chip = await screen.findByTestId('header-needs-chip');
        // Three kinds (the three lines of the sheet it opens), not the five the counts add up to, and not "3 more".
        expect(chip).toHaveAccessibleName('3 things need you');
        expect(chip.textContent).toBe('3');
        expect(screen.queryByTestId('header-needs-deal')).toBeNull();
    });

    it('a lone •••, with no icon beside it, says how many things need you, not how many more', async () => {
        slotWidth(44);
        recordHomeAnswer(makeHomeAnswer([DEAL, VOTE]) as any, ME.publicKey);
        render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" />);

        const more = await screen.findByTestId('header-needs-more');
        expect(more).toHaveAccessibleName('2 things need you');
    });

    it("away from Home, a tab change asks the node once Home's answer is older than the phone's 15 s: a need dealt with goes", async () => {
        vi.useFakeTimers();
        const getHomeSpy = vi.spyOn(api, 'getHome').mockResolvedValue({ notModified: false, etag: null, answer: makeHomeAnswer([]) as any });
        // Home's own read, as the member left Home with a deal and an unread message.
        recordHomeAnswer(makeHomeAnswer([DEAL, MESSAGE]) as any, ME.publicKey);

        const { rerender } = render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" />);
        await act(async () => { await Promise.resolve(); });
        // Home's answer is a moment old: drawn from, and nothing asked.
        expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
        expect(screen.getByTestId('header-needs-message')).toBeInTheDocument();
        expect(getHomeSpy).not.toHaveBeenCalled();

        // 20 s later, Market: the phone would have read its deals and messages again on this page change.
        await act(async () => { vi.advanceTimersByTime(20_000); });
        await act(async () => {
            rerender(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="marketplace" />);
            await Promise.resolve();
        });
        await act(async () => { await Promise.resolve(); });
        expect(getHomeSpy).toHaveBeenCalledTimes(1);
        expect(getHomeSpy).toHaveBeenCalledWith({ cards: ['needs'] });
        expect(screen.queryByTestId('header-needs-deal')).toBeNull();
        expect(screen.queryByTestId('header-needs-message')).toBeNull();

        // The header's own read is the header's: it never stands in for Home's answer, which is still Home's own (and
        // still under two minutes old, for Home).
        expect(freshHomeForHeader(ME.publicKey)?.cards?.needs?.items.map(i => i.kind)).toEqual(['deal', 'message']);
    });

    it("a tap on an icon or a line of the sheet forgets Home's copy: that need is about to change", async () => {
        slotWidth(88);
        const onNavigate = vi.fn();
        recordHomeAnswer(makeHomeAnswer([DEAL, VOTE, MESSAGE]) as any, ME.publicKey);
        render(<NeedsYouIcons identityPubkey={ME.publicKey} activeTab="messages" onNavigate={onNavigate} />);

        fireEvent.click(await screen.findByTestId('header-needs-deal'));
        expect(onNavigate).toHaveBeenCalledWith('marketplace', 'p1');
        expect(freshHomeForHeader(ME.publicKey)).toBeNull();

        recordHomeAnswer(makeHomeAnswer([DEAL, VOTE, MESSAGE]) as any, ME.publicKey);
        fireEvent.click(await screen.findByTestId('header-needs-more'));
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Vote closes tomorrow' }));
        expect(onNavigate).toHaveBeenCalledWith('projects');
        expect(freshHomeForHeader(ME.publicKey)).toBeNull();
    });
});
