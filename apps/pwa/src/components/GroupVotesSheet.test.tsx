// Where a group's vote line lands when the group itself is refused (#1784 review B1, the invite-only case of its zz-s3b-1784 L
// check): removed from an invite-only group mid-vote, the group read is 404 but the vote's roll still holds them, so the line
// lands on the votes, with Yes / No, never on Commons.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const G = 'b78da72e-773f-4425-914a-8bfbd4e4130a';
const card = {
    id: 'd1', authorPubkey: 'aa'.repeat(32), title: 'Close it', description: 'Because the group needs to decide this.', effect: 'close_group',
    subject: null, params: null, status: 'open', opensAt: new Date().toISOString(), scopeKind: 'group', scopeId: G,
    closesAt: new Date(Date.now() + 6 * 86400_000).toISOString(), tally: { voted: 1, roll: 5, quorumRequired: 3, thresholdRequired: 0.6 }, myVote: null,
};
const answers: Record<string, any> = {};
vi.mock('../lib/api', () => ({
    getGroup: vi.fn(async () => { if (!answers.group) throw new Error('Not found'); return answers.group; }),
    getGroupDecisions: vi.fn(async () => answers.decisions ?? null),
    proposeGroupDecision: vi.fn(), voteGroupDecision: vi.fn(async () => ({ success: true })),
}));
import { landOnGroup, GroupVotesSheet } from './GroupVotesSheet';

beforeEach(() => { for (const k of Object.keys(answers)) delete answers[k]; });

describe('landOnGroup', () => {
    it('opens the group when it reads', async () => {
        answers.group = { id: G, name: 'Open' };
        expect(await landOnGroup(G)).toEqual({ kind: 'group', group: answers.group });
    });

    it('removed from an invite-only group mid-vote: the group is 404, the votes still read, so it lands on the votes', async () => {
        answers.decisions = { decisions: [{ ...card, canVote: true }], canPropose: false, onRoll: true, watching: false, rollSize: 4, closedAt: null };
        expect(await landOnGroup(G)).toEqual({ kind: 'votes', groupId: G, canVote: true });
    });

    it('left mid-vote, or every vote closed: it still lands on the votes, and says none takes theirs (#1794 N8)', async () => {
        answers.decisions = { decisions: [{ ...card, canVote: false }], canPropose: false, onRoll: false, watching: false, rollSize: 4, closedAt: null };
        expect(await landOnGroup(G)).toEqual({ kind: 'votes', groupId: G, canVote: false });
    });

    it('neither reads (never in the group, or no vote left): Commons', async () => {
        expect(await landOnGroup(G)).toEqual({ kind: 'commons' });
        answers.decisions = { decisions: [], canPropose: false, onRoll: false, watching: false, rollSize: 4, closedAt: null };
        expect(await landOnGroup(G)).toEqual({ kind: 'commons' });
    });
});

describe('GroupVotesSheet', () => {
    it('draws the votes from the id alone, with Yes / No on a vote whose roll holds the reader', async () => {
        answers.decisions = { decisions: [{ ...card, canVote: true }], canPropose: false, onRoll: true, watching: false, rollSize: 4, closedAt: null };
        render(<GroupVotesSheet groupId={G} canVote={true} myPubkey={'cc'.repeat(32)} onClose={() => {}} />);
        expect(await screen.findByText('Close it')).toBeTruthy();
        expect(screen.getByText(/so you can still vote on them/)).toBeTruthy();
        expect(screen.getByRole('button', { name: "Vote Yes on Close it" })).toBeTruthy();
        expect(screen.getByRole('button', { name: "Vote No on Close it" })).toBeTruthy();
        expect(screen.queryByText(/You watch this group/)).toBeNull();
    });

    it('no vote takes theirs: the line says only what is true, and no Yes / No (#1794 N8)', async () => {
        answers.decisions = { decisions: [{ ...card, canVote: false }], canPropose: false, onRoll: false, watching: false, rollSize: 4, closedAt: null };
        render(<GroupVotesSheet groupId={G} canVote={false} myPubkey={'cc'.repeat(32)} onClose={() => {}} />);
        expect(await screen.findByText('Close it')).toBeTruthy();
        expect(screen.getByText('You\'re not in this group now. These are the votes you were part of.')).toBeTruthy();
        expect(screen.queryByText(/can still vote/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Vote Yes on Close it' })).toBeNull();
    });

    it('names the subject and the author from the card, with no roster to name them from (#1794 N7)', async () => {
        const named = { ...card, title: 'New lead', effect: 'replace_lead_convenor', subject: 'bb'.repeat(32), canVote: true,
            names: { ['aa'.repeat(32)]: 'Ada', ['bb'.repeat(32)]: 'Bo' } };
        answers.decisions = { decisions: [named], canPropose: false, onRoll: true, watching: false, rollSize: 4, closedAt: null };
        render(<GroupVotesSheet groupId={G} canVote={true} myPubkey={'cc'.repeat(32)} onClose={() => {}} />);
        expect(await screen.findByText(/Make Bo the lead convenor/)).toBeTruthy();
        expect(screen.getByText(/Proposed by Ada/)).toBeTruthy();
        expect(screen.queryByText(/a former member/)).toBeNull();
    });

    it('someone the card cannot name (an account deleted) is "someone in the group", never "a former member" (#1794 N7)', async () => {
        const unnamed = { ...card, title: 'New lead', effect: 'replace_lead_convenor', subject: 'bb'.repeat(32), canVote: true, names: {} };
        answers.decisions = { decisions: [unnamed], canPropose: false, onRoll: true, watching: false, rollSize: 4, closedAt: null };
        render(<GroupVotesSheet groupId={G} canVote={true} myPubkey={'cc'.repeat(32)} onClose={() => {}} />);
        expect(await screen.findByText(/Make someone in the group the lead convenor/)).toBeTruthy();
        expect(screen.getByText(/Proposed by someone in the group/)).toBeTruthy();
        expect(screen.queryByText(/a former member/)).toBeNull();
    });
});
