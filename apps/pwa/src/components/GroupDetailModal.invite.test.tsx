/**
 * "Invite people" on the web's group sheet (15 Oct, Marty: the web sheet for his invite-only group had no way to add
 * anyone). The phone's InvitePeopleSheet, groups decision 8: shown to exactly whom the node lets invite (an active
 * convenor, the group open to change, not muted), one POST per person picked, members already in left out, a partial
 * failure said in plain words, the roster read again after.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { GroupDetailModal } from './GroupDetailModal';
import { getGroup, getGroupMembers, getCommunityMe, inviteGroupMember, getMembers, joinGroup, type Group } from '../lib/api';

const ME = 'pk-marty';
const BEN = 'pk-ben';
const CAT = 'pk-cat';
const DEE = 'pk-dee';
const EVE = 'pk-eve';

let viewerRole: 'convenor' | 'member' = 'convenor';
let closedAt: string | null = null;
let muted = false;

vi.mock('../lib/members-on-demand', async () => {
    // The whole read goes to the api's getMembers below, as the module's own does.
    const api = await import('../lib/api');
    return {
        useMembersOnDemand: () => false,
        useMemberSearch: () => ({ found: null, state: 'idle' }),
        getMembersWhole: () => api.getMembers(),
        isMembersOnDemandRefusal: () => false,
        MEMBERS_SEARCH_MIN_CHARS: 2,
    };
});

vi.mock('../lib/api', () => ({
    getGroupDecisions: vi.fn(async () => null),
    proposeGroupDecision: vi.fn(), voteGroupDecision: vi.fn(),
    getGroup: vi.fn(),
    getGroupMembers: vi.fn(),
    getCommunityMe: vi.fn(),
    getMembers: vi.fn(),
    inviteGroupMember: vi.fn(),
    joinGroup: vi.fn(), removeGroupMember: vi.fn(), approveGroupMember: vi.fn(), setGroupMemberRole: vi.fn(),
    handOverGroupLead: vi.fn(), updateGroup: vi.fn(),
    getGroupSuccession: vi.fn().mockResolvedValue({
        silence: { convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0, isSilent: false, isEligible: false, electorate: 'convenors' },
        proposals: [], canPropose: false,
    }),
    proposeGroupSuccession: vi.fn(), voteGroupSuccession: vi.fn(),
    isRouteMissing: (e: unknown) => (e as { status?: number } | null)?.status === 404,
}));

const card = (): Group => ({
    id: 'g-1', name: 'martys group', slug: 'martys-group', category: 'working_group', joinPolicy: 'invite_only',
    description: '', memberCount: 2, createdBy: ME, createdAt: '2026-10-01T00:00:00Z', leadPubkey: ME,
    viewerRole, viewerStatus: 'active', closedAt,
} as any);

const roster = () => [
    { groupId: 'g-1', memberPubkey: ME, callsign: 'Marty', role: viewerRole, status: 'active', joinedAt: '' },
    { groupId: 'g-1', memberPubkey: BEN, callsign: 'Ben', role: 'member', status: 'active', joinedAt: '' },
    { groupId: 'g-1', memberPubkey: CAT, callsign: 'Cat', role: 'member', status: 'invited', joinedAt: '' },
];

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    viewerRole = 'convenor';
    closedAt = null;
    muted = false;
    vi.mocked(getGroup).mockImplementation(async () => card());
    vi.mocked(getGroupMembers).mockImplementation(async () => roster() as any);
    vi.mocked(getCommunityMe).mockImplementation(async () => ({ mute: { muted, until: null } }) as any);
    vi.mocked(getMembers).mockResolvedValue([
        { publicKey: ME, callsign: 'Marty' }, { publicKey: BEN, callsign: 'Ben' }, { publicKey: CAT, callsign: 'Cat' },
        { publicKey: DEE, callsign: 'Dee' }, { publicKey: EVE, callsign: 'Eve' }, { publicKey: 'SYSTEM', callsign: 'System' },
    ] as any);
    vi.mocked(inviteGroupMember).mockResolvedValue({ success: true, member: {} as any });
});

const open = () => render(<GroupDetailModal group={card()} isOpen onClose={() => {}} myPubkey={ME} />);

describe('Invite people on the web group sheet', () => {
    it("a convenor of an invite-only group sees it; a member doesn't", async () => {
        open();
        expect(await screen.findByTestId('group-invite-people')).toHaveTextContent('Invite people');
        cleanup();
        viewerRole = 'member';
        open();
        await screen.findByText('Ben');
        await waitFor(() => expect(getCommunityMe).toHaveBeenCalled());
        expect(screen.queryByTestId('group-invite-people')).toBeNull();
    });

    it('never in a closed group, and never for a muted convenor (the node refuses both)', async () => {
        closedAt = '2026-10-10T00:00:00Z';
        open();
        await screen.findByText('Ben');
        expect(screen.queryByTestId('group-invite-people')).toBeNull();
        cleanup();
        closedAt = null;
        muted = true;
        open();
        await screen.findByText('Ben');
        await waitFor(() => expect(getCommunityMe).toHaveBeenCalled());
        expect(screen.queryByTestId('group-invite-people')).toBeNull();
    });

    it('lists the community, leaves members already in it unpickable, and sends one call per person picked', async () => {
        open();
        fireEvent.click(await screen.findByTestId('group-invite-people'));
        const sheet = await screen.findByTestId('invite-people-sheet');
        await within(sheet).findByText('Dee');
        expect(within(sheet).queryByText('Marty')).toBeNull();
        expect(within(sheet).queryByText('System')).toBeNull();
        const box = (name: string) => within(sheet).getByText(name).closest('label')!.querySelector('input')!;
        expect(box('Ben')).toBeDisabled();
        expect(box('Cat')).toBeDisabled();
        fireEvent.click(box('Dee'));
        fireEvent.click(box('Eve'));
        fireEvent.click(within(sheet).getByRole('button', { name: 'Invite 2 people' }));
        await waitFor(() => expect(screen.queryByTestId('invite-people-sheet')).toBeNull());
        expect(vi.mocked(inviteGroupMember).mock.calls.map(c => c.slice(0, 2)).sort()).toEqual([['g-1', DEE], ['g-1', EVE]]);
        // The roster is read again after a send.
        await waitFor(() => expect(vi.mocked(getGroupMembers).mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it('a partial failure is said in plain words, naming who was not invited, and the sheet stays', async () => {
        vi.mocked(inviteGroupMember).mockImplementation(async (_g, pk) => {
            if (pk === EVE) throw new Error('offline');
            return { success: true, member: {} as any };
        });
        open();
        fireEvent.click(await screen.findByTestId('group-invite-people'));
        const sheet = await screen.findByTestId('invite-people-sheet');
        fireEvent.click((await within(sheet).findByText('Dee')).closest('label')!.querySelector('input')!);
        fireEvent.click(within(sheet).getByText('Eve').closest('label')!.querySelector('input')!);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Invite 2 people' }));
        const note = await within(sheet).findByTestId('invite-partial-failure');
        expect(note.textContent).toBe('1 sent. Not sent: Eve. Try again in a moment.');
        expect(inviteGroupMember).toHaveBeenCalledTimes(2);
        // Only the one that failed stays picked, ready to send again.
        expect(within(sheet).getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
    });

    it('search by name narrows the list', async () => {
        open();
        fireEvent.click(await screen.findByTestId('group-invite-people'));
        const sheet = await screen.findByTestId('invite-people-sheet');
        await within(sheet).findByText('Dee');
        fireEvent.change(within(sheet).getByRole('searchbox'), { target: { value: 'ev' } });
        expect(within(sheet).queryByText('Dee')).toBeNull();
        expect(within(sheet).getByText('Eve')).toBeInTheDocument();
    });

    it('the person invited can accept on the web, even in an invite-only group (a join: the node makes the row active)', async () => {
        vi.mocked(getGroup).mockImplementation(async () => ({ ...card(), viewerRole: 'member', viewerStatus: 'invited' }) as any);
        vi.mocked(getGroupMembers).mockRejectedValue(Object.assign(new Error('Join the group to see who is here'), { code: 'join_to_see' }));
        vi.mocked(joinGroup).mockResolvedValue({ success: true, member: {} as any });
        render(<GroupDetailModal group={{ ...card(), viewerRole: 'member', viewerStatus: 'invited' } as any} isOpen onClose={() => {}} myPubkey={CAT} />);
        const accept = await screen.findByTestId('group-accept-invite');
        expect(accept).toHaveTextContent('Accept invitation');
        expect(screen.queryByText('Invite Only')).toBeNull();
        expect(screen.queryByTestId('group-invite-people')).toBeNull();
        fireEvent.click(accept);
        await waitFor(() => expect(joinGroup).toHaveBeenCalledWith('g-1'));
    });

    // Review of #1979, N1: without the roster the sheet can't tell who is in or asking, and an invitation to someone who
    // asked admits them at once. The card alone (convenor, active) offers nothing.
    it('a roster read that fails (a busy node) offers no Invite people, though the card says convenor', async () => {
        vi.mocked(getGroupMembers).mockRejectedValue(Object.assign(new Error('The node is busy. Try again in a moment.'), { status: 503 }));
        open();
        await screen.findByText('martys group');
        await waitFor(() => expect(getGroupMembers).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByText('Loading members...')).toBeNull());
        expect(screen.queryByTestId('group-invite-people')).toBeNull();
    });

    // Review of #1979, N2: a suspended convenor is shown the button (the web can't read the suspension) and the node
    // refuses; the note says the node's words, never "Try again in a moment", which would not be true.
    it("a refusal (403) is said in the node's words, UNAUTHORIZED taken off", async () => {
        vi.mocked(inviteGroupMember).mockRejectedValue(Object.assign(
            new Error('UNAUTHORIZED: Your account is suspended, so you cannot act as a convenor until the suspension ends. You are still a convenor.'),
            { status: 403 }));
        open();
        fireEvent.click(await screen.findByTestId('group-invite-people'));
        const sheet = await screen.findByTestId('invite-people-sheet');
        fireEvent.click((await within(sheet).findByText('Dee')).closest('label')!.querySelector('input')!);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Invite 1 person' }));
        const note = await within(sheet).findByTestId('invite-partial-failure');
        expect(note.textContent).toBe('0 sent. Not sent: Dee. Your account is suspended, so you cannot act as a convenor until the suspension ends. You are still a convenor.');
    });

    // Review of #1979, N3: the sheet sits over the group's own aria-modal sheet (components/dialog-focus.ts).
    it('focus goes to the sheet, Tab stays inside it, Escape closes only it, and focus returns to Invite people', async () => {
        open();
        const opener = await screen.findByTestId('group-invite-people');
        opener.focus();
        fireEvent.click(opener);
        const sheet = await screen.findByTestId('invite-people-sheet');
        const heading = within(sheet).getByRole('heading', { name: 'Invite people' });
        await waitFor(() => expect(document.activeElement).toBe(heading));
        await within(sheet).findByText('Dee');
        // Tab from the last control (Invite button, disabled until a pick: the last enabled one is a checkbox) goes round.
        const inside = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
        inside[inside.length - 1].focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(inside[0]);
        expect(sheet.contains(document.activeElement)).toBe(true);
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByTestId('invite-people-sheet')).toBeNull());
        // The group's sheet stays open, and focus is back on what opened the invite sheet.
        expect(screen.getByRole('heading', { name: 'martys group' })).toBeInTheDocument();
        expect(document.activeElement).toBe(screen.getByTestId('group-invite-people'));
    });
});
