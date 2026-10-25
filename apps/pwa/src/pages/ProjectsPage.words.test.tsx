/**
 * The Commons page in the member's language (words S3, web sweep W2): its heading, the pool and voice-credit cards, the
 * section tabs and kind chips, the Groups list (each group's kind, size, join policy and the reader's role, the phone's
 * word() keys), the empty states, the form that proposes a project or an enterprise and its refusals, and the alerts
 * before a Decision can be proposed, drawn in the pseudo-locale `xx`. A group's, project's or enterprise's name, purpose
 * and description are what members wrote: shown as written. The Decide section and the cards have their own words tests
 * (components/Commons.words.test.tsx, the enterprise card's). In English nothing changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

vi.mock('../lib/visitor-lobby-gate', () => ({
    communityInfoOnce: vi.fn(async () => ({ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: {} })),
}));

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getTreasuries: vi.fn(),
    getBalance: vi.fn(async () => ({ balance: 100, floor: -500, commonsBalance: 250, earnedCredit: 12, callsign: 'Me', keeperOf: [], tier: 'contributor' })),
    createEnterprise: vi.fn(async () => ({ success: true })),
    getDecisions: vi.fn(),
    getCommonsBalance: vi.fn(async () => ({ balance: 250 })),
    getAllMembers: vi.fn(async () => []),
    getGroups: vi.fn(),
}));

import { getDecisions, getGroups, getTreasuries } from '../lib/api';
import { ProjectsPage } from './ProjectsPage';

const ME: any = { publicKey: 'me-pk', privateKey: 'k', callsign: 'Me', createdAt: '2026-09-01T00:00:00Z' };

const TREASURIES: any[] = [
    { publicKey: 't1', name: 'Garden Solar Pumps', callsign: 'garden', purpose: 'Solar pumps for the plots.', balance: 150, creditLine: 0, liveOffers: 1,
        goalAmount: 500, currentAmount: 150, deadlineAt: null, lifecycle: 'bounded', status: 'active', avatar: null },
    { publicKey: 't2', name: 'Bread Oven', callsign: 'oven', purpose: 'A shared wood oven.', balance: 40, creditLine: 0, liveOffers: 2,
        goalAmount: null, currentAmount: 0, deadlineAt: null, lifecycle: 'ongoing', status: 'active', avatar: null },
];
const group = (over: Record<string, unknown>): any => ({
    id: 'g1', name: 'Seed Savers', slug: 'seed', description: 'We swap seeds.', category: 'working_group', createdBy: 'x',
    joinPolicy: 'request_to_join', createdAt: '2026-09-01T00:00:00Z', memberCount: 3, viewerRole: 'convenor', viewerStatus: 'active', ...over,
});
const GROUPS = [
    group({}),
    group({ id: 'g2', name: 'Choir', description: 'We sing.', category: 'social', joinPolicy: 'open', memberCount: 1, viewerRole: null, viewerStatus: 'pending_approval' }),
    group({ id: 'g3', name: 'Night Owls', description: '', category: 'book_club', joinPolicy: 'invite_only', memberCount: 0, viewerRole: 'observer' }),
];
/**
 * What members wrote: the groups' and enterprises' names, handles, purposes and descriptions; a kind the node named that
 * this build doesn't know.
 */
const OTHERS = ['Garden Solar Pumps', '@garden', 'Solar pumps for the plots.', 'Bread Oven', '@oven', 'A shared wood oven.', 'Seed Savers', 'We swap seeds.', 'Choir', 'We sing.', 'Night Owls', 'book club'];

beforeEach(() => {
    vi.mocked(getTreasuries).mockResolvedValue({ treasuries: TREASURIES } as never);
    vi.mocked(getGroups).mockResolvedValue(GROUPS as never);
    vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: { voiceCredits: 9.6, hasCompletedTrade: true } } as never);
});
afterEach(() => { cleanup(); backToEnglish(); vi.restoreAllMocks(); });

