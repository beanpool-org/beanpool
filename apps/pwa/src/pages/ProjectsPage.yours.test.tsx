import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Treasury, Group } from '../lib/api';
import { getTreasuries, getGroups } from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({
        memberCount: 3,
        postCount: 0,
        transactionCount: 0,
        commonsBalance: 100,
        profile: 'local',
        features: { beans: true, enterprises: true, decisions: true },
    })),
}));

vi.mock('../lib/api', () => ({
    getTreasuries: vi.fn(async () => ({ treasuries: [] })),
    getBalance: vi.fn(async () => ({
        balance: 100,
        floor: 0,
        commonsBalance: 100,
        earnedCredit: 10,
        callsign: 'Alice',
        keeperOf: [],
        tier: 'contributor' as any,
    })),
    getDecisions: vi.fn(async () => ({ decisions: [], myPoolVoting: null })),
    getCommonsBalance: vi.fn(async () => ({ balance: 100 })),
    getAllMembers: vi.fn(async () => []),
    getGroups: vi.fn(async () => []),
    createEnterprise: vi.fn(async () => ({ success: true })),
}));

const me: BeanPoolIdentity = {
    publicKey: 'my-public-key-1111',
    privateKey: 'privkey-1111',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00Z',
};

const otherMemberKey = 'other-public-key-2222';

