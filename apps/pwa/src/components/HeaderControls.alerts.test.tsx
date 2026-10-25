import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as api from '../lib/api';
import { HeaderControls } from './HeaderControls';
import { HomePage } from '../pages/HomePage';
import type { NeedsItem } from '../lib/home-cards';
import { resetHomeStoreForTests } from '../lib/home-store';

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

describe('HeaderControls needs-you alert icons', () => {
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

        render(
            <HeaderControls
                showSettings={false}
                setShowSettings={() => {}}
                identityPubkey={ME.publicKey}
                onOpenProfile={() => {}}
                onNavigate={onNavigate}
            />
        );

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

        render(
            <HeaderControls
                showSettings={false}
                setShowSettings={() => {}}
                identityPubkey={ME.publicKey}
                onOpenProfile={() => {}}
            />
        );

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

        render(
            <HeaderControls
                showSettings={false}
                setShowSettings={() => {}}
                identityPubkey={ME.publicKey}
                onOpenProfile={() => {}}
                onNavigate={onNavigate}
            />
        );

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

        // Render Home page and HeaderControls on Home tab together
        render(
            <div>
                <HeaderControls
                    showSettings={false}
                    setShowSettings={() => {}}
                    identityPubkey={ME.publicKey}
                    onOpenProfile={() => {}}
                    activeTab="home"
                />
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

        // Provide header element with narrow width (400px -> maxSlotWidth = 80px -> holds 2 slots of 38px: 1 item + more)
        const header = document.createElement('header');
        document.body.appendChild(header);
        header.getBoundingClientRect = () => ({
            width: 400,
            height: 50,
            top: 0,
            left: 0,
            bottom: 50,
            right: 400,
            x: 0,
            y: 0,
            toJSON: () => {},
        });

        const originalRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            callback: ResizeObserverCallback;
            constructor(cb: ResizeObserverCallback) { this.callback = cb; }
            observe(target: Element) {
                this.callback([{ target, contentRect: { width: 400 } as any } as any], this as any);
            }
            unobserve() {}
            disconnect() {}
        } as any;

        try {
            render(
                <HeaderControls
                    showSettings={false}
                    setShowSettings={() => {}}
                    identityPubkey={ME.publicKey}
                    onOpenProfile={() => {}}
                    onNavigate={onNavigate}
                />,
                { container: header }
            );

            // With 80px room, 2 slots: highest priority (deal) + more (3 more things need you)
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
        } finally {
            globalThis.ResizeObserver = originalRO;
            if (header.parentNode) {
                document.body.removeChild(header);
            }
        }
    });

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

        let roCallback: ResizeObserverCallback | null = null;
        const observedElements: Element[] = [];
        const originalRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            constructor(cb: ResizeObserverCallback) { roCallback = cb; }
            observe(target: Element) { observedElements.push(target); }
            unobserve() {}
            disconnect() {}
        } as any;

        try {
            const header = document.createElement('header');
            document.body.appendChild(header);

            let headerWidth = 800;
            header.getBoundingClientRect = () => ({
                width: headerWidth,
                height: 50,
                top: 0,
                left: 0,
                bottom: 50,
                right: headerWidth,
                x: 0,
                y: 0,
                toJSON: () => {},
            });

            render(
                <HeaderControls
                    showSettings={false}
                    setShowSettings={() => {}}
                    identityPubkey={ME.publicKey}
                    onOpenProfile={() => {}}
                />,
                { container: header }
            );

            const iconsContainer = await screen.findByTestId('header-needs-icons');
            expect(iconsContainer).toBeInTheDocument();
            // Initially wide (800px) -> maxSlotWidth is undefined, all items show
            expect(iconsContainer.style.maxWidth).toBe('');
            expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
            expect(screen.getByTestId('header-needs-vote')).toBeInTheDocument();
            expect(screen.queryByTestId('header-needs-more')).toBeNull();

            // Resize header down to 320px
            headerWidth = 320;
            // Trigger ResizeObserver callback for header
            act(() => {
                roCallback?.([{ target: header, contentRect: { width: 320 } as any } as any], {} as any);
            });
            expect(iconsContainer.style.maxWidth).toBe('46px');
            expect(screen.getByTestId('header-needs-more')).toBeInTheDocument();
            expect(screen.queryByTestId('header-needs-deal')).toBeNull();
            expect(screen.queryByTestId('header-needs-vote')).toBeNull();

            // Resize back up to 800px via window resize event
            headerWidth = 800;
            act(() => {
                window.dispatchEvent(new Event('resize'));
            });
            expect(iconsContainer.style.maxWidth).toBe('');
            expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
            expect(screen.getByTestId('header-needs-vote')).toBeInTheDocument();
            expect(screen.queryByTestId('header-needs-more')).toBeNull();

            // Also verify ResizeObserver on header restores wide state without ratchet
            headerWidth = 320;
            act(() => {
                roCallback?.([{ target: header, contentRect: { width: 320 } as any } as any], {} as any);
            });
            expect(iconsContainer.style.maxWidth).toBe('46px');
            expect(screen.getByTestId('header-needs-more')).toBeInTheDocument();

            headerWidth = 800;
            act(() => {
                roCallback?.([{ target: header, contentRect: { width: 800 } as any } as any], {} as any);
            });
            expect(iconsContainer.style.maxWidth).toBe('');
            expect(screen.getByTestId('header-needs-deal')).toBeInTheDocument();
            expect(screen.getByTestId('header-needs-vote')).toBeInTheDocument();
            expect(screen.queryByTestId('header-needs-more')).toBeNull();

            document.body.removeChild(header);
        } finally {
            globalThis.ResizeObserver = originalRO;
        }
    });
});