describe('the Commons page in the pseudo-locale', () => {
    it('the heading, cards, tabs, chips, the Groups list and the enterprises: every word came through t()', async () => {
        await showIn('xx');
        render(<ProjectsPage identity={ME} />);
        expect(await screen.findByText('Seed Savers')).toBeInTheDocument();
        await screen.findByText('Garden Solar Pumps');
        expect(screen.getByRole('heading', { level: 1 }).textContent?.trim()).toBe(xx('Commons'));
        expect(within(screen.getByTestId('commons-section-tabs')).getByText(xx('Decide'))).toBeInTheDocument();
        expect(within(screen.getByTestId('group-filter-chips')).getAllByRole('button').map((b) => b.textContent))
            .toEqual(['All', '🌱 Projects', '🏛️ Enterprises', '👥 Chat groups'].map((w) => xx(w)));
        expect(screen.getByText(xx('{n} members').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getByText(xx('Pending'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('View details for group {name}').replace('{name}', 'Seed Savers') })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(30);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('nothing yet: no groups, no enterprises, and Yours empty', async () => {
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] } as never);
        vi.mocked(getGroups).mockResolvedValue([] as never);
        await showIn('xx');
        render(<ProjectsPage identity={ME} />);
        expect(await screen.findByText(xx('Nothing of yours yet. Start something with +, or find one below.'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
    });

    it('an invited group in the pseudo-locale shows INVITED', async () => {
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] } as never);
        vi.mocked(getGroups).mockResolvedValue([{
            id: 'g1',
            name: 'Mushroom Growers',
            category: 'working_group',
            joinPolicy: 'open',
            memberCount: 2,
            viewerStatus: 'invited',
            description: 'Fungi',
            createdAt: '2026-01-01T00:00:00Z',
        }] as never);
        await showIn('xx');
        render(<ProjectsPage identity={ME} />);
        expect(await screen.findByText(xx('INVITED'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
    });

    it('the form that proposes a project or an enterprise, and each refusal', async () => {
        vi.mocked(getTreasuries).mockResolvedValue({ treasuries: [] } as never);
        await showIn('xx');
        render(<ProjectsPage identity={ME} />);
        fireEvent.click(await screen.findByRole('button', { name: xx('+ Propose a Project') }));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByRole('heading').textContent).toBe(xx('Start a project'));
        expect(within(dialog).getByRole('button', { name: xx('Close dialog') })).toBeInTheDocument();
        expect(within(dialog).getByPlaceholderText(xx('e.g. {amount}').replace('{amount}', '500'))).toBeInTheDocument();
        expect(bypassing(dialog)).toEqual([]);
        const send = async () => { await act(async () => { fireEvent.submit(dialog.querySelector('form')!); }); };
        await send();
        expect(within(dialog).getByText(xx('Title is required'))).toBeInTheDocument();
        fireEvent.change(within(dialog).getByPlaceholderText(xx('e.g. Community Tool Shed or Shade House')), { target: { value: 'Shade House' } });
        await send();
        expect(within(dialog).getByText(xx('Purpose statement is required (docs/the-commons.md §2.1)'))).toBeInTheDocument();
        fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'Shade for seedlings' } });
        await send();
        expect(within(dialog).getByText(xx('A project needs a goal in Beans'))).toBeInTheDocument();
        expect(bypassing(dialog)).toEqual([]);
        fireEvent.click(within(dialog).getByText(xx('🏛️ Enterprise')));
        expect(within(dialog).queryByText(xx('Goal Amount (🫘 Beans)'))).toBeNull();
        expect(bypassing(dialog)).toEqual([]);
    });

    it('the alerts before a Decision can be proposed', async () => {
        const said: string[] = [];
        vi.spyOn(window, 'alert').mockImplementation((m) => { said.push(String(m)); });
        vi.mocked(getDecisions).mockResolvedValue({ decisions: [], myPoolVoting: null, canPropose: false } as never);
        await showIn('xx');
        render(<ProjectsPage identity={ME} initialSection="decide" />);
        await waitFor(() => expect(getDecisions).toHaveBeenCalled());
        await screen.findByText(xx('You can propose once you have completed a trade.'));
        fireEvent.click(screen.getByRole('button', { name: (n) => n.includes(xx('Start something')) }));
        const sheet = screen.getByRole('dialog');
        fireEvent.click(within(sheet).getByRole('button', { name: (n) => n.includes(xx('Decision')) }));
        expect(said).toEqual([xx('You can propose a Decision once you have completed a trade.')]);
        expect(bypassing(document.body, { said })).toEqual([]);
    });
});

describe('the Commons page in English', () => {
    it('reads as it always has', async () => {
        render(<ProjectsPage identity={ME} />);
        await screen.findByText('Seed Savers');
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('🌱 The Commons');
        await waitFor(() => expect(screen.getByText('250.00 🫘')).toBeInTheDocument());
        const cards = screen.getAllByRole('button', { name: /^View details for group / });
        expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual(['View details for group Seed Savers', 'View details for group Choir', 'View details for group Night Owls']);
        expect(within(cards[0]).getByText(/🏷️/).textContent).toBe('🏷️ working group');
        expect(within(cards[0]).getByText('3 members')).toBeInTheDocument();
        expect(within(cards[0]).getByText('convenor')).toBeInTheDocument();
        expect(within(cards[0]).getByText('Join: request to join')).toBeInTheDocument();
        expect(within(cards[1]).getByText('1 member')).toBeInTheDocument();
        expect(within(cards[1]).getByText('Pending')).toBeInTheDocument();
        expect(within(cards[2]).getByText('0 members')).toBeInTheDocument();
        expect(within(cards[2]).getByText(/🏷️/).textContent).toBe('🏷️ book club');
        expect(within(cards[2]).getByText('Join: invite only')).toBeInTheDocument();
        expect(screen.getByText(/A group is a place for some people/).textContent).toBe('👥 Groups: A group is a place for some people rather than everyone. Projects and enterprises hold Beans; chat groups hold none. Being in a group does not change your trust or your vote.');
    });
});
