import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { ProjectsPage } from './ProjectsPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { Treasury, Group, YourChat } from '../lib/api';
import { getTreasuries, getGroups, getYourGroups, getCommunityMe } from '../lib/api';
import { resetReaderFeaturesOnce } from '../lib/features';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { resolveAvatarUrl } from '../lib/avatar';

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
    getYourGroups: vi.fn(async () => ({ items: [] })),
    getCommunityMe: vi.fn(async () => ({ tier: 'member', features: null })),
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
        resetReaderFeaturesOnce();
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3,
            postCount: 0,
            transactionCount: 0,
            commonsBalance: 100,
            profile: 'local',
            features: { beans: true, enterprises: true, decisions: true } as any,
        });
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] });
        vi.mocked(getGroups).mockResolvedValue([]);
        vi.mocked(getYourGroups).mockResolvedValue({ items: [] });
        vi.mocked(getCommunityMe).mockResolvedValue({ tier: 'member', features: null } as any);
        vi.mocked(resolveAvatarUrl).mockImplementation((url) => url ?? null);
    });

    afterEach(() => {
        resetReaderFeaturesOnce();
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
        await waitFor(() => {
            const chipLabels = within(chipsContainer).getAllByRole('button').map(b => b.textContent?.trim());
            expect(chipLabels).toEqual(['All', '🌱 Projects', '🏛️ Enterprises', '👥 Chat groups']);
        });
        expect(screen.queryByRole('button', { name: 'My groups' })).toBeNull();
    });

    it('only All and Chat groups chips are shown when enterprises are disabled on the node', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3,
            postCount: 0,
            transactionCount: 0,
            commonsBalance: 0,
            profile: 'local',
            features: { beans: false, enterprises: false, decisions: false } as any,
        });

        render(<ProjectsPage identity={me} />);
        const chipsContainer = await screen.findByTestId('group-filter-chips');
        await waitFor(() => {
            const chipLabels = within(chipsContainer).getAllByRole('button').map(b => b.textContent?.trim());
            expect(chipLabels).toEqual(['All', '👥 Chat groups']);
        });
        expect(screen.queryByRole('button', { name: '🌱 Projects' })).toBeNull();
        expect(screen.queryByRole('button', { name: '🏛️ Enterprises' })).toBeNull();
    });

    it('does not render enterprise empty state or proposals when enterprises are disabled on the node', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3,
            postCount: 0,
            transactionCount: 0,
            commonsBalance: 0,
            profile: 'local',
            features: { beans: true, enterprises: false, decisions: false } as any,
        });

        render(<ProjectsPage identity={me} />);
        await screen.findByTestId('group-filter-chips');
        await waitFor(() => {
            expect(screen.queryByText('No enterprises found')).toBeNull();
            for (const title of ['No others yet', 'No projects to back yet', 'No enterprises yet']) expect(screen.queryByText(title)).toBeNull();
            expect(screen.queryByText('Loading enterprises…')).toBeNull();
            expect(screen.queryByText('+ Propose a Project')).toBeNull();
        });
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

        vi.mocked(getTreasuries).mockResolvedValueOnce({
            treasuries: [keptEnterprise, keptProjectLead, unkeptEnterprise],
        });
        vi.mocked(getYourGroups).mockResolvedValueOnce({
            items: [
                {
                    kind: 'enterprise',
                    id: 'treasury-shade',
                    conversationId: 'treasury-shade',
                    name: 'Shade House',
                    role: 'lead',
                    lifecycle: 'bounded',
                    badge: '🌱',
                    avatarUrl: null,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
                {
                    kind: 'enterprise',
                    id: 'treasury-eggs',
                    conversationId: 'treasury-eggs',
                    name: 'Community Eggs',
                    role: 'keeper',
                    lifecycle: 'ongoing',
                    badge: '🏛️',
                    avatarUrl: null,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
            ],
        });

        const onOpenTreasury = vi.fn();
        render(<ProjectsPage identity={me} onOpenTreasury={onOpenTreasury} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(yoursBlock).toBeInTheDocument();

        // Lead kept project is first, then keeper enterprise
        await within(yoursBlock).findByText('Shade House');
        await within(yoursBlock).findByText('Community Eggs');
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

        // Keydown on Manage button stops propagation and does not trigger card default open
        onOpenTreasury.mockClear();
        fireEvent.keyDown(manageButtons[0], { key: 'Enter' });
        expect(onOpenTreasury).not.toHaveBeenCalledWith('treasury-shade');

        // Unkept enterprise is in Find, NOT in Yours
        expect(within(yoursBlock).queryByText('Community Bakery')).toBeNull();
        expect(await screen.findByText('Community Bakery')).toBeInTheDocument();
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

        vi.mocked(getGroups).mockResolvedValueOnce([myGroup, otherGroup]);
        vi.mocked(getYourGroups).mockResolvedValueOnce({
            items: [
                {
                    kind: 'group',
                    id: 'group-garden',
                    conversationId: 'group-garden',
                    name: 'Garden Crew',
                    role: 'convenor',
                    badge: null,
                    avatarUrl: null,
                    category: 'working_group',
                    joinPolicy: 'open',
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
            ],
        });

        const onNavigate = vi.fn();
        render(<ProjectsPage identity={me} onNavigate={onNavigate} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText('Garden Crew')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText('Pottery Guild')).toBeNull();

        // In Find, Pottery Guild is present, but Garden Crew is NOT
        const findSection = await screen.findByTestId('commons-chat-groups');
        expect(await within(findSection).findByText('Pottery Guild')).toBeInTheDocument();
        expect(within(findSection).queryByText('Garden Crew')).toBeNull();

        // Clicking the group in Yours opens its chat
        fireEvent.click(within(yoursBlock).getByText('Garden Crew'));
        expect(onNavigate).toHaveBeenCalledWith('messages', 'group-garden');
    });

    it('Find heading changes dynamically with the chip', async () => {
        render(<ProjectsPage identity={me} />);
        const chipsContainer = await screen.findByTestId('group-filter-chips');

        // Default 'All' chip
        expect(await screen.findByRole('heading', { name: 'Groups, projects and enterprises here' })).toBeInTheDocument();

        // Click '🌱 Projects'
        fireEvent.click(await within(chipsContainer).findByRole('button', { name: '🌱 Projects' }));
        expect(await screen.findByRole('heading', { name: 'Projects to back' })).toBeInTheDocument();

        // Click '🏛️ Enterprises'
        fireEvent.click(await within(chipsContainer).findByRole('button', { name: '🏛️ Enterprises' }));
        expect(await screen.findByRole('heading', { name: 'Enterprises here' })).toBeInTheDocument();

        // Click '👥 Chat groups'
        fireEvent.click(await within(chipsContainer).findByRole('button', { name: '👥 Chat groups' }));
        expect(await screen.findByRole('heading', { name: 'Groups you could join' })).toBeInTheDocument();
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
        expect(await within(findSection).findByText('Chess Club')).toBeInTheDocument();
        expect(within(findSection).getByText('INVITED')).toBeInTheDocument();
    });

    it('a group with pending_approval viewerStatus says Pending and stays in Find even when viewerRole is member', async () => {
        const pendingGroup: Group = {
            id: 'group-debate',
            slug: 'debate',
            createdBy: 'pk-someone',
            name: 'Debate Society',
            category: 'guild',
            joinPolicy: 'request_to_join',
            memberCount: 4,
            viewerStatus: 'pending_approval',
            viewerRole: 'member',
            description: 'Weekly debates',
            createdAt: '2026-01-01T00:00:00Z',
        };

        vi.mocked(getGroups).mockResolvedValue([pendingGroup]);

        render(<ProjectsPage identity={me} />);
        const findSection = await screen.findByTestId('commons-chat-groups');
        expect(await within(findSection).findByText('Debate Society')).toBeInTheDocument();
        expect(within(findSection).getByText('Pending')).toBeInTheDocument();
        expect(within(findSection).queryByText('MEMBER')).toBeNull();
        expect(within(screen.getByTestId('commons-yours')).queryByText('Debate Society')).toBeNull();
    });

    it("a project's lead (bounded row in your-groups, absent from /api/treasuries) sees it under Yours with Manage", async () => {
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] });
        const projectChat: YourChat = {
            kind: 'enterprise',
            id: 'treasury-shade',
            conversationId: 'treasury-shade',
            name: 'Shade House',
            role: 'lead',
            lifecycle: 'bounded',
            badge: '🌱',
            avatarUrl: null,
            readOnly: false,
            unreadCount: 0,
            lastActivityAt: '2026-01-01T00:00:00Z',
        };
        vi.mocked(getYourGroups).mockResolvedValue({ items: [projectChat] });

        const onOpenTreasury = vi.fn();
        render(<ProjectsPage identity={me} onOpenTreasury={onOpenTreasury} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText('Shade House')).toBeInTheDocument();
        expect(within(yoursBlock).getByText('Leader')).toBeInTheDocument();
        expect(within(yoursBlock).getByText('Project')).toBeInTheDocument();

        const manageBtn = await within(yoursBlock).findByRole('button', { name: /Manage Shade House/i });
        expect(manageBtn).toBeInTheDocument();
        fireEvent.click(manageBtn);
        expect(onOpenTreasury).toHaveBeenCalledWith('treasury-shade', 'manage');
    });

    it('shows loading state while Yours reads are pending, never "Nothing of yours yet"', async () => {
        let resolveYourGroups: (value: any) => void;
        vi.mocked(getYourGroups).mockImplementation(() => new Promise((resolve) => {
            resolveYourGroups = resolve;
        }));
        render(<ProjectsPage identity={me} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(within(yoursBlock).getByText('Loading groups...')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText(/Nothing of yours yet/)).toBeNull();

        // Resolve empty
        resolveYourGroups!({ items: [] });
        await waitFor(() => {
            expect(within(yoursBlock).getByText('Nothing of yours yet. Start something with +, or find one below.')).toBeInTheDocument();
            expect(within(yoursBlock).queryByText('Loading groups...')).toBeNull();
        });
    });

    it('shows error state with Retry button on failed read, and clicking Retry reads again', async () => {
        vi.mocked(getYourGroups).mockRejectedValueOnce(new Error('Network error'));
        render(<ProjectsPage identity={me} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText('Could not load your groups.')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText(/Nothing of yours yet/)).toBeNull();

        const retryBtn = within(yoursBlock).getByRole('button', { name: 'Retry' });
        expect(retryBtn).toBeInTheDocument();

        // Now mock success on retry
        vi.mocked(getYourGroups).mockResolvedValueOnce({
            items: [
                {
                    kind: 'enterprise',
                    id: 'treasury-eggs',
                    conversationId: 'treasury-eggs',
                    name: 'Community Eggs',
                    role: 'keeper',
                    lifecycle: 'ongoing',
                    badge: '🏛️',
                    avatarUrl: null,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
            ],
        });

        fireEvent.click(retryBtn);

        await waitFor(() => {
            expect(within(yoursBlock).getByText('Community Eggs')).toBeInTheDocument();
            expect(within(yoursBlock).queryByText('Could not load your groups.')).toBeNull();
        });
    });

    // Deciding review on 0f5ea53e, finding 1: with enterprises off, Yours keeps no enterprise or project (the phone's projects.tsx:71-73).
    it('with enterprises off, Yours shows the member\'s groups but no kept enterprise or project', async () => {
        vi.mocked(communityInfoOnce).mockResolvedValue({
            memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 100, profile: 'local',
            features: { beans: false, enterprises: false, decisions: true } as any,
        });
        vi.mocked(getYourGroups).mockResolvedValue({
            items: [
                { kind: 'enterprise', id: 'treasury-eggs', conversationId: 'treasury-eggs', name: 'Community Eggs', role: 'lead',
                  lifecycle: 'ongoing', badge: '🏛️', avatarUrl: null, readOnly: false, unreadCount: 0, lastActivityAt: '2026-01-01T00:00:00Z' },
                { kind: 'group', id: 'group-garden', conversationId: 'group-garden', name: 'Garden Crew', role: 'convenor', badge: null,
                  avatarUrl: null, category: 'working_group', joinPolicy: 'open', readOnly: false, unreadCount: 0, lastActivityAt: '2026-01-01T00:00:00Z' },
            ] as YourChat[],
        });
        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText('Garden Crew')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText('Community Eggs')).toBeNull();
        expect(within(yoursBlock).queryByRole('button', { name: /Manage/ })).toBeNull();
    });

    // Finding 2: Yours's state is the your-groups read's alone.
    it('your-groups failing while /api/groups works: Yours says it could not load, and draws no fallback rows', async () => {
        const myGroup: Group = {
            id: 'group-garden', slug: 'garden', createdBy: 'pk-someone', name: 'Garden Crew', category: 'working_group',
            joinPolicy: 'open', memberCount: 5, viewerRole: 'convenor', viewerStatus: 'active', description: 'Gardening team',
            createdAt: '2026-01-01T00:00:00Z',
        };
        vi.mocked(getGroups).mockResolvedValueOnce([myGroup]);
        vi.mocked(getYourGroups).mockRejectedValueOnce(new Error('Network error'));
        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText('Could not load your groups.')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText('Garden Crew')).toBeNull();
    });

    it('your-groups empty while /api/groups fails: Yours says "Nothing of yours yet", not "Could not load your groups."', async () => {
        vi.mocked(getGroups).mockRejectedValueOnce(new Error('Network error'));
        vi.mocked(getYourGroups).mockResolvedValueOnce({ items: [] });
        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText(/Nothing of yours yet/)).toBeInTheDocument();
        expect(within(yoursBlock).queryByText('Could not load your groups.')).toBeNull();
    });

    // Finding 3: the Yours group card opens the chat, so its spoken name says the name, the role and that.
    it('a Yours group card is named by the group, its role and "Open chat"', async () => {
        vi.mocked(getYourGroups).mockResolvedValue({
            items: [
                { kind: 'group', id: 'group-garden', conversationId: 'group-garden', name: 'Garden Crew', role: 'convenor', badge: null,
                  avatarUrl: null, category: 'working_group', joinPolicy: 'open', readOnly: false, unreadCount: 0, lastActivityAt: '2026-01-01T00:00:00Z' },
            ] as YourChat[],
        });
        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        const card = await within(yoursBlock).findByRole('button', { name: /^Garden Crew, .+, Open chat →$/ });
        expect(card.getAttribute('aria-label')).not.toMatch(/View details/);
    });

    it('shows "Nothing of yours yet…" only after a successful empty read', async () => {
        vi.mocked(getYourGroups).mockResolvedValue({ items: [] });
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] });
        vi.mocked(getGroups).mockResolvedValue([]);

        render(<ProjectsPage identity={me} />);

        const yoursBlock = await screen.findByTestId('commons-yours');
        expect(await within(yoursBlock).findByText('Nothing of yours yet. Start something with +, or find one below.')).toBeInTheDocument();
        expect(within(yoursBlock).queryByText('Loading groups...')).toBeNull();
        expect(within(yoursBlock).queryByText('Could not load your groups.')).toBeNull();
    });

    it("the kept card's accessible name includes its role, status, and kind", async () => {
        const keptEnterprise: Treasury = {
            publicKey: 'treasury-eggs',
            name: 'Community Eggs',
            callsign: 'eggs',
            balance: 40,
            creditLine: 0,
            liveOffers: 3,
            lifecycle: 'ongoing',
            status: 'active',
            paused: true,
            keepers: [
                { publicKey: me.publicKey, callsign: 'Alice', role: 'lead' },
            ],
        };

        const keptProject: Treasury = {
            publicKey: 'treasury-shade',
            name: 'Shade House',
            callsign: 'shade',
            balance: 500,
            creditLine: 0,
            liveOffers: 0,
            goalAmount: 500,
            currentAmount: 500,
            lifecycle: 'bounded',
            status: 'active',
            keepers: [
                { publicKey: me.publicKey, callsign: 'Alice', role: 'lead' },
            ],
        };

        vi.mocked(getTreasuries).mockResolvedValue({
            treasuries: [keptEnterprise, keptProject],
        });
        vi.mocked(getYourGroups).mockResolvedValue({
            items: [
                {
                    kind: 'enterprise',
                    id: 'treasury-eggs',
                    conversationId: 'treasury-eggs',
                    name: 'Community Eggs',
                    role: 'lead',
                    lifecycle: 'ongoing',
                    badge: '🏛️',
                    avatarUrl: null,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
                {
                    kind: 'enterprise',
                    id: 'treasury-shade',
                    conversationId: 'treasury-shade',
                    name: 'Shade House',
                    role: 'lead',
                    lifecycle: 'bounded',
                    badge: '🌱',
                    avatarUrl: null,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
            ],
        });

        render(<ProjectsPage identity={me} />);

        const yoursBlock = await screen.findByTestId('commons-yours');

        // Eggs card accessible name includes PAUSED, Enterprise, Lead keeper
        const eggsCard = await within(yoursBlock).findByRole('button', {
            name: 'Community Eggs, PAUSED, Enterprise, Lead keeper',
        });
        expect(eggsCard).toBeInTheDocument();

        // Shade House card accessible name includes FUNDED, Project, Leader
        const shadeCard = await within(yoursBlock).findByRole('button', {
            name: 'Shade House, FUNDED, Project, Leader',
        });
        expect(shadeCard).toBeInTheDocument();
    });

    it('Yours heading is an h2 and chips have type="button" with aria-pressed', async () => {
        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        const heading = await within(yoursBlock).findByRole('heading', { level: 2, name: 'Yours' });
        expect(heading).toBeInTheDocument();

        const chipsContainer = await screen.findByTestId('group-filter-chips');
        const allChip = await within(chipsContainer).findByRole('button', { name: 'All' });
        expect(allChip).toHaveAttribute('type', 'button');
        expect(allChip).toHaveAttribute('aria-pressed', 'true');

        const projectsChip = await within(chipsContainer).findByRole('button', { name: '🌱 Projects' });
        expect(projectsChip).toHaveAttribute('type', 'button');
        expect(projectsChip).toHaveAttribute('aria-pressed', 'false');
    });

    it('never calls getYourGroups for a guest and shows clean empty state without error', async () => {
        render(<ProjectsPage identity={me} isMember={false} />);
        await screen.findByRole('heading', { level: 1, name: 'Commons' });
        expect(getYourGroups).not.toHaveBeenCalled();
        expect(screen.queryByText('Could not load your groups.')).toBeNull();
    });

    it('waits while membership is unknown, then calls getYourGroups once for confirmed member', async () => {
        const view = render(<ProjectsPage identity={me} isMember={null} />);
        await screen.findByRole('heading', { level: 1, name: 'Commons' });
        expect(getYourGroups).not.toHaveBeenCalled();

        view.rerender(<ProjectsPage identity={me} isMember={true} />);
        await waitFor(() => expect(getYourGroups).toHaveBeenCalledTimes(1));
    });

    it('does not grant lead status to a suspended lead keeper in summary.keepers', async () => {
        vi.mocked(getYourGroups).mockResolvedValueOnce({
            items: [
                {
                    kind: 'enterprise',
                    id: 'treasury-suspended-lead',
                    conversationId: 'treasury-suspended-lead',
                    name: 'Suspended Lead Org',
                    role: 'keeper',
                    lifecycle: 'ongoing',
                    badge: '🏛️',
                    avatarUrl: null,
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
            ],
        });
        vi.mocked(getTreasuries).mockResolvedValueOnce({
            treasuries: [
                {
                    publicKey: 'treasury-suspended-lead',
                    name: 'Suspended Lead Org',
                    callsign: 'org',
                    balance: 50,
                    creditLine: 0,
                    liveOffers: 1,
                    lifecycle: 'ongoing',
                    status: 'active',
                    keepers: [
                        { publicKey: me.publicKey, role: 'lead', callsign: 'Alice', suspended: true },
                    ],
                },
            ],
        });

        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        const card = await within(yoursBlock).findByRole('button', {
            name: 'Suspended Lead Org, Enterprise, Keeper',
        });
        expect(card).toBeInTheDocument();
        expect(within(card).queryByText('Lead keeper')).toBeNull();
        expect(within(card).getByText('Keeper')).toBeInTheDocument();
    });

    it('falls back to emoji badge when resolveAvatarUrl returns null for an avatar string', async () => {
        vi.mocked(resolveAvatarUrl).mockImplementation((url) => url === 'javascript:alert(1)' ? null : (url ?? null));
        vi.mocked(getYourGroups).mockResolvedValueOnce({
            items: [
                {
                    kind: 'enterprise',
                    id: 'treasury-bad-avatar',
                    conversationId: 'treasury-bad-avatar',
                    name: 'Bad Avatar Org',
                    role: 'keeper',
                    lifecycle: 'ongoing',
                    badge: '🥖',
                    avatarUrl: 'javascript:alert(1)',
                    readOnly: false,
                    unreadCount: 0,
                    lastActivityAt: '2026-01-01T00:00:00Z',
                },
            ],
        });

        render(<ProjectsPage identity={me} />);
        const yoursBlock = await screen.findByTestId('commons-yours');
        const card = await within(yoursBlock).findByRole('button', {
            name: 'Bad Avatar Org, Enterprise, Keeper',
        });
        expect(card).toBeInTheDocument();
        // Fallback emoji is rendered
        expect(within(card).getByText('🥖')).toBeInTheDocument();
        // Broken img tag is not rendered (img has alt="" so query by selector or queryByRole)
        expect(card.querySelector('img')).toBeNull();
    });
});
