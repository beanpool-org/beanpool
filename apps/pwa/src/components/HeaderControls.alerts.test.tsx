import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

const ME = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64), callsign: 'Zara' };

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
        await new Promise(r => setTimeout(r, 50));

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

        // Mock ResizeObserver so the container gets a narrow width (80px -> holds 2 slots of 38px: 1 item + more)
        const originalRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
            callback: ResizeObserverCallback;
            constructor(cb: ResizeObserverCallback) { this.callback = cb; }
            observe(target: Element) {
                this.callback([{ target, contentRect: { width: 80 } as any } as any], this as any);
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
                />
            );

            // With 80px room, 2 slots: highest priority (deal) + more (3 more things need you)
            const dealBtn = await screen.findByRole('button', { name: 'A deal is waiting for you' });
            expect(dealBtn).toBeInTheDocument();

            const moreBtn = screen.getByRole('button', { name: '3 more things need you' });
            expect(moreBtn).toBeInTheDocument();

            // Clicking more opens the sheet
            fireEvent.click(moreBtn);
            expect(screen.getByTestId('needs-sheet')).toBeInTheDocument();
            expect(screen.getByText('Needs you')).toBeInTheDocument();

            // Clicking an item in the sheet navigates and closes sheet
            const sheetMsg = screen.getByRole('button', { name: 'Unread message from Ana' });
            fireEvent.click(sheetMsg);
            expect(onNavigate).toHaveBeenCalledWith('messages', 'dm-ana');
            expect(screen.queryByTestId('needs-sheet')).toBeNull();
        } finally {
            globalThis.ResizeObserver = originalRO;
        }
    });
});
