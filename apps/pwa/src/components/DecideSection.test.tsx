import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { DecideSection } from './DecideSection';
import { castDecisionVote } from '../lib/api';

// Only castDecisionVote: the card looks up no separate credits figure; the node checks the cost.
vi.mock('../lib/api', () => ({
    castDecisionVote: vi.fn(async () => ({ success: true, creditsUsed: 9 })),
}));

const decisionCard = (id: string, franchise: '1m1v' | 'quadratic_trade', myVote: any): any => ({
    id,
    authorPubkey: 'author',
    title: `Decision ${id}`,
    description: 'A decision for the test',
    touches: franchise === '1m1v' ? 'member' : 'pool',
    effect: franchise === '1m1v' ? 'grant_voucher' : 'grant_enterprise',
    subject: 'subject',
    params: franchise === '1m1v' ? null : { amount: 50 },
    franchise,
    status: 'open',
    opensAt: '2026-09-18T00:00:00.000Z',
    closesAt: '2099-01-01T00:00:00.000Z',
    gracePeriodEndsAt: null,
    createdAt: '2026-09-18T00:00:00.000Z',
    executedAt: null,
    executionError: null,
    executionReason: null,
    adminHaltedAt: null,
    adminHaltedBy: null,
    adminHaltReason: null,
    updatedAt: '2026-09-18T00:00:00.000Z',
    tally: {
        decisionId: id, status: 'open', totalVoters: 1, quorumRequired: 3, quorumMet: false,
        yesWeight: 1, noWeight: 0, totalWeight: 1, supportRatio: 1, thresholdRequired: 0.6, passed: false,
    },
    myVote,
});

const renderDecide = (canPropose: boolean, decisions: any[] = []) => render(
    <DecideSection
        decisions={decisions}
        activeMembers30d={0}
        identity={{ publicKey: 'viewer', privateKey: 'k', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' }}
        commonsBalance={0}
        onRefresh={async () => {}}
        onOpenPropose={() => {}}
        canPropose={canPropose}
        hasOpenDecision={false}
        activeView="open"
        onChangeView={() => {}}
    />
);

describe('DecideSection wording', () => {
    it('says who can propose in plain words, without the developer term earnedCredit', () => {
        const { container } = renderDecide(false);

        expect(screen.getByText(/Open to anyone who has completed a trade\./)).toBeInTheDocument();
        expect(screen.getByText(/You can propose once you have completed a trade\./)).toBeInTheDocument();
        expect(container.textContent).not.toMatch(/earnedCredit/);
    });
});

describe('DecideSection own vote', () => {
    it('shows how you voted and offers to change it', () => {
        renderDecide(true, [
            decisionCard('m', '1m1v', { support: true, voteCount: 1, creditsUsed: 1, updatedAt: '2026-09-18T01:00:00.000Z' }),
        ]);
        expect(screen.getByText('You voted Yes')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Change to No/ })).toBeEnabled();
        expect(screen.getByRole('button', { name: /Voted Yes/ })).toBeDisabled();
    });

    it('shows the vote count on a quadratic pool Decision', () => {
        renderDecide(true, [
            decisionCard('p', 'quadratic_trade', { support: false, voteCount: 3, creditsUsed: 9, updatedAt: '2026-09-18T01:00:00.000Z' }),
        ]);
        expect(screen.getByText('You voted No (3 votes)')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Change to Yes/ })).toBeEnabled();
    });

    it('reads as a first vote when you have not voted', () => {
        renderDecide(true, [decisionCard('n', '1m1v', null)]);
        expect(screen.queryByText(/You voted/)).toBeNull();
        expect(screen.getByRole('button', { name: /Vote YES/ })).toBeEnabled();
        expect(screen.getByRole('button', { name: /Vote NO/ })).toBeEnabled();
    });
});

describe('DecideSection quadratic cost', () => {
    beforeEach(() => vi.mocked(castDecisionVote).mockClear());

    it('shows the cost of the votes being cast, and no Available figure', () => {
        const { container } = renderDecide(true, [
            decisionCard('p', 'quadratic_trade', { support: false, voteCount: 3, creditsUsed: 9, updatedAt: '2026-09-18T01:00:00.000Z' }),
        ]);
        expect(container.textContent).toMatch(/Vote Count: 3 \(Cost: 9 credits\)/);
        expect(container.textContent).not.toMatch(/Available/);
    });

    it('starts a re-vote at your existing count and leaves the cost check to the node', async () => {
        renderDecide(true, [
            decisionCard('p', 'quadratic_trade', { support: false, voteCount: 3, creditsUsed: 9, updatedAt: '2026-09-18T01:00:00.000Z' }),
        ]);
        fireEvent.click(screen.getByRole('button', { name: /Change to Yes/ }));
        await waitFor(() => expect(castDecisionVote).toHaveBeenCalledWith('p', { voterPubkey: 'viewer', support: true, voteCount: 3 }));
        expect(screen.queryByText(/but you have/)).toBeNull();
    });

    it('shows the node refusing a vote that costs more than your credits', async () => {
        vi.mocked(castDecisionVote).mockRejectedValueOnce(new Error('Insufficient voice credits: 3 votes costs 9 credits, but you have 4'));
        renderDecide(true, [
            decisionCard('p', 'quadratic_trade', { support: false, voteCount: 3, creditsUsed: 9, updatedAt: '2026-09-18T01:00:00.000Z' }),
        ]);
        fireEvent.click(screen.getByRole('button', { name: /Change to Yes/ }));
        expect(await screen.findByText(/Insufficient voice credits: 3 votes costs 9 credits/)).toBeInTheDocument();
    });
});
