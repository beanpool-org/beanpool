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
    // The modal reads the date on a tightened line (lib/known-rule.ts).
    request: vi.fn(async () => null),
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
    me: { joinedAt: '2026-01-01T00:00:00.000Z', isKeeper: false, probation: null, interests: [], area: null, firstOffer: false, standing: 'member' },
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
            notModified: false,
            etag: 'tag-1',
            answer: HOME_ANSWER_WITH_SHAPE,
        });

        const onNavigate = vi.fn();
        render(<HomePage identity={ME} onNavigate={onNavigate} onSeeWords={() => {}} />);

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
        expect(onNavigate).toHaveBeenCalledWith('guide', 'how-your-community-works');
    });

    it('opens on the floor, then the rule, from what the node sends (review of #2746)', async () => {
        // features on GET /api/home, for a member of a known community (apps/server config/features-for.ts).
        vi.mocked(api.getHome).mockResolvedValueOnce({
            notModified: false,
            etag: 'tag-rule',
            answer: { ...HOME_ANSWER_WITH_SHAPE, features: { ...HOME_ANSWER_WITH_SHAPE.features, debtLinePct: 50, quietDays: 60 } } as unknown as HomeAnswer,
        });
        render(<HomePage identity={ME} onNavigate={() => {}} onSeeWords={() => {}} />);
        fireEvent.click(await screen.findByTestId('home-community-shape-summary'));
        expect(screen.getByTestId('community-shape-modal').textContent)
            .toContain("(the known floor)The admins can see a confirmed member's balance if they owe more than half their credit line, or are in debit and haven't made a sale for 60 days. Each look is logged.");
    });

    it('says who decides a removal, from beside the features a member\'s Home says (removal jury J3)', async () => {
        vi.mocked(api.getHome).mockResolvedValueOnce({
            notModified: false,
            etag: 'tag-removals',
            answer: { ...HOME_ANSWER_WITH_SHAPE, removalDecider: 'jury' } as unknown as HomeAnswer,
        });
        render(<HomePage identity={ME} onNavigate={() => {}} onSeeWords={() => {}} />);
        fireEvent.click(await screen.findByTestId('home-community-shape-summary'));
        expect(screen.getByTestId('community-shape-modal').textContent).toContain('decided by a jury drawn at random; while fewer than 36 members could serve on one, by everyone who can vote');
    });

    it('does NOT render the shape summary line on an old node without shape features', async () => {
        vi.mocked(api.getHome).mockResolvedValueOnce({
            notModified: false,
            etag: 'tag-old',
            answer: {
                ...HOME_ANSWER_WITH_SHAPE,
                features: {},
            },
        });

        render(<HomePage identity={ME} onNavigate={() => {}} onSeeWords={() => {}} />);

        await waitFor(() => {
            expect(screen.getByTestId('home-community-body')).toBeInTheDocument();
        });

        expect(screen.queryByTestId('home-community-shape-summary')).not.toBeInTheDocument();
    });

    it('does NOT render the shape summary line to a visitor, who has no account here (the members\' card)', async () => {
        vi.mocked(api.getHome).mockResolvedValueOnce({
            notModified: false,
            etag: 'tag-visitor',
            answer: { ...HOME_ANSWER_WITH_SHAPE, welcome: true, me: null } as unknown as HomeAnswer,
        });

        render(<HomePage identity={null} onNavigate={() => {}} onSeeWords={() => {}} />);

        await waitFor(() => {
            expect(screen.getByTestId('home-community-body')).toBeInTheDocument();
        });

        expect(screen.queryByTestId('home-community-shape-summary')).not.toBeInTheDocument();
    });
});
