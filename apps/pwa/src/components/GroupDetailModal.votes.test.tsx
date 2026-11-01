// Where Home's vote line lands (#1784 review B1, N1, ported from its zz-1784-roll check): the real GroupDetailModal and
// GroupDecisions, fed what the node answers (test-decisions-group section 7): a member removed mid-vote, one made an observer
// mid-vote, and one who joined mid-vote. Yes / No follow each vote's canVote, the vote's own roll, not the group's roll now.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const ME = 'cc'.repeat(32);
const card = {
    id: 'd1', authorPubkey: 'aa'.repeat(32), title: 'Close it', description: 'Because the group needs to decide this.', effect: 'close_group',
    subject: null, params: null, status: 'open', opensAt: new Date().toISOString(), scopeKind: 'group', scopeId: G,
    closesAt: new Date(Date.now() + 6 * 86400_000).toISOString(), tally: { voted: 1, roll: 5, quorumRequired: 3, thresholdRequired: 0.6 }, myVote: null,
};
const answers: Record<string, any> = {};
vi.mock('../lib/api', () => ({
    getGroupDecisions: vi.fn(async () => answers.decisions),
    proposeGroupDecision: vi.fn(async () => ({ success: true })),
    voteGroupDecision: vi.fn(async () => { if (answers.voteError) throw new Error(answers.voteError); return { success: true }; }),
    getGroup: vi.fn(async () => answers.group),
    getGroupMembers: vi.fn(async () => answers.members),
    joinGroup: vi.fn(), removeGroupMember: vi.fn(), approveGroupMember: vi.fn(), setGroupMemberRole: vi.fn(), handOverGroupLead: vi.fn(), updateGroup: vi.fn(),
    getGroupSuccession: vi.fn().mockResolvedValue({ silence: { convenorPubkey: null, convenorCallsign: null, lastActiveAt: null, daysInactive: 0, isSilent: false, isEligible: false, electorate: 'convenors' }, proposals: [], canPropose: false }),
    proposeGroupSuccession: vi.fn(), voteGroupSuccession: vi.fn(),
    isRouteMissing: () => false,
}));
import { PLACE_CIRCLE_WORDS, t } from '@beanpool/core';
import { GroupDetailModal } from './GroupDetailModal';
import * as api from '../lib/api';

const base = { id: G, name: 'Removal open', slug: 'r', category: 'guild', joinPolicy: 'open', description: '', memberCount: 4, createdBy: 'll'.repeat(32), createdAt: '2026-08-01T00:00:00Z', leadPubkey: 'll'.repeat(32) };
const roster = (meRow: any) => [
    { groupId: G, memberPubkey: 'll'.repeat(32), callsign: 'L', role: 'convenor', status: 'active' },
    { groupId: G, memberPubkey: 'aa'.repeat(32), callsign: 'A', role: 'member', status: 'active' },
    { groupId: G, memberPubkey: 'bb'.repeat(32), callsign: 'B', role: 'member', status: 'active' },
    ...(meRow ? [meRow] : []),
];

beforeEach(() => { for (const k of Object.keys(answers)) delete answers[k]; vi.mocked(api.voteGroupDecision).mockClear(); });

