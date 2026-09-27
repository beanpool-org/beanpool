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

/** An emergency suspension made with formal Decisions off (the global node): no vote, it lifts by itself at closesAt. */
const noVoteSuspension: nodeClient.AdminDecisionItem = {
    ...keepVote,
    id: 'dec-novote-1',
    title: 'Troll is suspended until 2026-09-26',
    description: 'An admin suspended Troll on 2026-09-19. Community votes are switched off on this node, so the suspension lifts by itself on 2026-09-26, or sooner if a moderator lifts it. Reason given: threats',
    params: { memberName: 'Troll', noVote: true },
    tally: { totalVoters: 0, electorate: 20, quorumRequired: 6, quorumMet: false, yesWeight: 0, noWeight: 0, supportRatio: 0, thresholdRequired: 0.6 },
};

const removalInGrace: nodeClient.AdminDecisionItem = {
    ...keepVote,
    id: 'dec-remove-1',
    title: 'Remove Spammer',
    effect: 'remove_member',
    status: 'execution_pending_grace',
    subject: 'pk-spammer',
    subjectName: 'Spammer',
    params: null,
    gracePeriodEndsAt: '2026-10-03T00:00:00.000Z',
    tally: { totalVoters: 8, electorate: 20, quorumRequired: 5, quorumMet: true, yesWeight: 7, noWeight: 1, supportRatio: 0.875, thresholdRequired: 0.66 },
};

const until = (iso: string) => new Date(iso).toLocaleDateString();
const VOTE_WORDS = /votes? needed|Keep suspension\?|Open votes|Halt this Decision|Halting this vote/;

describe('DecisionsAdminPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(true);
    });

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

    it('keeps the vote words for a vote on a node with Decisions on', async () => {
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([keepVote]);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByText("Keep Troll's suspension?")).toBeInTheDocument();
        expect(screen.getByText('Keep suspension?')).toBeInTheDocument();
        expect(screen.getByText(`Closes ${until(keepVote.closesAt)}`)).toBeInTheDocument();
        expect(screen.getByText('Community Decisions (1)')).toBeInTheDocument();
        expect(screen.getByText('Open votes and removals waiting out their 7 days. Halting stops one; your reason is shown to members.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Halt this Decision' })).toBeInTheDocument();
    });

    it('calls a suspension made without a vote a suspension, with no vote count (Decisions off)', async () => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([noVoteSuspension]);
        const halt = vi.spyOn(nodeClient, 'haltDecision').mockResolvedValue({ success: true });
        render(<DecisionsAdminPanel activeNode={node} />);

        const row = await screen.findByTestId('admin-decision-row');
        expect(row).toHaveTextContent('Troll is suspended');
        expect(row).toHaveTextContent(`Suspended until ${until(noVoteSuspension.closesAt)}`);
        expect(row).toHaveTextContent('No vote. It lifts by itself on that day, or sooner if you lift it.');
        expect(row.textContent).not.toMatch(VOTE_WORDS);
        expect(row.textContent).not.toMatch(/\d+ of \d+|Yes \d|No \d/);

        expect(screen.getByText('Suspensions (1)')).toBeInTheDocument();
        expect(screen.getByText(/Votes are off on this node, so a suspension lifts by itself after 7 days/)).toBeInTheDocument();
        expect(screen.queryByText(/Open votes/)).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Lift suspension now' }));
        const dialog = screen.getByRole('dialog', { name: 'Lift suspension' });
        expect(dialog).toHaveTextContent("Lift Troll's suspension now?");
        expect(dialog).toHaveTextContent('Lifting ends the suspension straight away, before its 7 days are up.');
        expect(dialog.textContent).not.toMatch(/vote|Halt/i);
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'Wrong account suspended' } });
        fireEvent.click(screen.getByRole('button', { name: 'Lift suspension' }));
        await waitFor(() => expect(halt).toHaveBeenCalledWith('https://test-node.local', 'dec-novote-1', 'Wrong account suspended', 'pw', undefined));
    });

    it('with Decisions off, a suspension that opened as a vote before the switch is worded as one without', async () => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([keepVote]);
        render(<DecisionsAdminPanel activeNode={node} />);
        const row = await screen.findByTestId('admin-decision-row');
        expect(row).toHaveTextContent('Troll is suspended');
        expect(row).toHaveTextContent(`Suspended until ${until(keepVote.closesAt)}`);
        expect(row.textContent).not.toMatch(VOTE_WORDS);
        expect(row.textContent).not.toMatch(/\d+ of \d+/);
        expect(screen.getByText('Suspensions (1)')).toBeInTheDocument();
    });

    it('a no-vote suspension on a node with Decisions back on: the row is a suspension, the heading and other rows keep their words', async () => {
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([noVoteSuspension, keepVote]);
        render(<DecisionsAdminPanel activeNode={node} />);
        const [noVoteRow, voteRow] = await screen.findAllByTestId('admin-decision-row');
        expect(noVoteRow).toHaveTextContent(`Suspended until ${until(noVoteSuspension.closesAt)}`);
        expect(noVoteRow.textContent).not.toMatch(VOTE_WORDS);
        expect(voteRow).toHaveTextContent('Keep suspension?');
        expect(voteRow).toHaveTextContent('2 of 6 votes needed · Yes 1 · No 1');
        expect(voteRow).toHaveTextContent('Halt this Decision');
        expect(screen.getByText('Community Decisions (2)')).toBeInTheDocument();
        expect(screen.getByText(/^Open votes and removals waiting out their 7 days/)).toBeInTheDocument();
    });

    it('with Decisions off, a list holding more than suspensions keeps its heading and those rows their words', async () => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([noVoteSuspension, removalInGrace]);
        render(<DecisionsAdminPanel activeNode={node} />);
        const [, removalRow] = await screen.findAllByTestId('admin-decision-row');
        expect(removalRow).toHaveTextContent(`Removal on ${until(removalInGrace.gracePeriodEndsAt!)}`);
        expect(removalRow).toHaveTextContent('8 of 5 votes needed · Yes 7 · No 1');
        expect(removalRow).toHaveTextContent('Halt this Decision');
        expect(screen.getByText('Community Decisions (2)')).toBeInTheDocument();
    });

    it('with Decisions off and nothing to act on, says there are no suspensions', async () => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([]);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByText('No suspensions.')).toBeInTheDocument();
        expect(screen.getByText('Suspensions (0)')).toBeInTheDocument();
        expect(screen.queryByText(/Open votes|No open Decisions/)).not.toBeInTheDocument();
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
