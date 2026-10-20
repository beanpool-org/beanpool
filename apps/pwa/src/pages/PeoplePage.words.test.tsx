/**
 * People in the member's language (words S3, web sweep W2): the sub-nav, Friends (who added you, the list, the empty
 * state), Community read whole (the list, its search, loading, a failed read) and Community by area (near you, the
 * node's search and each of its states) through t(), the phone's keys where it says the same. Members' names are
 * theirs and shown as written; the node's own refusals are its words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PeoplePage } from './PeoplePage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import { forgetRecentLookups } from '../lib/members-on-demand';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('./InvitePage', () => ({ InvitePage: () => <div data-testid="invite-page" /> }));
const info = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => info.value) }));
const area = vi.hoisted(() => ({ value: { lat: -28.6, lng: 153.6 } as { lat: number; lng: number } | null }));
vi.mock('../lib/member-area', () => ({ readMyArea: vi.fn(async () => area.value) }));

const ME = 'a'.repeat(64);
const identity: BeanPoolIdentity = { publicKey: ME, privateKey: 'mock-private-key-hex', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' };
const LEAF = 'bundled://leaf';
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const card = (k: string, callsign: string, distanceKm?: number | null) => ({ publicKey: k.repeat(64), callsign, avatarUrl: LEAF, joinedAt: ago(3 * DAY), distanceKm });
/** What members wrote (their names), shown as written. */
const OTHERS = ['Bob', 'Ana', 'Cleo', 'Dov', 'Alma', 'Alder', 'Zed'];
const GLOBAL = { profile: 'global', features: { membersOnDemand: true, nearbyListings: { radiusKm: 250, max: 500 } } };

function clean() {
    expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
}

