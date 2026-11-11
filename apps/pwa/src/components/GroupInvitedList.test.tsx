/**
 * "Invited, not joined yet" on the web's group sheet (Rob via Marty, 11 Nov 2026: "Invitations should show whether they
 * have been used"). The sheet draws what the node answers (GET /api/groups/:id/invitations, which decides who may see
 * what); this holds that it draws it, says when and by whom, offers Withdraw on a pending row only, asks first, reads
 * again after, and is not on the page at all when there is nothing to say.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { GroupInvitedList } from './GroupInvitedList';
import { GroupDetailModal } from './GroupDetailModal';
import { getGroupInvitations, getGroup, getGroupMembers, removeGroupMember, withdrawGroupInvitation, type Group } from '../lib/api';
import type { GroupInvitations } from '@beanpool/core';

vi.mock('../lib/api', () => ({
    getGroupInvitations: vi.fn(),
    removeGroupMember: vi.fn(),
    withdrawGroupInvitation: vi.fn(),
    getGroup: vi.fn(), getGroupMembers: vi.fn(),
    getGroupDecisions: vi.fn(async () => null), proposeGroupDecision: vi.fn(), voteGroupDecision: vi.fn(),
    getCommunityMe: vi.fn(async () => ({ mute: { muted: false, until: null } })), getMembers: vi.fn(async () => []),
    inviteGroupMember: vi.fn(), joinGroup: vi.fn(), approveGroupMember: vi.fn(), setGroupMemberRole: vi.fn(),
    handOverGroupLead: vi.fn(), updateGroup: vi.fn(),
    getGroupSuccession: vi.fn().mockResolvedValue({
        silence: { convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0, isSilent: false, isEligible: false, electorate: 'convenors' },
        proposals: [], canPropose: false,
    }),
    proposeGroupSuccession: vi.fn(), voteGroupSuccession: vi.fn(),
    isRouteMissing: (e: unknown) => (e as { status?: number } | null)?.status === 404,
}));
vi.mock('../lib/members-on-demand', () => ({
    useMembersOnDemand: () => false, useMemberSearch: () => ({ found: null, state: 'idle' }),
    getMembersWhole: async () => [], isMembersOnDemandRefusal: () => false, MEMBERS_SEARCH_MIN_CHARS: 2,
}));

const ME = 'pk-cleo';
const DAYS_AGO = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

const convenorView = (): GroupInvitations => ({
    view: 'convenor', pendingTotal: 2,
    pending: [
        { memberPubkey: 'pk-mia', callsign: 'Mia', invitedAt: DAYS_AGO(2), invitedBy: { pubkey: ME, callsign: 'Cleo' } },
        { memberPubkey: 'pk-nat', callsign: 'Nat', invitedAt: DAYS_AGO(1), invitedBy: { pubkey: 'pk-cas', callsign: 'Cas' } },
    ],
    declined: [],
});

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(getGroupInvitations).mockResolvedValue(convenorView());
    vi.mocked(removeGroupMember).mockResolvedValue({ success: true });
    vi.mocked(withdrawGroupInvitation).mockResolvedValue({ success: true });
});

describe('Invited, not joined yet', () => {
    it('lists each name with when they were invited and, for a convenor, by whom ("you" for their own)', async () => {
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        const rows = await screen.findAllByTestId('group-invited-row');
        expect(rows).toHaveLength(2);
        expect(screen.getByRole('heading', { name: /INVITED, NOT JOINED YET \(2\)/ })).toBeInTheDocument();
        expect(within(rows[0]).getByText('Mia')).toBeInTheDocument();
        expect(rows[0]).toHaveTextContent('Invited 2 days ago by you');
        expect(rows[1]).toHaveTextContent('Invited 1 day ago by Cas');
        expect(getGroupInvitations).toHaveBeenCalledWith('g-1');
    });

    it("a member's own view says when, and no one made it but them", async () => {
        vi.mocked(getGroupInvitations).mockResolvedValue({ view: 'sender', pendingTotal: 1, pending: [{ memberPubkey: 'pk-ola', callsign: 'Ola', invitedAt: DAYS_AGO(3) }], declined: [] });
        render(<GroupInvitedList groupId="g-1" myPubkey="pk-hal" />);
        const row = await screen.findByTestId('group-invited-row');
        expect(row).toHaveTextContent('Invited 3 days ago');
        expect(row).not.toHaveTextContent(/ by /);
    });

    it('shows a declined invitation as Declined, dated, with no Withdraw, and says only the sender sees it', async () => {
        vi.mocked(getGroupInvitations).mockResolvedValue({
            view: 'convenor', pendingTotal: 0, pending: [],
            declined: [{ memberPubkey: 'pk-mia', callsign: 'Mia', invitedAt: DAYS_AGO(5), declinedAt: DAYS_AGO(4) }],
        });
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        const row = await screen.findByTestId('group-declined-row');
        expect(row).toHaveTextContent('Mia');
        expect(row).toHaveTextContent('Declined 4 days ago');
        expect(within(row).queryByRole('button')).toBeNull();
        expect(screen.queryByTestId('group-invited-row')).toBeNull();
        expect(screen.getByText('Nobody else in the group sees these.')).toBeInTheDocument();
    });

    it('is not on the page when the node says nothing, or there is nothing to say', async () => {
        vi.mocked(getGroupInvitations).mockResolvedValue(null);
        const { container, rerender } = render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        await waitFor(() => expect(getGroupInvitations).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
        vi.mocked(getGroupInvitations).mockResolvedValue({ view: 'sender', pendingTotal: 0, pending: [], declined: [] });
        rerender(<GroupInvitedList groupId="g-1" myPubkey={ME} reloadKey={1} />);
        await waitFor(() => expect(getGroupInvitations).toHaveBeenCalledTimes(2));
        expect(container).toBeEmptyDOMElement();
    });

    it('says how many more there are than the page holds', async () => {
        vi.mocked(getGroupInvitations).mockResolvedValue({ ...convenorView(), pendingTotal: 230 });
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        expect(await screen.findByText('and 228 more')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: /\(230\)/ })).toBeInTheDocument();
    });

    it('withdraws after asking, reads again, and tells the group around it', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const changed = vi.fn();
        vi.mocked(getGroupInvitations).mockResolvedValueOnce(convenorView()).mockResolvedValueOnce({
            ...convenorView(), pendingTotal: 1, pending: [convenorView().pending[1]],
        });
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} onChanged={changed} />);
        const withdraw = await screen.findByRole('button', { name: 'Withdraw the invitation to Mia' });
        fireEvent.click(withdraw);
        expect(confirm).toHaveBeenCalledWith('The invitation to Mia is taken back. You can invite them again.');
        // Its own request, never the member removal (review of #3061).
        await waitFor(() => expect(withdrawGroupInvitation).toHaveBeenCalledWith('g-1', 'pk-mia'));
        expect(removeGroupMember).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByText('Mia')).toBeNull());
        expect(screen.getByText('Nat')).toBeInTheDocument();
        expect(changed).toHaveBeenCalledTimes(1);
        confirm.mockRestore();
    });

    it('withdraws nothing when the question is not agreed to', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the invitation to Nat' }));
        expect(withdrawGroupInvitation).not.toHaveBeenCalled();
        expect(removeGroupMember).not.toHaveBeenCalled();
        expect(screen.getByText('Nat')).toBeInTheDocument();
        confirm.mockRestore();
    });

    it("says the node's words when a withdrawal is refused, and keeps the row", async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        vi.mocked(withdrawGroupInvitation).mockRejectedValue(new Error('Only a group convenor, or the member who sent it, can withdraw an invitation'));
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the invitation to Mia' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('Only a group convenor, or the member who sent it, can withdraw an invitation');
        expect(screen.getByText('Mia')).toBeInTheDocument();
        expect(removeGroupMember).not.toHaveBeenCalled();
        confirm.mockRestore();
    });

    it('when the person has joined since the list was read, says so, removes nobody, and reads the lists again (review of #3061)', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const changed = vi.fn();
        const joined = 'They have already joined the group, so there is no invitation to withdraw. They are in the roster now.';
        vi.mocked(withdrawGroupInvitation).mockRejectedValue(new Error(joined));
        // The node's next answer: Mia accepted, so she is no longer invited (the roster around it shows her as a member).
        vi.mocked(getGroupInvitations).mockResolvedValueOnce(convenorView()).mockResolvedValueOnce({
            ...convenorView(), pendingTotal: 1, pending: [convenorView().pending[1]],
        });
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} onChanged={changed} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the invitation to Mia' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(joined);
        expect(withdrawGroupInvitation).toHaveBeenCalledWith('g-1', 'pk-mia');
        expect(removeGroupMember).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.queryByText('Mia')).toBeNull());
        expect(getGroupInvitations).toHaveBeenCalledTimes(2);
        // The group around it reads itself again too, so Mia shows under the members.
        expect(changed).toHaveBeenCalledTimes(1);
        confirm.mockRestore();
    });

    it('still says "already joined" when the withdrawn person was the ONLY one listed (the list empties on the re-read; second review of #3061)', async () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const joined = 'They have already joined the group, so there is no invitation to withdraw. They are in the roster now.';
        const onlyMia = { ...convenorView(), pendingTotal: 1, pending: [convenorView().pending[0]] };
        vi.mocked(withdrawGroupInvitation).mockRejectedValue(new Error(joined));
        vi.mocked(getGroupInvitations).mockResolvedValueOnce(onlyMia).mockResolvedValueOnce({ ...convenorView(), pendingTotal: 0, pending: [] });
        render(<GroupInvitedList groupId="g-1" myPubkey={ME} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Withdraw the invitation to Mia' }));
        await waitFor(() => expect(getGroupInvitations).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole('alert')).toHaveTextContent(joined);
        expect(screen.queryByText('Mia')).toBeNull();
        expect(removeGroupMember).not.toHaveBeenCalled();
        confirm.mockRestore();
    });
});

describe('on the group sheet, under the members', () => {
    const card = (over: Partial<Group> = {}): Group => ({
        id: 'g-1', name: 'martys group', slug: 'martys-group', category: 'working_group', joinPolicy: 'invite_only',
        description: '', memberCount: 2, createdBy: ME, createdAt: '2026-10-01T00:00:00Z', leadPubkey: ME,
        viewerRole: 'convenor', viewerStatus: 'active', closedAt: null, ...over,
    } as any);
    const roster = [{ groupId: 'g-1', memberPubkey: ME, callsign: 'Cleo', role: 'convenor', status: 'active', joinedAt: '' }];
    const open = (g: Group) => render(<GroupDetailModal group={g} isOpen onClose={() => {}} myPubkey={ME} />);

    beforeEach(() => {
        vi.mocked(getGroup).mockImplementation(async () => card());
        vi.mocked(getGroupMembers).mockImplementation(async () => roster as any);
    });

    it('a member of the group sees the list under the roster', async () => {
        open(card());
        const list = await screen.findByTestId('group-invited-list');
        const rosterHeading = screen.getByRole('heading', { name: /^Roster \(/ });
        expect(rosterHeading.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(within(list).getAllByTestId('group-invited-row')).toHaveLength(2);
    });

    it('someone who is only invited, or on a group its members closed, is not asked for it', async () => {
        vi.mocked(getGroup).mockImplementation(async () => card({ viewerStatus: 'invited', viewerRole: null } as any));
        vi.mocked(getGroupMembers).mockImplementation(async () => [] as any);
        open(card({ viewerStatus: 'invited', viewerRole: null } as any));
        await screen.findByText('martys group');
        cleanup();
        vi.mocked(getGroup).mockImplementation(async () => card({ closedAt: '2026-11-01T00:00:00Z' }));
        vi.mocked(getGroupMembers).mockImplementation(async () => roster as any);
        open(card({ closedAt: '2026-11-01T00:00:00Z' }));
        await screen.findByText('martys group');
        await waitFor(() => expect(getGroupMembers).toHaveBeenCalled());
        expect(getGroupInvitations).not.toHaveBeenCalled();
        expect(screen.queryByTestId('group-invited-list')).toBeNull();
    });
});
