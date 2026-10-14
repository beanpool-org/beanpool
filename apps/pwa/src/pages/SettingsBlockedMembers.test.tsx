/**
 * Settings → Manage Blocked Members, with the list the community keeps for the account (Marty's card web-blocklist-where,
 * 2026-09-27): read from the node, never "No blocked members" when it couldn't be read, an unblock shown only once
 * the node has taken it, and an older list never shown over a newer one. The real lib/blocklist; the node's routes are
 * mocked at lib/api.
 */
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { resetBlocklistForTests, blockUser, BLOCKLIST_STORAGE_KEY } from '../lib/blocklist';

const BO = 'b2'.repeat(32);
const CY = 'c3'.repeat(32);
const DX = 'd4'.repeat(32);

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
        getFriends: vi.fn(async () => []),
        removeFriendApi: vi.fn(),
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
    vi.mocked(api.addToBlockList).mockReset();
    vi.mocked(api.getFriends).mockReset().mockResolvedValue([]);
    vi.mocked(api.removeFriendApi).mockReset();
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

    it('a block from before that doesn\'t fit on the full list is listed, still blocked, and the full list is said', async () => {
        // An older build blocked Dx in this browser; the list on the community has room for two, and holds Bo and Cy.
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify([DX]));
        vi.mocked(api.getBlockList).mockResolvedValue({ ...listOf([BO, CY]), max: 2 });
        await openBlocked();
        await screen.findByText('Bo');
        expect(screen.getByText('Cy')).toBeInTheDocument();
        expect(await screen.findByText('d4d4d4d4...d4d4d4')).toBeInTheDocument();
        expect(screen.getByRole('status')).toHaveTextContent('Your block list is full, so 1 block is kept in this browser only. Unblock someone to make room for it.');
        expect(api.addToBlockList).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([DX]);

        // Unblocking Bo makes room: the note goes, and Dx stays blocked (it goes up with the read the community's doorbell brings).
        vi.mocked(api.removeFromBlockList).mockResolvedValueOnce({ ...listOf([CY]), max: 2, removed: true });
        fireEvent.click(within(rowOf('Bo')).getByRole('button', { name: 'Unblock' }));
        await waitFor(() => expect(screen.queryByText('Bo')).toBeNull());
        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.getByText('d4d4d4d4...d4d4d4')).toBeInTheDocument();
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toEqual([DX]);
    });

    it('an older list whose names come in last never replaces a newer one: an unblocked member stays off', async () => {
        await openBlocked();
        await screen.findByText('Bo');
        // Dx's name is slow to come in, each time it is asked for.
        const names: ((p: { callsign: string }) => void)[] = [];
        const profile = vi.mocked(api.getMemberProfile).getMockImplementation()!;
        vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) =>
            pk === DX ? new Promise(r => names.push(r)) as any : profile(pk));

        // Dx is blocked elsewhere: the list is Bo, Cy, Dx, waiting on Dx's name.
        vi.mocked(api.addToBlockList).mockResolvedValueOnce({ ...listOf([BO, CY, DX]), added: [DX] });
        await act(async () => { await blockUser(DX); });
        // Bo is unblocked here: the list is Cy, Dx, waiting on Dx's name again.
        vi.mocked(api.removeFromBlockList).mockResolvedValueOnce({ ...listOf([CY, DX]), removed: true });
        fireEvent.click(within(rowOf('Bo')).getByRole('button', { name: 'Unblock' }));
        await waitFor(() => expect(names.length).toBe(2));

        // The newer list's name comes in first, the older one's last.
        await act(async () => { names[1]({ callsign: 'Dx' }); });
        expect(await screen.findByText('Dx')).toBeInTheDocument();
        await act(async () => { names[0]({ callsign: 'Dx' }); });
        expect(screen.queryByText('Bo')).toBeNull();
        expect(screen.getByText('Cy')).toBeInTheDocument();
        expect(screen.getByText('Dx')).toBeInTheDocument();
    });
});

