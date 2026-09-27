/**
 * Settings → Manage Blocked Members, with the list the community keeps for the account (Marty's card web-blocklist-where,
 * 2026-09-27): read from the node, never "No blocked members" when it couldn't be read, and an unblock shown only once
 * the node has taken it. The real lib/blocklist; the node's routes are mocked at lib/api.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { resetBlocklistForTests } from '../lib/blocklist';

const BO = 'b2'.repeat(32);
const CY = 'c3'.repeat(32);

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async (pk: string) => ({ callsign: ({ ['b2'.repeat(32)]: 'Bo', ['c3'.repeat(32)]: 'Cy' } as Record<string, string>)[pk] })),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getBlockList: vi.fn(),
        addToBlockList: vi.fn(),
        removeFromBlockList: vi.fn(),
        clearBlockList: vi.fn(),
    };
});

const identity: any = { publicKey: 'a1'.repeat(32), privateKey: 'priv', callsign: 'Me' };
const listOf = (keys: string[]) => ({ blocked: keys.map(k => ({ publicKey: k, blockedAt: '2026-09-27T00:00:00.000Z' })), max: 500 });
const offline = () => new TypeError('Failed to fetch');

async function openBlocked() {
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
    fireEvent.click(screen.getByText('🚫 Manage Blocked Members'));
    await screen.findByText('🚫 Blocked Members');
}
const rowOf = (name: string) => screen.getByText(name).closest('div.p-3\\.5') as HTMLElement;

beforeEach(() => {
    localStorage.clear();
    resetBlocklistForTests();
    vi.mocked(api.getBlockList).mockReset().mockResolvedValue(listOf([BO, CY]));
    vi.mocked(api.removeFromBlockList).mockReset();
    vi.mocked(api.clearBlockList).mockReset();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('Settings → Manage Blocked Members, kept by the community', () => {
    it('shows the list the community keeps for the account, and says so', async () => {
        await openBlocked();
        expect(await screen.findByText('Bo')).toBeInTheDocument();
        expect(screen.getByText('Cy')).toBeInTheDocument();
        expect(screen.getByText(/Your community keeps this list with your account, so it comes back when you sign in on any browser\. Its operator can see it\./)).toBeInTheDocument();
        expect(api.getBlockList).toHaveBeenCalled();
        expect(Object.keys(localStorage).filter(k => /block/i.test(k))).toEqual([]);
    });

    it('a list it could not read is said, never "No blocked members", and Try again reads it', async () => {
        vi.mocked(api.getBlockList).mockRejectedValue(offline());
        await openBlocked();
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Couldn’t load your blocked members from your community. Check your connection and try again.');
        expect(screen.queryByText('No blocked members')).toBeNull();

        vi.mocked(api.getBlockList).mockResolvedValue(listOf([BO]));
        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Bo')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('an unblock the community did not take is said, and they stay listed; one it took takes them off', async () => {
        await openBlocked();
        await screen.findByText('Bo');
        vi.mocked(api.removeFromBlockList).mockRejectedValueOnce(offline());
        fireEvent.click(within(rowOf('Bo')).getByRole('button', { name: 'Unblock' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach your community, so they are still blocked. Check your connection and try again.');
        expect(screen.getByText('Bo')).toBeInTheDocument();

        vi.mocked(api.removeFromBlockList).mockResolvedValueOnce({ ...listOf([CY]), removed: true });
        fireEvent.click(within(rowOf('Bo')).getByRole('button', { name: 'Unblock' }));
        await waitFor(() => expect(screen.queryByText('Bo')).toBeNull());
        expect(screen.getByText('Cy')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(api.removeFromBlockList).toHaveBeenLastCalledWith(BO);
    });

    it('Unblock All the community did not take is said, and everyone stays listed', async () => {
        await openBlocked();
        await screen.findByText('Bo');
        vi.mocked(api.clearBlockList).mockRejectedValueOnce(offline());
        fireEvent.click(screen.getByRole('button', { name: 'Unblock All' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach your community, so nobody was unblocked. Check your connection and try again.');
        expect(screen.getByText('Bo')).toBeInTheDocument();
        expect(screen.getByText('Cy')).toBeInTheDocument();

        vi.mocked(api.clearBlockList).mockResolvedValueOnce({ ...listOf([]), removed: 2 });
        fireEvent.click(screen.getByRole('button', { name: 'Unblock All' }));
        expect(await screen.findByText('No blocked members')).toBeInTheDocument();
    });
});
