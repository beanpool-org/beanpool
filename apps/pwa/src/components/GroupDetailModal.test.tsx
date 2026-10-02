import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { GroupDetailModal } from './GroupDetailModal';
import { getGroup, getGroupMembers, getGroupSuccession, type Group, type GroupMember } from '../lib/api';

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
    updateGroup: vi.fn(),
    // The quiet-lead vote reads the group's succession on open (2026-09-23). These groups are healthy — the lead
    // is not eligible and no vote was ever held — so the panel draws nothing and the roster below is unchanged.
    // GroupSuccessionPanel.test.tsx is where the panel itself is covered.
    getGroupSuccession: vi.fn().mockResolvedValue({
        silence: {
            convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0,
            isSilent: false, isEligible: false, electorate: 'convenors',
        },
        proposals: [],
        canPropose: false,
    }),
    proposeGroupSuccession: vi.fn(),
    voteGroupSuccession: vi.fn(),
    isRouteMissing: (e: unknown) => (e as { status?: number } | null)?.status === 404
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

    /**
     * Where the quiet-lead vote lives (2026-09-23): the group's own info screen, beside the roster it is about.
     * The panel's own rules are covered in GroupSuccessionPanel.test.tsx; what is checked here is that this
     * screen shows it at all — and that a healthy group's screen is untouched.
     */
    it('shows the quiet-lead vote beside the roster when the lead is eligible, and nothing when they are not', async () => {
        await open(CONVENOR);
        expect(screen.queryByText(/Choosing a new lead convenor/)).toBeNull();

        vi.mocked(getGroupSuccession).mockResolvedValue({
            silence: {
                convenorPubkey: LEAD, convenorCallsign: 'Marty Party2', lastActiveAt: '2026-08-10T00:00:00.000Z',
                daysInactive: 44.6, isSilent: true, isEligible: true, electorate: 'convenors',
            },
            proposals: [],
            canPropose: true,
        });
        await open(CONVENOR);
        expect(await screen.findByText(/Choosing a new lead convenor/)).toBeInTheDocument();
        expect(screen.getByText(/Marty Party2 hasn't been active for 44 days/)).toBeInTheDocument();
    });
});

/**
 * A roster's faces come from the node's URL for each photo (#1478): the roster sends `/api/avatar/<key>?size=thumb&v=…`,
 * with the member-only key `&k=…` on the global node, never the photo. The web app is served by its node, so the URL
 * opens there as it is, as the member list's does.
 */
describe("GroupDetailModal roster's faces", () => {
    const LEAD = 'a'.repeat(64);
    const ASKING = 'b'.repeat(64);
    const SHIPPED = 'c'.repeat(64);
    const NONE = 'd'.repeat(64);
    const url = (pk: string) => `/api/avatar/${pk}?size=thumb&v=1a2b3c4d&k=AbCdEfGhIjKlMnOpQrSt_-`;

    const roster: GroupMember[] = [
        { groupId: 'group-1', memberPubkey: LEAD, callsign: 'Lena', role: 'convenor', status: 'active', joinedAt: '2026-01-01T00:00:00.000Z', avatarUrl: url(LEAD) },
        { groupId: 'group-1', memberPubkey: SHIPPED, callsign: 'Sam', role: 'member', status: 'active', joinedAt: '2026-01-02T00:00:00.000Z', avatarUrl: 'bundled://leaf' },
        { groupId: 'group-1', memberPubkey: NONE, callsign: 'Nell', role: 'member', status: 'active', joinedAt: '2026-01-03T00:00:00.000Z' },
        { groupId: 'group-1', memberPubkey: ASKING, callsign: 'Asha', role: 'member', status: 'pending_approval', joinedAt: '2026-01-04T00:00:00.000Z', avatarUrl: url(ASKING) },
    ];
    const group: Group = {
        id: 'group-1', name: 'Faces', slug: 'faces', category: 'social', joinPolicy: 'request_to_join',
        createdBy: LEAD, createdAt: '2026-01-01T00:00:00.000Z', leadPubkey: LEAD, leadCallsign: 'Lena',
    };

    beforeEach(() => {
        vi.mocked(getGroup).mockResolvedValue({ ...group, viewerRole: 'convenor', viewerStatus: 'active' } as Group);
        vi.mocked(getGroupMembers).mockResolvedValue(roster);
    });

    it("shows each member's and each request's photo from its URL, a shipped picture from the app, and initials for none", async () => {
        const { container } = render(<GroupDetailModal group={group} isOpen={true} onClose={() => {}} myPubkey={LEAD} />);
        await waitFor(() => expect(screen.getByText('Nell')).toBeInTheDocument());
        await waitFor(() => expect(screen.getByText('Asha')).toBeInTheDocument());
        const srcs = Array.from(container.ownerDocument.querySelectorAll('img')).map(i => i.getAttribute('src'));
        expect(srcs).toContain(url(LEAD));
        expect(srcs).toContain(url(ASKING));
        expect(srcs).toContain('/avatars/avatar_leaf.jpg');
        expect(srcs.filter(src => src?.startsWith('data:'))).toEqual([]);
        // No photo: the initial, as before.
        expect(screen.getByText('N')).toBeInTheDocument();
    });
});

describe('GroupDetailModal invite-only card loading (#1496)', () => {
    it('shows the full description when the roster answers 403 and the card answers with the full description', async () => {
        const fullDescription = 'This is the full unabbreviated description of the invite-only group that explains all its details and rules.';
        const previewDescription = 'This is the preview of the description...';

        const previewGroup: Group = {
            id: 'group-invite-1',
            name: 'Invite Only Circle',
            slug: 'invite-only-circle',
            category: 'social',
            joinPolicy: 'invite_only',
            description: previewDescription,
            memberCount: 5,
            createdBy: 'pk-lead',
            createdAt: '2026-01-01T00:00:00Z',
        };

        const cardGroup: Group = {
            ...previewGroup,
            description: fullDescription,
        };

        vi.mocked(getGroup).mockResolvedValue(cardGroup);
        vi.mocked(getGroupMembers).mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));

        render(
            <GroupDetailModal
                group={previewGroup}
                isOpen={true}
                onClose={() => {}}
                myPubkey="pk-invitee"
            />
        );

        // When the roster is refused (403), the card must still load and show the full description
        expect(await screen.findByText(fullDescription)).toBeInTheDocument();
        expect(screen.queryByText(previewDescription)).toBeNull();
    });
});