describe('ProjectsPage - Commons S4 Yours first, chips parity, INVITED (Fable 5.1 §3.5, §5 S4)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('page title is "Commons" (drops "The" and the 🌱 before it)', async () => {
        render(<ProjectsPage identity={me} />);
        const heading = await screen.findByRole('heading', { level: 1 });
        expect(heading.textContent?.trim()).toBe('Commons');
    });

    it('explainer card is deleted (day-zero-no-legacy)', async () => {
        render(<ProjectsPage identity={me} />);
        await waitFor(() => expect(screen.queryByText(/A group is a place for some people rather than everyone/)).toBeNull());
    });

    it('four chips in the phone order, and no "My groups" chip', async () => {
        render(<ProjectsPage identity={me} />);
        const chipsContainer = await screen.findByTestId('group-filter-chips');
        const chipLabels = within(chipsContainer).getAllByRole('button').map(b => b.textContent?.trim());
        expect(chipLabels).toEqual(['All', '🌱 Projects', '🏛️ Enterprises', '👥 Chat groups']);
        expect(screen.queryByRole('button', { name: 'My groups' })).toBeNull();
    });

    it('a treasury whose keepers include the viewer is drawn under Yours first with its role word and a Manage link; lead first', async () => {
        const keptEnterprise: Treasury = {
            publicKey: 'treasury-eggs',
            name: 'Community Eggs',
            callsign: 'eggs',
            balance: 40,
            creditLine: 0,
            liveOffers: 3,
            lifecycle: 'ongoing',
            status: 'active',
            keepers: [
                { publicKey: me.publicKey, callsign: 'Alice', role: 'keeper' },
            ],
        };

        const keptProjectLead: Treasury = {
            publicKey: 'treasury-shade',
            name: 'Shade House',
            callsign: 'shade',
            balance: 120,
            creditLine: 0,
            liveOffers: 0,
            goalAmount: 500,
            currentAmount: 120,
            lifecycle: 'bounded',
            status: 'active',
            keepers: [
                { publicKey: me.publicKey, callsign: 'Alice', role: 'lead' },
            ],
        };

        const unkeptEnterprise: Treasury = {
            publicKey: 'treasury-bakery',
            name: 'Community Bakery',
            callsign: 'bakery',
            balance: 200,
            creditLine: 0,
            liveOffers: 1,
            lifecycle: 'ongoing',
            status: 'active',
            keepers: [
                { publicKey: otherMemberKey, callsign: 'Bob', role: 'lead' },
            ],
        };

        vi.mocked(getTreasuries).mockResolvedValue({
            treasuries: [keptEnterprise, keptProjectLead, unkeptEnterprise],
        });

        const onOpenTreasury = vi.fn();
        render(<ProjectsPage identity={me} onOpenTreasury={onOpenTreasury} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(yoursBlock).toBeInTheDocument();

        // Lead kept project is first, then keeper enterprise
        const yoursTitles = within(yoursBlock).getAllByRole('heading', { level: 4 }).map(h => h.textContent?.trim());
        expect(yoursTitles).toEqual(['Shade House', 'Community Eggs']);

        // Check role words
        expect(within(yoursBlock).getByText('Leader')).toBeInTheDocument();
        expect(within(yoursBlock).getByText('Keeper')).toBeInTheDocument();

        // Check Manage link / button
        const manageButtons = within(yoursBlock).getAllByRole('button', { name: /Manage/ });
        expect(manageButtons.length).toBeGreaterThanOrEqual(2);

        // Clicking Manage opens enterprise with manage requested
        fireEvent.click(manageButtons[0]);
        expect(onOpenTreasury).toHaveBeenCalledWith('treasury-shade', 'manage');

        // Unkept enterprise is in Find, NOT in Yours
        expect(within(yoursBlock).queryByText('Community Bakery')).toBeNull();
        expect(screen.getByText('Community Bakery')).toBeInTheDocument();
    });

    it('a group with viewerRole is under Yours, not in Find, and opens chat', async () => {
        const myGroup: Group = {
            id: 'group-garden',
            slug: 'garden',
            createdBy: 'pk-someone',
            name: 'Garden Crew',
            category: 'working_group',
            joinPolicy: 'open',
            memberCount: 5,
            viewerRole: 'convenor',
            viewerStatus: 'active',
            description: 'Gardening team',
            createdAt: '2026-01-01T00:00:00Z',
        };

        const otherGroup: Group = {
            id: 'group-pottery',
            slug: 'pottery',
            createdBy: 'pk-someone',
            name: 'Pottery Guild',
            category: 'guild',
            joinPolicy: 'open',
            memberCount: 12,
            description: 'Clay and ceramics',
            createdAt: '2026-01-01T00:00:00Z',
        };

        vi.mocked(getGroups).mockResolvedValue([myGroup, otherGroup]);

        const onNavigate = vi.fn();
        render(<ProjectsPage identity={me} onNavigate={onNavigate} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(within(yoursBlock).getByText('Garden Crew')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText('Pottery Guild')).toBeNull();

        // In Find, Pottery Guild is present, but Garden Crew is NOT
        const findSection = screen.getByTestId('commons-chat-groups');
        expect(within(findSection).getByText('Pottery Guild')).toBeInTheDocument();
        expect(within(findSection).queryByText('Garden Crew')).toBeNull();

        // Clicking the group in Yours opens its chat
        fireEvent.click(within(yoursBlock).getByText('Garden Crew'));
        expect(onNavigate).toHaveBeenCalledWith('messages', 'group-garden');
    });

    it('Find heading changes dynamically with the chip', async () => {
        render(<ProjectsPage identity={me} />);
        await waitFor(() => expect(screen.getByTestId('group-filter-chips')).toBeInTheDocument());

        // Default 'All' chip
        expect(screen.getByRole('heading', { name: 'Groups, projects and enterprises here' })).toBeInTheDocument();

        // Click '🌱 Projects'
        fireEvent.click(screen.getByRole('button', { name: '🌱 Projects' }));
        expect(screen.getByRole('heading', { name: 'Projects to back' })).toBeInTheDocument();

        // Click '🏛️ Enterprises'
        fireEvent.click(screen.getByRole('button', { name: '🏛️ Enterprises' }));
        expect(screen.getByRole('heading', { name: 'Enterprises here' })).toBeInTheDocument();

        // Click '👥 Chat groups'
        fireEvent.click(screen.getByRole('button', { name: '👥 Chat groups' }));
        expect(screen.getByRole('heading', { name: 'Groups you could join' })).toBeInTheDocument();
    });

    it('Yours empty line variants (Beans/enterprises on vs off)', async () => {
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] });
        vi.mocked(getGroups).mockResolvedValue([]);

        const { unmount } = render(<ProjectsPage identity={me} />);
        expect(await screen.findByText('Nothing of yours yet. Start something with +, or find one below.')).toBeInTheDocument();
        unmount();

        // When enterprises are off
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3,
            postCount: 0,
            transactionCount: 0,
            commonsBalance: 0,
            profile: 'local',
            features: { beans: false, enterprises: false, decisions: false } as any,
        });

        render(<ProjectsPage identity={me} />);
        expect(await screen.findByText('No groups of yours yet. Start one with +, or join one below.')).toBeInTheDocument();
    });

    it('an invited group card says INVITED (even if viewerRole is member)', async () => {
        const invitedGroup: Group = {
            id: 'group-chess',
            slug: 'chess',
            createdBy: 'pk-someone',
            name: 'Chess Club',
            category: 'social',
            joinPolicy: 'invite_only',
            memberCount: 8,
            viewerStatus: 'invited',
            viewerRole: 'member',
            description: 'Weekly games',
            createdAt: '2026-01-01T00:00:00Z',
        };

        vi.mocked(getGroups).mockResolvedValue([invitedGroup]);

        render(<ProjectsPage identity={me} />);
        const findSection = await screen.findByTestId('commons-chat-groups');
        expect(within(findSection).getByText('Chess Club')).toBeInTheDocument();
        expect(within(findSection).getByText('INVITED')).toBeInTheDocument();
    });

    it('a group with pending_approval viewerStatus says Pending and stays in Find even when viewerRole is member', async () => {
        const pendingGroup: Group = {
            id: 'group-debate',
            slug: 'debate',
            createdBy: 'pk-someone',
            name: 'Debate Society',
            category: 'cultural',
            joinPolicy: 'apply',
            memberCount: 4,
            viewerStatus: 'pending_approval',
            viewerRole: 'member',
            description: 'Weekly debates',
            createdAt: '2026-01-01T00:00:00Z',
        };

        vi.mocked(getGroups).mockResolvedValue([pendingGroup]);

        render(<ProjectsPage identity={me} />);
        const findSection = await screen.findByTestId('commons-chat-groups');
        expect(within(findSection).getByText('Debate Society')).toBeInTheDocument();
        expect(within(findSection).getByText('Pending')).toBeInTheDocument();
        expect(within(findSection).queryByText('MEMBER')).toBeNull();
        expect(screen.queryByTestId('commons-yours')).toBeNull();
    });
});
