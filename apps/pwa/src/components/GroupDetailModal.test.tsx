import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GroupDetailModal } from './GroupDetailModal';
import { getGroup, getGroupMembers, type Group, type GroupMember } from '../lib/api';

vi.mock('../lib/api', () => ({
    getGroup: vi.fn().mockResolvedValue({
        id: 'group-1',
        name: 'Local Food Co-op',
        category: 'working_group',
        joinPolicy: 'open',
        description: 'A community food sharing group',
        memberCount: 5,
        viewerStatus: 'none',
        viewerRole: 'member'
    }),
    getGroupMembers: vi.fn().mockResolvedValue([]),
    joinGroup: vi.fn(),
    removeGroupMember: vi.fn(),
    approveGroupMember: vi.fn(),
    setGroupMemberRole: vi.fn(),
    handOverGroupLead: vi.fn(),
    updateGroup: vi.fn()
}));

describe('GroupDetailModal Accessibility', () => {
    const mockGroup: Group = {
        id: 'group-1',
        name: 'Local Food Co-op',
        slug: 'local-food-co-op',
        category: 'working_group',
        joinPolicy: 'open',
        description: 'A community food sharing group',
        memberCount: 5,
        createdBy: 'pk-1',
        createdAt: '2026-01-01T00:00:00Z'
    };

    it('renders modal dialog with aria-labelledby linked to group title ID', () => {
        render(
            <GroupDetailModal
                group={mockGroup}
                isOpen={true}
                onClose={() => {}}
            />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-labelledby', 'group-detail-title');

        const title = screen.getByRole('heading', { name: 'Local Food Co-op' });
        expect(title).toHaveAttribute('id', 'group-detail-title');
    });

    it('renders close button with type="button" and focus ring classes', () => {
        render(
            <GroupDetailModal
                group={mockGroup}
                isOpen={true}
                onClose={() => {}}
            />
        );

        const closeBtn = screen.getByRole('button', { name: 'Close' });
        expect(closeBtn).toHaveAttribute('type', 'button');
        expect(closeBtn.className).toContain('focus-visible:ring-2');
    });
});

/**
 * The roster as it is actually drawn (lead convenor, 2026-09-23). Damo's report was that the UI offered him
 * "Remove Marty Party2 from martys group?" — so it is the rendered rows, not only the predicate, that have to be
 * right. group-roster.test.ts covers the rules; this covers the wiring of them into the roster.
 */
describe('GroupDetailModal roster and the lead convenor', () => {
    const LEAD = 'pk-marty';
    const CONVENOR = 'pk-damo';
    const MEMBER = 'pk-zed';

    const roster: GroupMember[] = [
        { groupId: 'group-1', memberPubkey: LEAD, callsign: 'Marty Party2', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z' },
        { groupId: 'group-1', memberPubkey: CONVENOR, callsign: 'Damo', role: 'convenor', status: 'active', joinedAt: '2026-01-02T00:00:00.000Z' },
        { groupId: 'group-1', memberPubkey: MEMBER, callsign: 'Zed', role: 'member', status: 'active', joinedAt: '2026-01-03T00:00:00.000Z' },
    ];

    const groupWithLead: Group = {
        id: 'group-1',
        name: 'martys group',
        slug: 'martys-group',
        category: 'social',
        joinPolicy: 'open',
        createdBy: LEAD,
        createdAt: '2026-01-01T00:00:00.000Z',
        leadPubkey: LEAD,
        leadCallsign: 'Marty Party2',
    };

    beforeEach(() => {
        vi.mocked(getGroup).mockResolvedValue({ ...groupWithLead, viewerRole: 'convenor', viewerStatus: 'active' } as Group);
        vi.mocked(getGroupMembers).mockResolvedValue(roster);
    });

    /** Render as `viewer` and wait for the roster to arrive. */
    async function open(viewer: string) {
        render(<GroupDetailModal group={groupWithLead} isOpen={true} onClose={() => {}} myPubkey={viewer} />);
        await waitFor(() => expect(screen.getByText('Zed')).toBeInTheDocument());
    }

    it('names the lead convenor in group info, and never calls them an owner', async () => {
        await open(CONVENOR);
        expect(screen.getByText(/Lead convenor:/)).toBeInTheDocument();
        expect(screen.getAllByText('Marty Party2').length).toBeGreaterThan(0);
        expect(document.body.textContent).not.toMatch(/owner/i);
    });

    it('offers a convenor no Remove and no Role on the lead, or on another convenor', async () => {
        await open(CONVENOR);
        // The bug: this button existed.
        expect(screen.queryByRole('button', { name: /Remove Marty Party2/ })).toBeNull();
        expect(screen.queryByRole('combobox', { name: /Role for Marty Party2/ })).toBeNull();
        // Their own row offers nothing either — leaving is the Leave Group button.
        expect(screen.queryByRole('button', { name: /Remove Damo/ })).toBeNull();
        // A member is still theirs to manage.
        expect(screen.getByRole('button', { name: /Remove Zed/ })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: /Role for Zed/ })).toBeInTheDocument();
        // And no hand-over: they do not hold the lead.
        expect(screen.queryByRole('button', { name: /the lead convenor/ })).toBeNull();
    });

    it('offers the lead Remove, Role and Make lead on a convenor', async () => {
        await open(LEAD);
        expect(screen.getByRole('button', { name: /Remove Damo/ })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: /Role for Damo/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Make Damo the lead convenor/ })).toBeInTheDocument();
        // Never on their own row.
        expect(screen.queryByRole('button', { name: /Remove Marty Party2/ })).toBeNull();
    });

    it('shows a plain member no controls at all', async () => {
        vi.mocked(getGroup).mockResolvedValue({ ...groupWithLead, viewerRole: 'member', viewerStatus: 'active' } as Group);
        await open(MEMBER);
        expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
        expect(screen.queryByRole('combobox', { name: /^Role for / })).toBeNull();
    });

    it('marks exactly one row Lead', async () => {
        await open(CONVENOR);
        expect(screen.getAllByText('Lead')).toHaveLength(1);
    });
});
