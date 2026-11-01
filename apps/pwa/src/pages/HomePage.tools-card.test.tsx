// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HomeAnswer, HomeLayoutV2 } from '../lib/home-cards';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getHome: vi.fn(),
    saveHomePreferences: vi.fn(async (_pk: string, prefs: Record<string, unknown>) => ({ success: true, ...prefs })),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 1 })),
    getCommunityMe: vi.fn(async () => ({ probation: null })),
}));

vi.mock('../components/AddressSearch', () => ({
    AddressSearch: () => null,
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
    onSocketOpen: vi.fn(() => () => {}),
    onSystemAnnouncement: vi.fn(() => () => {}),
}));

import * as api from '../lib/api';
import { HomePage } from './HomePage';
import { resetHomeCacheForTest } from '../lib/home-cache';
import { resetAccountEpochForTest } from '../lib/account-epoch';

const ME: BeanPoolIdentity = {
    publicKey: 'a'.repeat(64),
    privateKey: '00'.repeat(32),
    callsign: 'Ana',
    createdAt: '2026-01-01T00:00:00.000Z',
} as BeanPoolIdentity;

const NOW = new Date().toISOString();
const TOUR_ENDED = { v: 1 as const, state: 'skipped' as const, at: '2026-10-01T00:00:00.000Z' };

function makeAnswer(layout: HomeLayoutV2): HomeAnswer {
    return {
        generatedAt: NOW,
        profile: 'local',
        features: { beans: true },
        me: {
            joinedAt: '2026-01-01T00:00:00.000Z',
            isKeeper: false,
            probation: null,
            interests: [],
            area: null,
            firstOffer: false,
            standing: 'member',
            tour: TOUR_ENDED,
        },
        layout,
        cards: {
            needs: { items: [] },
            community: { name: 'Mullumbimby', members: 10, tradesThisMonth: 0 },
        },
    };
}

describe('Home: Your tools card (home-tools-card)', () => {
    beforeEach(() => {
        resetHomeCacheForTest();
        resetAccountEpochForTest();
        vi.stubGlobal('indexedDB', memoryIndexedDB());
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('the card is offered in Add a card, Add puts it on Home, a tool can be added and removed, a tap opens that tool, and an unknown tool id is skipped', async () => {
        const initialLayout: HomeLayoutV2 = {
            v: 2,
            cards: [
                { id: 'needs', type: 'needs' },
                { id: 'community', type: 'community' },
            ],
            dismissed: {},
            updatedAt: '2026-10-01T00:00:00.000Z',
        };

        const onNavigate = vi.fn();
        vi.mocked(api.getHome).mockResolvedValue({
            notModified: false,
            etag: 'W/"1"',
            answer: makeAnswer(initialLayout),
        });

        render(<HomePage identity={ME} onNavigate={onNavigate} />);

        await waitFor(() => {
            expect(screen.getByTestId('home-add-open')).toBeInTheDocument();
        });

        // 1. The card is offered in Add a card.
        fireEvent.click(screen.getByTestId('home-add-open'));
        expect(screen.getByTestId('home-add-row-tools')).toBeInTheDocument();
        expect(screen.getByText('Your tools')).toBeInTheDocument();
        expect(screen.getByText('A card you fill with the tools you use.')).toBeInTheDocument();

        // 2. Add puts it on Home.
        fireEvent.click(screen.getByTestId('home-add-tools'));
        await waitFor(() => {
            expect(screen.getByTestId('home-card-tools')).toBeInTheDocument();
        });

        // Empty state: invites member to add one.
        expect(screen.getByTestId('home-tools-empty')).toHaveTextContent('Add a tool to keep it here.');

        // "Add a tool" row lists tools not yet on the card.
        expect(screen.getByTestId('home-tools-add-row')).toBeInTheDocument();
        expect(screen.getByTestId('home-tools-add-things')).toBeInTheDocument();
        expect(screen.getByTestId('home-tools-add-garden')).toBeInTheDocument();

        // 3. A tool can be added and removed.
        // Add "Tool shed" (things).
        fireEvent.click(screen.getByTestId('home-tools-add-things'));
        await waitFor(() => {
            expect(screen.getByTestId('home-tool-row-things')).toBeInTheDocument();
        });
        expect(screen.getByText('Tool shed')).toBeInTheDocument();
        // Tool shed is now on card, so "Add a tool" row only lists remaining tools.
        expect(screen.queryByTestId('home-tools-add-things')).not.toBeInTheDocument();
        expect(screen.getByTestId('home-tools-add-garden')).toBeInTheDocument();

        // 4. A tap opens that tool.
        fireEvent.click(screen.getByTestId('home-tool-open-things'));
        expect(onNavigate).toHaveBeenCalledWith('tool', 'things');

        // Remove "Tool shed".
        fireEvent.click(screen.getByTestId('home-tool-remove-things'));
        await waitFor(() => {
            expect(screen.queryByTestId('home-tool-row-things')).not.toBeInTheDocument();
        });
        // Card is empty again.
        expect(screen.getByTestId('home-tools-empty')).toBeInTheDocument();
        expect(screen.getByTestId('home-tools-add-things')).toBeInTheDocument();
    });

    it('an unknown tool id in card settings is skipped without crashing', async () => {
        const layoutWithUnknownTool: HomeLayoutV2 = {
            v: 2,
            cards: [
                { id: 'needs', type: 'needs' },
                {
                    id: 'tools',
                    type: 'tools',
                    settings: { tools: ['mystery-tool-unknown', 'garden'] },
                },
                { id: 'community', type: 'community' },
            ],
            dismissed: {},
            updatedAt: '2026-10-01T00:00:00.000Z',
        };

        const onNavigate = vi.fn();
        vi.mocked(api.getHome).mockResolvedValue({
            notModified: false,
            etag: 'W/"2"',
            answer: makeAnswer(layoutWithUnknownTool),
        });

        render(<HomePage identity={ME} onNavigate={onNavigate} />);

        await waitFor(() => {
            expect(screen.getByTestId('home-card-tools')).toBeInTheDocument();
        });

        // The unknown tool id 'mystery-tool-unknown' is skipped.
        expect(screen.queryByTestId('home-tool-row-mystery-tool-unknown')).not.toBeInTheDocument();
        // Valid tool 'garden' is rendered.
        expect(screen.getByTestId('home-tool-row-garden')).toBeInTheDocument();
        expect(screen.getByText('Your garden')).toBeInTheDocument();
    });
});