beforeEach(() => {
    vi.restoreAllMocks();
    forgetRecentLookups();
    localStorage.clear();
    info.value = {};
    area.value = { lat: -28.6, lng: 153.6 };
    vi.spyOn(api, 'getFriends').mockResolvedValue([
        { publicKey: 'b'.repeat(64), callsign: 'Bob', avatarUrl: LEAF, addedAt: ago(2 * DAY), isGuardian: false } as any,
    ]);
    vi.spyOn(api as any, 'getAddedYou').mockResolvedValue({ addedYou: [{ publicKey: 'n'.repeat(64), callsign: 'Ana', avatarUrl: LEAF, addedAt: ago(DAY) }], more: 2 });
    vi.spyOn(api, 'getMembers').mockResolvedValue([
        { publicKey: 'b'.repeat(64), callsign: 'Bob', avatarUrl: LEAF, joinedAt: ago(40 * DAY), invitedBy: '', inviteCode: '' },
        { publicKey: 'z'.repeat(64), callsign: 'Zed', avatarUrl: LEAF, joinedAt: ago(9 * DAY), invitedBy: '', inviteCode: '' },
    ] as any);
    vi.spyOn(api, 'getMemberCards').mockImplementation(async (path: string) => {
        if (path.includes('lat=')) return [card('c', 'Cleo', 0), card('d', 'Dov', 12)] as any;
        if (path.includes('q=')) return [card('e', 'Alma'), card('f', 'Alder')] as any;
        return [];
    });
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('People in the pseudo-locale', () => {
    it('Friends: the sub-nav, who added you, and the list with its buttons', async () => {
        await showIn('xx');
        render(<PeoplePage identity={identity} onNavigate={vi.fn()} />);
        expect(await screen.findByTestId('added-you')).toHaveTextContent('Ana');
        await screen.findByText('Bob');
        expect(screen.getByRole('tab', { name: xx('👫 Friends') })).toBeInTheDocument();
        expect(screen.getByRole('tablist', { name: xx('People navigation') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Add {name} back').replace('{name}', 'Ana') }).textContent).toBe(xx('Add back'));
        expect(screen.getByRole('button', { name: xx('Message {name}').replace('{name}', 'Bob') })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Remove {name} from friends').replace('{name}', 'Bob') })).toBeInTheDocument();
        expect(screen.getByTestId('added-you')).toHaveTextContent(xx('and {n} more').replace('{n}', '2'));
        expect(bracketed()).toBeGreaterThan(5);
        clean();
    });

    it('Friends with nobody yet', async () => {
        vi.spyOn(api, 'getFriends').mockResolvedValue([]);
        vi.spyOn(api as any, 'getAddedYou').mockResolvedValue({ addedYou: [], more: 0 });
        await showIn('xx');
        render(<PeoplePage identity={identity} />);
        expect(await screen.findByText(xx('No friends yet'))).toBeInTheDocument();
        clean();
    });

    it('Community read whole: loading, the list, its search, and a failed read', async () => {
        let release!: (v: unknown) => void;
        vi.spyOn(api, 'getMembers').mockReturnValueOnce(new Promise((r) => { release = r; }) as any);
        await showIn('xx');
        render(<PeoplePage identity={identity} initialView="community" />);
        // Drawn while the node says how it lists people, and again while the list is read: the second one is checked.
        await waitFor(() => expect(api.getMembers).toHaveBeenCalled());
        expect(screen.getByText(xx('Loading community...'))).toBeInTheDocument();
        clean();
        release([{ publicKey: 'b'.repeat(64), callsign: 'Bob', avatarUrl: LEAF, joinedAt: ago(40 * DAY), invitedBy: '', inviteCode: '' },
            { publicKey: 'z'.repeat(64), callsign: 'Zed', avatarUrl: LEAF, joinedAt: ago(9 * DAY), invitedBy: '', inviteCode: '' }]);
        await screen.findByText('Zed');
        await waitFor(() => expect(screen.getByText(xx('✓ Friend'))).toBeInTheDocument());
        expect(screen.getByRole('button', { name: xx('Add {name} as friend').replace('{name}', 'Zed') })).toBeInTheDocument();
        clean();
        fireEvent.change(screen.getByPlaceholderText(xx('🔍 Search members...')), { target: { value: 'Ze' } });
        expect(screen.getByText(xx('{n} member found').replace('{n}', '1'))).toBeInTheDocument();
        clean();
        cleanup();

        vi.spyOn(api, 'getMembers').mockRejectedValue(new Error('offline'));
        render(<PeoplePage identity={identity} initialView="community" />);
        expect(await screen.findByTestId('people-members-failed')).toBeInTheDocument();
        clean();
    });

    it('Community by area: near you, the search and its states', async () => {
        info.value = GLOBAL;
        await showIn('xx');
        render(<PeoplePage identity={identity} initialView="community" />);
        expect(await screen.findByTestId('people-near')).toHaveTextContent('Dov');
        expect(screen.getByText(xx('The {n} closest members to your area.').replace('{n}', '2'))).toBeInTheDocument();
        expect(screen.getByText(xx('Under 1 km away'))).toBeInTheDocument();
        expect(screen.getByText(xx('About {km} km away').replace('{km}', '12'))).toBeInTheDocument();
        clean();

        const search = screen.getByLabelText(xx('Search members by name'));
        fireEvent.change(search, { target: { value: 'A' } });
        expect(screen.getByTestId('people-search-status').textContent).toBe(xx('Type at least {n} letters of a name.').replace('{n}', '2'));
        clean();
        fireEvent.change(search, { target: { value: 'Al' } });
        expect(screen.getByTestId('people-search-status').textContent).toBe(xx('Searching…'));
        expect(await screen.findByTestId('people-found')).toHaveTextContent('Alma');
        expect(screen.getByTestId('people-search-status').textContent).toBe(xx('{n} members found').replace('{n}', '2'));
        clean();
    });

    it('Community by area: no area, nobody near, and reads that failed', async () => {
        info.value = GLOBAL;
        area.value = null;
        await showIn('xx');
        render(<PeoplePage identity={identity} initialView="community" />);
        expect(await screen.findByTestId('people-no-area')).toBeInTheDocument();
        clean();
        cleanup();

        area.value = { lat: -28.6, lng: 153.6 };
        vi.spyOn(api, 'getMemberCards').mockResolvedValue([]);
        render(<PeoplePage identity={identity} initialView="community" />);
        expect(await screen.findByText(xx('Nobody else is here yet. Search by name, or invite someone.'))).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText(xx('Search members by name')), { target: { value: 'Qq' } });
        expect(await screen.findByText(xx('Nobody here has a name starting with that.'))).toBeInTheDocument();
        clean();
        cleanup();

        forgetRecentLookups();
        vi.spyOn(api, 'getMemberCards').mockRejectedValue(new Error('offline'));
        render(<PeoplePage identity={identity} initialView="community" />);
        expect(await screen.findByTestId('people-near-failed')).toHaveTextContent(xx("Couldn't check who's near you just now."));
        fireEvent.change(screen.getByLabelText(xx('Search members by name')), { target: { value: 'Al' } });
        await waitFor(() => expect(screen.getByTestId('people-search-status').textContent).toBe(xx("Couldn't search just now. Check your connection and try again.")));
        clean();
    });
});

describe('People in English', () => {
    it('nothing is bracketed, and the words are as they were', async () => {
        render(<PeoplePage identity={identity} onNavigate={vi.fn()} />);
        const list = await screen.findByTestId('added-you');
        expect(bracketed()).toBe(0);
        expect(list).toHaveTextContent('Ana added you');
        expect(list).toHaveTextContent('and 2 more');
        expect(screen.getByRole('tab', { name: '👫 Friends' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: '🏘️ Community' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: '🎟️ Invites' })).toBeInTheDocument();
        expect(await screen.findByText('Added 2d ago')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Remove Bob from friends' }).textContent).toBe('Remove');
        expect(screen.getByRole('button', { name: "View Bob's profile" })).toBeInTheDocument();
    });

    it('Community by area reads as it did', async () => {
        info.value = GLOBAL;
        render(<PeoplePage identity={identity} initialView="community" />);
        const near = await screen.findByTestId('people-near');
        expect(near).toHaveTextContent('Under 1 km away');
        expect(near).toHaveTextContent('About 12 km away');
        expect(screen.getByText('The 2 closest members to your area.')).toBeInTheDocument();
        expect(screen.getByText(/Find someone by name, or see who's near you\. Tap/).textContent)
            .toBe("Find someone by name, or see who's near you. Tap + Add to add someone as a friend.");
        fireEvent.change(screen.getByLabelText('Search members by name'), { target: { value: 'A' } });
        expect(screen.getByTestId('people-search-status').textContent).toBe('Type at least 2 letters of a name.');
        fireEvent.change(screen.getByLabelText('Search members by name'), { target: { value: 'Al' } });
        await screen.findByTestId('people-found');
        expect(screen.getByTestId('people-search-status').textContent).toBe('2 members found');
        expect(screen.getAllByText('Joined 3d ago').length).toBeGreaterThan(0);
    });
});
