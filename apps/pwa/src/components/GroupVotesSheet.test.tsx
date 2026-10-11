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
        expect(await landOnGroup(G)).toEqual({ kind: 'votes', groupId: G });
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
        render(<GroupVotesSheet groupId={G} myPubkey={'cc'.repeat(32)} onClose={() => {}} />);
        expect(await screen.findByText('Close it')).toBeTruthy();
        expect(screen.getByRole('button', { name: "Vote Yes on Close it" })).toBeTruthy();
        expect(screen.getByRole('button', { name: "Vote No on Close it" })).toBeTruthy();
        expect(screen.queryByText(/You watch this group/)).toBeNull();
    });
});
