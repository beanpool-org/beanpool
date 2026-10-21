/**
 * Tests for InvitePeopleSheet:
 * - Active members say "In the group" (ticked, disabled)
 * - Invited members say "Invited" (disabled, clock outline icon)
 * - Pending members say "Asked to join" (disabled)
 * - Removed members stay invitable
 * - Accessible names for each state
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { InvitePeopleSheet } from './InvitePeopleSheet';
import { alreadyInGroup } from '../lib/group-invite';
import { getMembersWhole } from '../lib/members-on-demand';

const ME = 'pk-me';
const ALICE = 'pk-alice';
const BOB = 'pk-bob';
const CHARLIE = 'pk-charlie';
const DAVE = 'pk-dave';
const EVE = 'pk-eve';

vi.mock('../lib/members-on-demand', () => ({
    useMembersOnDemand: () => false,
    useMemberSearch: () => ({ found: null, state: 'idle' }),
    getMembersWhole: vi.fn(),
    isMembersOnDemandRefusal: () => false,
    MEMBERS_SEARCH_MIN_CHARS: 2,
}));

vi.mock('../lib/api', () => ({
    inviteGroupMember: vi.fn().mockResolvedValue({ success: true, member: {} }),
}));

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(getMembersWhole).mockResolvedValue([
        { publicKey: ME, callsign: 'Me' },
        { publicKey: ALICE, callsign: 'Alice' },
        { publicKey: BOB, callsign: 'Bob' },
        { publicKey: CHARLIE, callsign: 'Charlie' },
        { publicKey: DAVE, callsign: 'Dave' },
        { publicKey: EVE, callsign: 'Eve' },
    ] as any);
});

describe('InvitePeopleSheet member statuses and accessibility', () => {
    it('shows one active, one invited, and one pending member with their three labels, none selectable', async () => {
        render(
            <InvitePeopleSheet
                groupId="g-test"
                groupName="Test Group"
                existing={new Set([ALICE])}
                invited={new Set([BOB])}
                pending={new Set([CHARLIE])}
                myPubkey={ME}
                onClose={() => {}}
            />
        );

        const sheet = await screen.findByTestId('invite-people-sheet');
        await within(sheet).findByText('Dave');

        const aliceRow = within(sheet).getByText('Alice').closest('label')!;
        const bobRow = within(sheet).getByText('Bob').closest('label')!;
        const charlieRow = within(sheet).getByText('Charlie').closest('label')!;

        // 1. Labels
        expect(within(aliceRow).getByText('In the group')).toBeInTheDocument();
        expect(within(bobRow).getByText('Invited')).toBeInTheDocument();
        expect(within(charlieRow).getByText('Asked to join')).toBeInTheDocument();

        // 2. Disabled & checked states
        const aliceBox = aliceRow.querySelector('input')!;
        const bobBox = bobRow.querySelector('input')!;
        const charlieBox = charlieRow.querySelector('input')!;

        expect(aliceBox).toBeDisabled();
        expect(aliceBox).toBeChecked();

        expect(bobBox).toBeDisabled();
        expect(bobBox).not.toBeChecked();
        expect(bobRow.querySelector('[data-icon="clock-outline"]')).toBeInTheDocument();

        expect(charlieBox).toBeDisabled();
        expect(charlieBox).not.toBeChecked();

        // 3. Accessible names for each state
        expect(aliceBox.getAttribute('aria-label')).toBe('Alice, already in the group');
        expect(bobBox.getAttribute('aria-label')).toBe('Bob, already invited');
        expect(charlieBox.getAttribute('aria-label')).toBe('Charlie, asked to join');

        // 4. None selectable: clicking input or label does not select them
        fireEvent.click(aliceBox);
        fireEvent.click(bobBox);
        fireEvent.click(charlieBox);
        fireEvent.click(aliceRow);
        fireEvent.click(bobRow);
        fireEvent.click(charlieRow);

        const inviteButton = within(sheet).getByRole('button', { name: 'Pick people to invite' });
        expect(inviteButton).toBeDisabled();

        // 5. Dave is invitable and selectable
        const daveBox = within(sheet).getByText('Dave').closest('label')!.querySelector('input')!;
        expect(daveBox).toBeEnabled();
        expect(daveBox.getAttribute('aria-label')).toBe('Dave');
        fireEvent.click(daveBox);
        expect(within(sheet).getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
    });

    it('works when fed directly with alreadyInGroup(members) split object; removed members stay invitable', async () => {
        const roster = [
            { memberPubkey: ALICE, status: 'active' },
            { memberPubkey: BOB, status: 'invited' },
            { memberPubkey: CHARLIE, status: 'pending_approval' },
            { memberPubkey: DAVE, status: 'removed' },
        ];
        const split = alreadyInGroup(roster);

        render(
            <InvitePeopleSheet
                groupId="g-test"
                groupName="Test Group"
                existing={split}
                myPubkey={ME}
                onClose={() => {}}
            />
        );

        const sheet = await screen.findByTestId('invite-people-sheet');
        await within(sheet).findByText('Dave');

        // Alice is active
        expect(within(sheet).getByText('In the group')).toBeInTheDocument();
        // Bob is invited
        expect(within(sheet).getByText('Invited')).toBeInTheDocument();
        // Charlie is pending
        expect(within(sheet).getByText('Asked to join')).toBeInTheDocument();

        // Dave is removed, so Dave has NO status label and is invitable
        const daveRow = within(sheet).getByText('Dave').closest('label')!;
        expect(within(daveRow).queryByText('In the group')).toBeNull();
        expect(within(daveRow).queryByText('Invited')).toBeNull();
        expect(within(daveRow).queryByText('Asked to join')).toBeNull();

        const daveBox = daveRow.querySelector('input')!;
        expect(daveBox).toBeEnabled();
        fireEvent.click(daveBox);
        expect(within(sheet).getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
    });
});