async function open() {
    render(<GroupDetailModal group={base as any} isOpen onClose={() => {}} myPubkey={ME} />);
    await waitFor(() => expect(api.getGroupMembers).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
}

describe("a closed group's info (#1794 N9, MP6)", () => {
    const me = { groupId: G, memberPubkey: ME, callsign: 'C', role: 'member', status: 'active' };
    it('a member of an open group sees the quiet-lead panel; of a closed group, not (the node refuses its vote, #1784 N3)', async () => {
        answers.group = { ...base, viewerStatus: 'active', viewerRole: 'member' };
        answers.members = roster(me);
        answers.decisions = { decisions: [], canPropose: true, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt: null };
        vi.mocked(api.getGroupSuccession).mockClear();
        await open();
        await waitFor(() => expect(api.getGroupSuccession).toHaveBeenCalled());
    });
    it('a finished circle says it finished: it closed by itself, and no vote did it', async () => {
        const closedAt = new Date().toISOString();
        answers.group = { ...base, kind: 'circle', closedAt, viewerStatus: 'active', viewerRole: 'member' };
        answers.members = roster(me);
        answers.decisions = { decisions: [], canPropose: false, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt };
        render(<GroupDetailModal group={{ ...base, kind: 'circle', closedAt } as any} isOpen onClose={() => {}} myPubkey={ME} />);
        const note = await screen.findByTestId('group-closed-note');
        expect(note).toHaveTextContent(t(PLACE_CIRCLE_WORDS.closed));
        expect(note.textContent).not.toMatch(/vote/i);
    });
    it('a finished circle says one true thing on day 31: the closed note, and nothing about 30 days above it', async () => {
        const closedAt = new Date().toISOString();
        const circle = { people: 3, starting: null, doneAt: new Date(Date.now() - 31 * 86_400_000).toISOString(), community: { key: 'k', name: 'Thrissur Commons', url: 'https://thrissur.beanpool.org', acceptingKnocks: true } };
        answers.group = { ...base, kind: 'circle', closedAt, circle, viewerStatus: 'active', viewerRole: 'member' };
        answers.members = roster(me);
        answers.decisions = { decisions: [], canPropose: false, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt };
        render(<GroupDetailModal group={{ ...base, kind: 'circle', closedAt } as any} isOpen onClose={() => {}} myPubkey={ME} />);
        expect(await screen.findByTestId('circle-card-done')).toHaveTextContent('Thrissur Commons');
        expect(screen.getByTestId('group-closed-note')).toHaveTextContent(t(PLACE_CIRCLE_WORDS.closed));
        expect(document.body.textContent).not.toContain(t(PLACE_CIRCLE_WORDS.done));
    });

    it('closed: no quiet-lead panel, so no succession read', async () => {
        const closedAt = new Date().toISOString();
        answers.group = { ...base, closedAt, viewerStatus: 'active', viewerRole: 'member' };
        answers.members = roster(me);
        answers.decisions = { decisions: [], canPropose: false, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt };
        vi.mocked(api.getGroupSuccession).mockClear();
        render(<GroupDetailModal group={{ ...base, closedAt } as any} isOpen onClose={() => {}} myPubkey={ME} />);
        await waitFor(() => expect(api.getGroupMembers).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 50));
        expect(api.getGroupSuccession).not.toHaveBeenCalled();
    });
});

describe("the vote where Home's line lands (#1784 review B1)", () => {
    it('removed mid-vote (node: on the frozen roll, vote 200): the sheet shows the vote with Yes / No', async () => {
        answers.group = { ...base, viewerStatus: 'removed', viewerRole: null };
        answers.members = roster(null);
        answers.decisions = { decisions: [{ ...card, canVote: true }], canPropose: false, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt: null };
        await open();
        const block = screen.queryByTestId('group-decisions');
        expect(block).not.toBeNull();
        expect(screen.queryByRole('button', { name: /Vote Yes/ })).not.toBeNull();
    });

    it('demoted to observer mid-vote (node: vote 200, Home line shown): the sheet offers Yes / No', async () => {
        answers.group = { ...base, viewerStatus: 'active', viewerRole: 'observer' };
        answers.members = roster({ groupId: G, memberPubkey: ME, callsign: 'D', role: 'observer', status: 'active' });
        answers.decisions = { decisions: [{ ...card, canVote: true }], canPropose: false, rollSize: 3, onRoll: true, watching: false, nameable: [], closedAt: null };
        await open();
        expect(screen.queryByText(/You watch this group/)).toBeNull();
        expect(screen.queryByRole('button', { name: /Vote Yes/ })).not.toBeNull();
    });

    it('joined mid-vote (node: vote 400 not on this roll): the sheet does not offer Yes / No', async () => {
        answers.group = { ...base, viewerStatus: 'active', viewerRole: 'member' };
        answers.members = roster({ groupId: G, memberPubkey: ME, callsign: 'J', role: 'member', status: 'active' });
        answers.decisions = { decisions: [{ ...card, canVote: false }], canPropose: true, rollSize: 4, onRoll: true, watching: false, nameable: [], closedAt: null };
        answers.voteError = "Only the group's members and convenors on this vote's roll can vote on it. Observers watch.";
        await open();
        const yes = screen.queryByRole('button', { name: /Vote Yes/ });
        expect(yes).toBeNull();
        expect(screen.queryByTestId('group-decisions')).not.toBeNull();
    });
});
