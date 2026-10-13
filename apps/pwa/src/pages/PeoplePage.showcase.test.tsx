/**
 * People on the worldwide community, where the showcase (#1853: an off feature previewed, under the one 🏘️ Local
 * community marker) meets members on demand (#1861: people asked for by nearness and by name, never read whole).
 * Community asks for who is near; Invites draws the local-community line and its sheet; nothing reads the whole
 * directory and no request names a sample id.
 */
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { LOCAL_COMMUNITY_LINES, LOCAL_COMMUNITY_SHEET } from '@beanpool/core';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
// The QR code isn't what is under test, and qrcode.react brings its own copy of React.
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => null }));

// The worldwide community as it answers: every showcase feature off, previews on, people asked for, not read whole.
const GLOBAL_SHOWCASE = vi.hoisted(() => ({
    memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global',
    features: {
        beans: false, escrow: false, enterprises: false, decisions: false, invites: false, showcase: true,
        openJoin: true, wordsDoor: true, membersOnDemand: true, nearbyListings: { radiusKm: 250, max: 500 },
    },
}));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => GLOBAL_SHOWCASE) }));
vi.mock('../lib/member-area', () => ({ readMyArea: vi.fn(async () => ({ lat: -28.6, lng: 153.6 })) }));

const ME = 'a'.repeat(64);
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };

describe('People on global with previews AND members on demand (where #1853 meets #1861)', () => {
    const fetchSpy = vi.fn(async (..._args: unknown[]): Promise<Response> => { throw new TypeError('offline'); });
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        vi.stubGlobal('fetch', fetchSpy);
        fetchSpy.mockClear();
        vi.spyOn(api, 'getFriends').mockResolvedValue([]);
        vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        vi.spyOn(api, 'getMemberCards').mockImplementation(async (path: string) =>
            path.includes('lat=') ? [{ publicKey: 'c'.repeat(64), callsign: 'Cleo', joinedAt: '2026-01-01T00:00:00.000Z', distanceKm: 4 }] : []);
        vi.spyOn(api, 'getMyInvites').mockResolvedValue({ invites: [] } as any);
        vi.spyOn(api, 'getInviteTree').mockResolvedValue([] as any);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('Community asks who is near; Invites draws the local-community line and its sheet; no whole read, no sample id', async () => {
        render(<PeoplePage identity={identity} initialView="community" />);
        await screen.findByTestId('people-near');
        expect(vi.mocked(api.getMemberCards).mock.calls.map(c => c[0])).toEqual(['/api/members?lat=-28.6&lng=153.6&limit=50']);

        fireEvent.click(screen.getByRole('tab', { name: /Invites/ }));
        const line = await screen.findByTestId('local-community-line');
        expect(line).toHaveTextContent(LOCAL_COMMUNITY_LINES.invites.replace(/^🏘️ /, '').replace(/ ›$/, ''));
        fireEvent.click(line);
        const sheet = await screen.findByTestId('local-community-sheet');
        expect(sheet).toHaveTextContent(LOCAL_COMMUNITY_SHEET.features.invites);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));

        fireEvent.click(screen.getByRole('tab', { name: /Community/ }));
        await screen.findByTestId('people-near');
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        await waitFor(() => expect(api.getMemberCards).toHaveBeenCalled());
        expect(api.getMembers).not.toHaveBeenCalled();
        // Every call the page made, to the node's api or to fetch: none names a sample id, and nothing was written.
        const calls = [...(Object.values(api) as unknown[]).filter(vi.isMockFunction).flatMap(f => f.mock.calls), ...fetchSpy.mock.calls];
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.map(c => JSON.stringify(c)).filter(s => /\bsample-[a-z0-9]/.test(s))).toEqual([]);
        expect(fetchSpy.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET')).toEqual([]);
    });
});
