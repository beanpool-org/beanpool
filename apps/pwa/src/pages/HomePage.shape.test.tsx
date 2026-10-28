/**
 * Tests for the community shape summary line and modal on HomePage (design §4, slice S5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HomeAnswer } from '../lib/home-cards';
import type { BeanPoolIdentity } from '../lib/identity';
import { memoryIndexedDB } from '../lib/memory-indexeddb';

vi.mock('../lib/api', () => ({
    getNodeApiUrl: vi.fn(() => ''),
    getHome: vi.fn(),
    saveHomePreferences: vi.fn(async () => ({ success: true })),
    markNoticesSeen: vi.fn(async () => ({ success: true, marked: 1 })),
    getCommunityMe: vi.fn(async () => ({ probation: null })),
    watchPlace: vi.fn(),
    getListedCommunityByHost: vi.fn(async () => null),
}));
vi.mock('../components/AddressSearch', () => ({
    AddressSearch: () => null,
}));
vi.mock('../components/StartCommunityScreen', () => ({
    StartCommunityScreen: () => null,
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

const HOME_ANSWER_WITH_SHAPE: HomeAnswer = {
    profile: 'local',
    order: ['community'],
    cards: {
        community: {
            type: 'community',
            id: 'community',
            members: 12,
            joined7d: 3,
            tradesThisMonth: 10,
            commonsPot: 1500,
            listings: 5,
            eventsSoon: 1,
        },
    },
    features: {
        beans: true,
        knocks: true,
        decisions: true,
        invites: true,
        door: 'members',
        knownFloor: 1000,
    },
} as unknown as HomeAnswer;

describe('HomePage community shape line and modal (S5)', () => {
    beforeEach(() => {
        (globalThis as any).indexedDB = memoryIndexedDB();
        resetHomeCacheForTest();
        resetAccountEpochForTest();
        vi.clearAllMocks();
    });

    afterEach(() => {
        cleanup();
    });

    it('renders the shape summary line on the community card and opens modal on click', async () => {
        vi.mocked(api.getHome).mockResolvedValueOnce({
            status: 200,
            tag: 'tag-1',
            home: HOME_ANSWER_WITH_SHAPE,
        });

        const onNavigate = vi.fn();
        render(<HomePage identity={ME} visitor={false} onNavigate={onNavigate} onSeeWords={() => {}} />);

        await waitFor(() => {
            expect(screen.getByTestId('home-community-shape-summary')).toBeInTheDocument();
        });

        const summaryBtn = screen.getByTestId('home-community-shape-summary');
        expect(summaryBtn).toHaveTextContent('How it works: any member invites · Beans on · votes on · requests to join on');

        // Click summary opens modal
        fireEvent.click(summaryBtn);

        const modal = screen.getByTestId('community-shape-modal');
        expect(modal).toBeInTheDocument();
        expect(screen.getByText('How this community works')).toBeInTheDocument();
        expect(screen.getByText('Confirmed members')).toBeInTheDocument();

        // Click Read more in guide
        const readMoreBtn = screen.getByTestId('community-shape-read-more');
        fireEvent.click(readMoreBtn);
        expect(onNavigate).toHaveBeenCalledWith('guide', 'how-this-community-works');
    });

    it('does NOT render the shape summary line on an old node without shape features', async () => {
        vi.mocked(api.getHome).mockResolvedValueOnce({
            status: 200,
            tag: 'tag-old',
            home: {
                ...HOME_ANSWER_WITH_SHAPE,
                features: {},
            },
        });

        render(<HomePage identity={ME} visitor={false} onNavigate={() => {}} onSeeWords={() => {}} />);

        await waitFor(() => {
            expect(screen.getByTestId('home-community-body')).toBeInTheDocument();
        });

        expect(screen.queryByTestId('home-community-shape-summary')).not.toBeInTheDocument();
    });
});
