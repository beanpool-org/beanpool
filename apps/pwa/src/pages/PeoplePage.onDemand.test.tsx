/**
 * People → Community on a community where people are asked for, not read whole (features.membersOnDemand, design
 * DESIGN-global-members-by-area §2.3, slice M3): what the page asks the node, with a stored area and without one, and
 * that a community without the switch asks exactly what it asked before.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import React from 'react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => ['b'.repeat(64)]),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('./InvitePage', () => ({ InvitePage: () => <div>Invite codes</div> }));

const info = vi.hoisted(() => ({ value: {} as Record<string, unknown> | Error }));
vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => { if (info.value instanceof Error) throw info.value; return info.value; }),
}));
const area = vi.hoisted(() => ({ value: undefined as { lat: number; lng: number } | null | undefined }));
vi.mock('../lib/member-area', () => ({ readMyArea: vi.fn(async () => area.value) }));

const ME = 'a'.repeat(64);
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };
const card = (k: string, callsign: string, distanceKm?: number | null) => ({ publicKey: k.repeat(64), callsign, joinedAt: '2026-01-01T00:00:00.000Z', distanceKm });

const GLOBAL = { profile: 'global', features: { membersOnDemand: true, nearbyListings: { radiusKm: 250, max: 500 } } };

function openCommunity() {
    render(<PeoplePage identity={identity} initialView="community" />);
}

describe('People on a community with members on demand', () => {
    let cards: MockInstance<typeof api.getMemberCards>;
    let whole: MockInstance<typeof api.getMembers>;
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getFriends').mockResolvedValue([]);
        whole = vi.spyOn(api, 'getMembers').mockResolvedValue([]);
        cards = vi.spyOn(api, 'getMemberCards').mockImplementation(async (path: string) => {
            if (path.includes('lat=')) return [card('a', 'Me', 0), card('c', 'Cleo', 0), card('d', 'Dov', 12), card('b', 'Blocked', 3)];
            if (path.includes('q=')) return [card('e', 'Alma'), card('f', 'Alder')];
            return [];
        });
        info.value = GLOBAL;
        area.value = { lat: -28.6, lng: 153.6 };
    });

    it('with an area: asks for the 50 nearest that point, never the whole directory, and says how far each is', async () => {
        openCommunity();
        await screen.findByTestId('people-near');
        expect(cards).toHaveBeenCalledTimes(1);
        expect(cards.mock.calls[0][0]).toBe('/api/members?lat=-28.6&lng=153.6&limit=50');
        expect(whole).not.toHaveBeenCalled();
        const rows = screen.getAllByTestId('people-row');
        // Neither the member nor someone they blocked.
        expect(rows.map(r => r.textContent)).toEqual([
            expect.stringContaining('Cleo'), expect.stringContaining('Dov'),
        ]);
        expect(rows[0]).toHaveTextContent('Under 1 km away');
        expect(rows[1]).toHaveTextContent('About 12 km away');
    });

    it('without an area: asks nothing about nearness, says how to set one, and the search still works', async () => {
        area.value = null;
        openCommunity();
        await screen.findByTestId('people-no-area');
        expect(cards).not.toHaveBeenCalled();
        const box = screen.getByLabelText('Search members by name');
        fireEvent.change(box, { target: { value: 'a' } });
        expect(screen.getByTestId('people-search-status')).toHaveTextContent('Type at least 2 letters');
        await new Promise(r => setTimeout(r, 600));
        expect(cards).not.toHaveBeenCalled();
        fireEvent.change(box, { target: { value: ' al ' } });
        await screen.findByTestId('people-found');
        expect(cards).toHaveBeenCalledTimes(1);
        expect(cards.mock.calls[0][0]).toBe('/api/members?q=al&limit=20');
        expect(screen.getByTestId('people-found')).toHaveTextContent('Alma');
        expect(whole).not.toHaveBeenCalled();
    });

    it('waits for the typing to pause: one search for a name typed quickly, for what was typed last', async () => {
        openCommunity();
        await screen.findByTestId('people-near');
        cards.mockClear();
        const box = screen.getByLabelText('Search members by name');
        for (const v of ['al', 'alm', 'alma']) fireEvent.change(box, { target: { value: v } });
        await screen.findByTestId('people-found');
        expect(cards.mock.calls.map(c => c[0])).toEqual(['/api/members?q=alma&limit=20']);
    });

    it("an area that couldn't be read says so, with Try again, and asks nothing without a point", async () => {
        area.value = undefined;
        openCommunity();
        await screen.findByTestId('people-near-failed');
        expect(cards).not.toHaveBeenCalled();
        area.value = { lat: 51.5, lng: -0.1 };
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await screen.findByTestId('people-near');
        expect(cards.mock.calls[0][0]).toBe('/api/members?lat=51.5&lng=-0.1&limit=50');
    });

    it('a community without the switch reads the directory as before, and asks none of the small forms', async () => {
        info.value = { profile: 'local', features: {} };
        whole.mockResolvedValue([{ publicKey: 'c'.repeat(64), callsign: 'Cleo', joinedAt: '2026-01-01', invitedBy: '', inviteCode: '' }]);
        openCommunity();
        await screen.findByText('Cleo');
        expect(whole).toHaveBeenCalledTimes(1);
        expect(cards).not.toHaveBeenCalled();
        expect(screen.queryByTestId('people-on-demand')).toBeNull();
        expect(screen.getByText(/All members on this node/)).toBeInTheDocument();
    });

    it('a node that cannot be asked about its switch reads as before', async () => {
        info.value = new Error('offline');
        openCommunity();
        await waitFor(() => expect(whole).toHaveBeenCalledTimes(1));
        expect(cards).not.toHaveBeenCalled();
    });
});
