/**
 * "New since you last looked" on the web (Market order S4, DESIGN-market-order-fable.md §2.9): one line in the section header's
 * style above the first post listed at or before this browser's stamp (the newest listed time on screen when the Market was last
 * left, under bp_market_seen_listed). None on the first visit, none under a search or a filter, none when nothing is newer.
 * The phone's twin is apps/native/utils/__tests__/market-new-since-render.test.ts.
 */
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MarketplacePage } from './MarketplacePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../lib/geo', () => ({
    loadRadiusSettings: vi.fn(() => null),
    saveRadiusSettings: vi.fn(),
    clearRadiusSettings: vi.fn(),
    haversineDistance: vi.fn(() => 0),
}));
vi.mock('../lib/peer-prefs', () => ({ loadEnabledPeers: vi.fn(() => new Set()), togglePeer: vi.fn() }));
vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ActivityWaterfall', () => ({ ActivityWaterfall: () => null }));

const identity: BeanPoolIdentity = {
    publicKey: 'my-web-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Alice',
    createdAt: '2026-09-17T00:00:00.000Z',
};

const HOUR = 60 * 60 * 1000;
const KEY = 'bp_market_seen_listed';
const LINE = 'New since you last looked';
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const listing = (id: string, title: string, hoursAgo: number) => ({
    id, title, description: 'Description of ' + title, type: 'offer' as const, category: 'services', credits: 10, status: 'active' as const,
    authorPublicKey: `author-${id}`, authorCallsign: 'Bob', createdAt: ago(hoursAgo),
});
const board = () => [listing('a1', 'Ana one', 1), listing('b1', 'Bo bread', 3), listing('y1', 'Yesterday goats', 30), listing('old', 'Old ladder', 24 * 12)];

const holds = (posts: unknown[]) => { vi.spyOn(api, 'getMarketplacePosts').mockResolvedValue(posts as any); };
const lines = () => document.querySelectorAll('[data-testid="market-new-since"]');
const at = (s: string) => (document.body.textContent ?? '').indexOf(s);
const useView = (mode: 'grid' | 'list') => localStorage.setItem('marketplace_view_mode', mode);

