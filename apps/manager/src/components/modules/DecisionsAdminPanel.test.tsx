import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DecisionsAdminPanel } from './DecisionsAdminPanel';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';

const node: NodeProfile = { id: 'test-node', name: 'Test Node', url: 'https://test-node.local', adminPassword: 'pw' };

const keepVote: nodeClient.AdminDecisionItem = {
    id: 'dec-keep-1',
    title: "Keep Troll's suspension?",
    description: 'An admin suspended Troll on 2026-09-19. Keep the suspension? Reason given: threats',
    effect: 'keep_suspension',
    touches: 'member',
    status: 'open',
    subject: 'pk-troll',
    subjectName: 'Troll',
    params: { memberName: 'Troll' },
    opensAt: '2026-09-19T00:00:00.000Z',
    closesAt: '2026-09-26T00:00:00.000Z',
    gracePeriodEndsAt: null,
    tally: { totalVoters: 2, electorate: 20, quorumRequired: 6, quorumMet: false, yesWeight: 1, noWeight: 1, supportRatio: 0.5, thresholdRequired: 0.6 },
};

describe('DecisionsAdminPanel', () => {
    beforeEach(() => vi.restoreAllMocks());

    it('shows loading indicator while fetching decisions', async () => {
        let resolveFetch: (val: nodeClient.AdminDecisionItem[]) => void = () => {};
        const fetchPromise = new Promise<nodeClient.AdminDecisionItem[]>((resolve) => {
            resolveFetch = resolve;
        });
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockReturnValue(fetchPromise);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(screen.getByText('Loading Community Decisions...')).toBeInTheDocument();

        resolveFetch([keepVote]);
        expect(await screen.findByText("Keep Troll's suspension?")).toBeInTheDocument();
        expect(screen.queryByText('Loading Community Decisions...')).not.toBeInTheDocument();
    });

    it('lists open Decisions with totals only', async () => {
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([keepVote]);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByText("Keep Troll's suspension?")).toBeInTheDocument();
        expect(screen.getByText('2 of 6 votes needed · Yes 1 · No 1')).toBeInTheDocument();
        expect(screen.getByText('About: Troll')).toBeInTheDocument();
    });

    it('will not halt without a written reason of 10+ characters, then sends it', async () => {
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([keepVote]);
        const halt = vi.spyOn(nodeClient, 'haltDecision').mockResolvedValue({ success: true });
        render(<DecisionsAdminPanel activeNode={node} />);
        fireEvent.click(await screen.findByText('Halt this Decision'));

        expect(screen.getByText('Halting this vote lifts the suspension straight away.')).toBeInTheDocument();
        const confirm = screen.getByRole('button', { name: 'Halt Decision' });
        expect(confirm).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'too short' } });
        expect(confirm).toBeDisabled();

        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: '  Suspended the wrong account  ' } });
        expect(confirm).not.toBeDisabled();
        fireEvent.click(confirm);

        await waitFor(() => expect(halt).toHaveBeenCalledWith('https://test-node.local', 'dec-keep-1', 'Suspended the wrong account', 'pw', undefined));
    });

    it('shows the node refusal when a halt fails', async () => {
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([keepVote]);
        vi.spyOn(nodeClient, 'haltDecision').mockRejectedValue(new Error('Cannot halt decision with status failed'));
        render(<DecisionsAdminPanel activeNode={node} />);
        fireEvent.click(await screen.findByText('Halt this Decision'));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'A long enough reason' } });
        fireEvent.click(screen.getByRole('button', { name: 'Halt Decision' }));
        expect(await screen.findByText('Cannot halt decision with status failed')).toBeInTheDocument();
    });
});