// A block does not end a friendship, and the web hides a blocked member from your lists (#1913, measured by the Argon
// shadow): ending it too took unblock, remove, block again. "Also remove from friends" on the blocked list is one step,
// through the same route as any removal (POST /api/friends/remove), and the block stays.
describe('Settings → Manage Blocked Members: Also remove from friends', () => {
    const friend = (publicKey: string, callsign: string) => ({ publicKey, callsign, addedAt: '2026-10-01T00:00:00.000Z', isGuardian: false });
    const removeFrom = (name: string) => within(rowOf(name)).queryByRole('button', { name: 'Also remove from friends' });

    it('is offered only for a blocked member who is still your friend, and says they can notice', async () => {
        vi.mocked(api.getFriends).mockResolvedValue([friend(BO, 'Bo')]);
        await openBlocked();
        await screen.findByText('Bo');
        await waitFor(() => expect(removeFrom('Bo')).not.toBeNull());
        expect(within(rowOf('Bo')).getByText('Still your friend. They can notice a removal.')).toBeInTheDocument();
        expect(removeFrom('Cy')).toBeNull();
        expect(within(rowOf('Cy')).queryByText(/Still your friend/)).toBeNull();
        expect(api.getFriends).toHaveBeenCalledWith(identity.publicKey);
    });

    it('removes the friend through the friend route and keeps the block', async () => {
        vi.mocked(api.getFriends).mockResolvedValue([friend(BO, 'Bo'), friend(CY, 'Cy')]);
        vi.mocked(api.removeFriendApi).mockResolvedValueOnce({ success: true });
        await openBlocked();
        await screen.findByText('Bo');
        await waitFor(() => expect(removeFrom('Bo')).not.toBeNull());
        fireEvent.click(removeFrom('Bo')!);
        expect(window.confirm).toHaveBeenLastCalledWith('Remove Bo from your friends? They stay blocked. They can notice a removal.');
        expect(await within(rowOf('Bo')).findByText('No longer your friend. Still blocked.')).toBeInTheDocument();
        expect(removeFrom('Bo')).toBeNull();
        expect(api.removeFriendApi).toHaveBeenCalledTimes(1);
        expect(api.removeFriendApi).toHaveBeenCalledWith(identity.publicKey, BO);
        // Still blocked: nothing was asked of the block list, and Bo is still on it, with Unblock.
        expect(api.removeFromBlockList).not.toHaveBeenCalled();
        expect(api.clearBlockList).not.toHaveBeenCalled();
        expect(within(rowOf('Bo')).getByRole('button', { name: 'Unblock' })).toBeInTheDocument();
        expect(removeFrom('Cy')).not.toBeNull();
    });

    it('a removal the community did not take is said, and they are still offered; Cancel removes nothing', async () => {
        vi.mocked(api.getFriends).mockResolvedValue([friend(BO, 'Bo')]);
        await openBlocked();
        await screen.findByText('Bo');
        await waitFor(() => expect(removeFrom('Bo')).not.toBeNull());

        vi.mocked(window.confirm).mockReturnValueOnce(false);
        fireEvent.click(removeFrom('Bo')!);
        expect(api.removeFriendApi).not.toHaveBeenCalled();

        vi.mocked(api.removeFriendApi).mockRejectedValueOnce(offline());
        fireEvent.click(removeFrom('Bo')!);
        expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach your community, so they are still your friend. Check your connection and try again.');
        expect(removeFrom('Bo')).not.toBeNull();
        expect(within(rowOf('Bo')).queryByText('No longer your friend. Still blocked.')).toBeNull();
    });

    it('offers nothing when your friends could not be read', async () => {
        vi.mocked(api.getFriends).mockRejectedValue(offline());
        await openBlocked();
        await screen.findByText('Bo');
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
        expect(removeFrom('Bo')).toBeNull();
        expect(removeFrom('Cy')).toBeNull();
    });
});