describe('MarketplacePage: New since you last looked on the web', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        // The middle of a day, so Today and Yesterday do not shift under the test; timers keep running.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 10, 3, 17, 0, 0));
        vi.spyOn(api, 'getTreasuries').mockResolvedValue({ treasuries: [] });
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getNodeInfo').mockResolvedValue({ peerNodes: [] } as any);
        vi.spyOn(api, 'getNodeConfig').mockResolvedValue({} as any);
        vi.spyOn(api, 'getGroups').mockResolvedValue([]);
        vi.spyOn(api, 'getBalance').mockResolvedValue({ balance: 100, isBlockedFromTrading: false } as any);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('is not shown on the first visit, and leaving stores the newest listed time that was on screen', async () => {
        useView('list');
        holds(board());
        const first = render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Ana one');
        expect(lines()).toHaveLength(0);
        expect(localStorage.getItem(KEY)).toBeNull();
        first.unmount();
        expect(localStorage.getItem(KEY)).toBe(String(Date.parse(ago(1))));
    });

    it('after leaving, a new post is above the line and what was already seen is below it (list view)', async () => {
        useView('list');
        holds(board());
        const first = render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Ana one');
        first.unmount();

        holds([listing('n1', 'Newcomer jam', 0.5), ...board()]);
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Newcomer jam');
        expect(lines()).toHaveLength(1);
        expect(lines()[0].textContent).toBe(LINE);
        expect(at('Newcomer jam')).toBeLessThan(at(LINE));
        expect(at(LINE)).toBeLessThan(at('Ana one'));
        expect(at('Ana one')).toBeLessThan(at('Bo bread'));
    });

    it('is above the day heading when the first post already seen starts a day', async () => {
        useView('list');
        localStorage.setItem(KEY, String(Date.parse(ago(30))));
        holds([listing('n1', 'Newcomer jam', 2), listing('y1', 'Yesterday goats', 30), listing('old', 'Old ladder', 24 * 12)]);
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Newcomer jam');
        expect(lines()).toHaveLength(1);
        expect(at('Newcomer jam')).toBeLessThan(at(LINE));
        expect(at(LINE)).toBeLessThan(at('Yesterday'));
        expect(at('Yesterday')).toBeLessThan(at('Yesterday goats'));
    });

    it('is above the right tile in the grid (the web opens in the grid)', async () => {
        useView('grid');
        localStorage.setItem(KEY, String(Date.parse(ago(3))));
        holds([listing('n1', 'Newcomer jam', 0.5), ...board()]);
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Newcomer jam');
        expect(lines()).toHaveLength(1);
        expect(lines()[0].className).toContain('col-span-full');
        // Newcomer (0.5 h) and Ana (1 h) are newer than the stamp (3 h): above the line. Bo is the post that set it: below.
        expect(at('Newcomer jam')).toBeLessThan(at('Ana one'));
        expect(at('Ana one')).toBeLessThan(at(LINE));
        expect(at(LINE)).toBeLessThan(at('Bo bread'));
        const line = lines()[0];
        expect(line.nextElementSibling?.textContent).toContain('Bo bread');
    });

    it('is not shown when nothing is newer than the stamp', async () => {
        useView('list');
        localStorage.setItem(KEY, String(Date.parse(ago(1))));
        holds(board());
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Ana one');
        expect(lines()).toHaveLength(0);
    });

    it('is not shown when every post is newer than a stamp from long ago, or the stamp is damaged', async () => {
        useView('list');
        localStorage.setItem(KEY, String(Date.parse(ago(24 * 400))));
        holds(board());
        const first = render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Ana one');
        expect(lines()).toHaveLength(0);
        first.unmount();

        localStorage.setItem(KEY, 'not a number');
        render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Ana one');
        expect(lines()).toHaveLength(0);
    });

    it('is not shown under a search or a filter, whatever the stamp, and a narrowed view sets no stamp', async () => {
        useView('list');
        const stamp = String(Date.parse(ago(2)));
        localStorage.setItem(KEY, stamp);
        holds([listing('n1', 'Newcomer ladder jam', 0.5), ...board()]);
        const visit = render(<MarketplacePage identity={identity} isMember={true} />);
        await screen.findByText('Newcomer ladder jam');
        // The stamp is real: with no search or filter the line shows.
        expect(lines()).toHaveLength(1);

        // A filter: the Offers pill.
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Offers/ })); });
        expect(lines()).toHaveLength(0);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Offers/ })); });
        expect(lines()).toHaveLength(1);

        // A search.
        await act(async () => { fireEvent.change(screen.getByPlaceholderText('Search marketplace...'), { target: { value: 'ladder' } }); });
        expect(lines()).toHaveLength(0);
        visit.unmount();
        // Left while searching, the page wrote the newest it had when it last showed the whole Market (the newcomer), not a narrowed view's.
        expect(localStorage.getItem(KEY)).toBe(String(Date.parse(ago(0.5))));
    });

    it('a visit spent only under a filter leaves the stamp where it was', async () => {
        useView('list');
        const stamp = String(Date.parse(ago(5)));
        localStorage.setItem(KEY, stamp);
        holds([listing('n1', 'Newcomer jam', 0.5), ...board()]);
        const visit = render(<MarketplacePage identity={identity} isMember={true} openFilter="offer" onFilterOpened={() => {}} />);
        await screen.findByText('Newcomer jam');
        expect(lines()).toHaveLength(0);
        visit.unmount();
        expect(localStorage.getItem(KEY)).toBe(stamp);
    });

    it('is not shown to a visitor', async () => {
        useView('list');
        localStorage.setItem(KEY, String(Date.parse(ago(2))));
        holds([listing('n1', 'Newcomer jam', 0.5), ...board()]);
        render(<MarketplacePage identity={null as any} isMember={false} visitor={{ joinCard: null } as any} />);
        await screen.findByText('Newcomer jam');
        expect(lines()).toHaveLength(0);
    });
});
