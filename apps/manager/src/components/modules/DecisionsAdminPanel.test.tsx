import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DecisionsAdminPanel } from './DecisionsAdminPanel';
import type { NodeProfile } from '../../lib/profiles';
import * as nodeClient from '../../lib/node-client';
import { FreshProofRequiredError } from '../../lib/fresh-proof';

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

/** A pause's own vote (removal by vote S2): the node's vote on removing the member it paused. */
const pauseVote: nodeClient.AdminDecisionItem = {
    ...keepVote,
    id: 'dec-pause-1',
    authorPubkey: 'SYSTEM',
    title: 'Remove Troll?',
    description: 'An admin paused Troll on 2026-09-19. Yes removes Troll after 7 days; No brings Troll back as soon as the vote closes. Reason given: threats',
    effect: 'remove_member',
    params: { memberName: 'Troll', rule: 2, pausedAt: '2026-09-19T00:00:00.000Z' },
    tally: { totalVoters: 2, electorate: 20, quorumRequired: 5, quorumMet: false, yesWeight: 1, noWeight: 1, supportRatio: 0.5, thresholdRequired: 0.66 },
};

const until = (iso: string) => new Date(iso).toLocaleDateString();
const VOTE_WORDS = /votes? needed|Keep suspension\?|Open votes|Halt this Decision|Halting this vote/;

describe('DecisionsAdminPanel', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(true);
        // No closed removal votes unless a test lists some (the hide-case tests below).
        vi.spyOn(nodeClient, 'fetchPastRemovalVotes').mockResolvedValue([]);
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

    it('a pause\'s own vote: halting it lifts the suspension, said as for a keep vote; a removal a member proposed is not one', async () => {
        const proposed: nodeClient.AdminDecisionItem = { ...pauseVote, id: 'dec-proposed-1', authorPubkey: 'a'.repeat(64), title: 'Remove Someone' };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseVote, proposed]);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByText('Remove Troll?')).toBeInTheDocument();
        expect(screen.getAllByText('2 of 5 votes needed · Yes 1 · No 1')).toHaveLength(2);
        fireEvent.click(screen.getAllByText('Halt this Decision')[0]);
        expect(screen.getByText('Halting this vote lifts the suspension straight away.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        fireEvent.click(screen.getAllByText('Halt this Decision')[1]);
        expect(screen.getByText('Halting closes the vote; nothing it proposed will happen.')).toBeInTheDocument();
    });

    it('with Decisions off, a pause\'s own vote is a suspension that lifts by itself, lifted now by its button', async () => {
        vi.mocked(nodeClient.fetchNodeDecisionsOn).mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseVote]);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByText('Troll is suspended')).toBeInTheDocument();
        expect(screen.getByText('No vote. It lifts by itself on that day, or sooner if you lift it.')).toBeInTheDocument();
        expect(screen.getByText('Suspensions (1)')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Lift suspension now'));
        expect(screen.getByText('Lifting ends the suspension straight away, before its 7 days are up.')).toBeInTheDocument();
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

    // Removal by vote, Amendment A point 4: an admin hides a case shown to be false, with a reason members read in its place.
    it('hides the case of a vote on removing a member, with a public reason of 10+ characters; the vote itself carries on', async () => {
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseVote, keepVote]);
        const hide = vi.spyOn(nodeClient, 'hideDecisionCase').mockResolvedValue({ success: true });
        render(<DecisionsAdminPanel activeNode={node} />);
        const [pauseRow, keepRow] = await screen.findAllByTestId('admin-decision-row');
        // Only a vote on removing a member has a case to hide.
        expect(keepRow.textContent).not.toContain('Hide case');
        fireEvent.click(within(pauseRow).getByRole('button', { name: 'Hide case' }));
        const dialog = screen.getByRole('dialog', { name: 'Hide case' });
        expect(dialog).toHaveTextContent('Hide the case of “Remove Troll?”?');
        expect(dialog).toHaveTextContent('The vote itself carries on: to stop it, halt it.');
        const confirm = within(dialog).getByRole('button', { name: 'Hide case' });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Reason (members will see this)'), { target: { value: 'not true' } });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Reason (members will see this)'), { target: { value: '  Two witnesses showed it false  ' } });
        expect(confirm).not.toBeDisabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(hide).toHaveBeenCalledWith('https://test-node.local', 'dec-pause-1', 'Two witnesses showed it false', 'pw', undefined));
    });

    it('a hidden case shows the reason members read, not the button; closed removal votes are listed to hide one', async () => {
        const hidden: nodeClient.AdminDecisionItem = { ...pauseVote, caseHiddenAt: '2026-09-21T00:00:00.000Z', caseHiddenReason: 'Two witnesses showed it false' };
        const closed: nodeClient.AdminDecisionItem = { ...pauseVote, id: 'dec-closed-1', title: 'Remove Ola?', subjectName: 'Ola', status: 'failed' };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([hidden]);
        vi.mocked(nodeClient.fetchPastRemovalVotes).mockResolvedValue([closed]);
        const hide = vi.spyOn(nodeClient, 'hideDecisionCase').mockResolvedValue({ success: true });
        render(<DecisionsAdminPanel activeNode={node} />);
        const row = await screen.findByTestId('admin-decision-row');
        expect(within(row).getByTestId('admin-case-hidden')).toHaveTextContent('Case hidden as false. Members read: “Two witnesses showed it false”');
        expect(within(row).queryByRole('button', { name: 'Hide case' })).toBeNull();
        const past = screen.getByTestId('past-removal-votes');
        expect(past).toHaveTextContent('Closed votes on removing a member (1)');
        const pastRow = within(past).getByTestId('past-removal-row');
        expect(pastRow).toHaveTextContent('Remove Ola?');
        expect(pastRow).toHaveTextContent('failed');
        expect(pastRow).toHaveTextContent('About: Ola');
        fireEvent.click(within(pastRow).getByRole('button', { name: 'Hide case' }));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'The deposit was refunded in full' } });
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Hide case' })).getByRole('button', { name: 'Hide case' }));
        await waitFor(() => expect(hide).toHaveBeenCalledWith('https://test-node.local', 'dec-closed-1', 'The deposit was refunded in full', 'pw', undefined));
    });

    it('no Hide case on a suspension nobody votes on, and the node\'s refusal shows when hiding fails', async () => {
        vi.spyOn(nodeClient, 'fetchNodeDecisionsOn').mockResolvedValue(false);
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([pauseVote]);
        const first = render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByText('Troll is suspended')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Hide case' })).toBeNull();
        first.unmount();

        vi.mocked(nodeClient.fetchNodeDecisionsOn).mockResolvedValue(true);
        vi.spyOn(nodeClient, 'hideDecisionCase').mockRejectedValue(new Error('This case is already hidden'));
        render(<DecisionsAdminPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Hide case' }));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'A long enough reason' } });
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Hide case' })).getByRole('button', { name: 'Hide case' }));
        expect(await screen.findByText('This case is already hidden')).toBeInTheDocument();
    });

    // The deciding review of #2585: a member's reply that harms someone else is taken down, with a reason members read in its place.
    it("takes down a member's reply, open or closed, with a public reason of 10+ characters, showing the words first; none to take down before they write one", async () => {
        const replied: nodeClient.AdminDecisionItem = { ...pauseVote, subjectReply: 'Erin lives at 12 Example Street. Ask her.' };
        const closed: nodeClient.AdminDecisionItem = { ...pauseVote, id: 'dec-closed-2', title: 'Remove Ola?', subjectName: 'Ola', status: 'failed', subjectReply: 'Ring 0400 000 000.' };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([replied, keepVote]);
        vi.mocked(nodeClient.fetchPastRemovalVotes).mockResolvedValue([closed]);
        const takeDown = vi.spyOn(nodeClient, 'takeDownDecisionReply').mockResolvedValue({ success: true });
        render(<DecisionsAdminPanel activeNode={node} />);
        const [pauseRow, keepRow] = await screen.findAllByTestId('admin-decision-row');
        expect(keepRow.textContent).not.toContain('Take down reply');
        fireEvent.click(within(pauseRow).getByRole('button', { name: 'Take down reply' }));
        const dialog = screen.getByRole('dialog', { name: 'Take down reply' });
        expect(dialog).toHaveTextContent("Take down Troll's reply?");
        expect(within(dialog).getByTestId('take-down-reply-text')).toHaveTextContent('Erin lives at 12 Example Street. Ask her.');
        expect(dialog).toHaveTextContent("The member is told, and can't write another reply on this vote.");
        const confirm = within(dialog).getByRole('button', { name: 'Take down reply' });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Reason (members will see this)'), { target: { value: 'address' } });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Reason (members will see this)'), { target: { value: "  It gave a neighbour's address  " } });
        expect(confirm).not.toBeDisabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(takeDown).toHaveBeenCalledWith('https://test-node.local', 'dec-pause-1', "It gave a neighbour's address", 'pw', undefined));

        const pastRow = within(screen.getByTestId('past-removal-votes')).getByTestId('past-removal-row');
        fireEvent.click(within(pastRow).getByRole('button', { name: 'Take down reply' }));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'It gave a phone number' } });
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Take down reply' })).getByRole('button', { name: 'Take down reply' }));
        await waitFor(() => expect(takeDown).toHaveBeenCalledWith('https://test-node.local', 'dec-closed-2', 'It gave a phone number', 'pw', undefined));
    });

    it('a reply taken down shows the reason members read, not the button; no button with no reply; the refusal shows when it fails', async () => {
        const takenDown: nodeClient.AdminDecisionItem = { ...pauseVote, subjectReply: null, replyHiddenAt: '2026-09-21T00:00:00.000Z', replyHiddenReason: "It gave a neighbour's address" };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([takenDown, { ...pauseVote, id: 'dec-pause-2' }]);
        const first = render(<DecisionsAdminPanel activeNode={node} />);
        const [downRow, bareRow] = await screen.findAllByTestId('admin-decision-row');
        expect(within(downRow).getByTestId('admin-reply-taken-down')).toHaveTextContent("Reply taken down. Members read: “It gave a neighbour's address”");
        expect(within(downRow).queryByRole('button', { name: 'Take down reply' })).toBeNull();
        expect(within(bareRow).queryByRole('button', { name: 'Take down reply' })).toBeNull();
        first.unmount();

        vi.mocked(nodeClient.fetchAdminDecisions).mockResolvedValue([{ ...pauseVote, subjectReply: 'Ring 0400 000 000.' }]);
        vi.spyOn(nodeClient, 'takeDownDecisionReply').mockRejectedValue(new Error('This reply is already taken down'));
        render(<DecisionsAdminPanel activeNode={node} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Take down reply' }));
        fireEvent.change(screen.getByLabelText('Reason (members will see this)'), { target: { value: 'A long enough reason' } });
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Take down reply' })).getByRole('button', { name: 'Take down reply' }));
        expect(await screen.findByText('This reply is already taken down')).toBeInTheDocument();
    });

    it('an admin reads that too few can vote, and only owner level is offered an owner\'s decision', async () => {
        const tooFew: nodeClient.AdminDecisionItem = {
            ...pauseVote, id: 'dec-few-v',
            tally: { totalVoters: 1, electorate: 2, quorumRequired: 3, quorumMet: false, yesWeight: 1, noWeight: 0, supportRatio: 1, thresholdRequired: 0.66, minYes: 3, tooFewToVote: true },
        };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([tooFew]);
        const asAdmin = render(<DecisionsAdminPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'a'.repeat(64), role: 'admin' }} />);
        expect(within(await screen.findByTestId('admin-decision-row')).getByTestId('admin-too-few-to-vote')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Decide as owner' })).toBeNull();
        asAdmin.unmount();
        const asModerator = render(<DecisionsAdminPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'm'.repeat(64), role: 'moderator' }} />);
        await screen.findByTestId('admin-decision-row');
        expect(screen.queryByRole('button', { name: 'Decide as owner' })).toBeNull();
        asModerator.unmount();
        const asOwner = render(<DecisionsAdminPanel activeNode={node} viewer={{ kind: 'key', memberPubkey: 'o'.repeat(64), role: 'owner' }} />);
        expect(await screen.findByRole('button', { name: 'Decide as owner' })).toBeInTheDocument();
        asOwner.unmount();
        render(<DecisionsAdminPanel activeNode={node} viewer={{ kind: 'password' }} />);
        expect(await screen.findByRole('button', { name: 'Decide as owner' })).toBeInTheDocument();
    });

    it('a hidden case takes the owner\'s reason from what members read, and the list says so and keeps it', async () => {
        const hidden: nodeClient.AdminDecisionItem = {
            ...pauseVote, id: 'dec-few-h', caseHiddenAt: '2026-09-21T00:00:00.000Z', caseHiddenReason: 'Shown to be false by a neighbour',
            ownerDecidedAt: '2026-09-20T00:00:00.000Z', ownerDecidedReason: 'Both who could vote saw it',
        };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([hidden]);
        render(<DecisionsAdminPanel activeNode={node} />);
        expect(await screen.findByTestId('admin-owner-decided')).toHaveTextContent('Hidden from members with the case: “Both who could vote saw it”');
    });

    it('a pause vote too few can vote on: the line says so, an owner decides with a reason, and the fresh proof box opens when the node asks', async () => {
        // Removal by vote S6: fewer than 3 members could vote, so the node serves tooFewToVote.
        const tooFew: nodeClient.AdminDecisionItem = {
            ...pauseVote, id: 'dec-few-1',
            tally: { totalVoters: 1, electorate: 2, quorumRequired: 3, quorumMet: false, yesWeight: 1, noWeight: 0, supportRatio: 1, thresholdRequired: 0.66, minYes: 3, tooFewToVote: true },
        };
        const decided: nodeClient.AdminDecisionItem = { ...tooFew, id: 'dec-few-2', ownerDecidedAt: '2026-09-21T00:00:00.000Z', ownerDecidedReason: 'Both who could vote saw it' };
        const serverRole: nodeClient.AdminDecisionItem = { ...tooFew, id: 'dec-few-3', params: { ...tooFew.params, serverRole: 'admin' } };
        vi.spyOn(nodeClient, 'fetchAdminDecisions').mockResolvedValue([tooFew, decided, serverRole, pauseVote]);
        const decide = vi.spyOn(nodeClient, 'ownerDecideRemoval')
            .mockRejectedValueOnce(new FreshProofRequiredError({ kind: 'code', error: 'A current code is required to decide a vote too few members could vote on' }, 401))
            .mockResolvedValueOnce({ success: true });
        render(<DecisionsAdminPanel activeNode={node} />);
        const [fewRow, decidedRow, roleRow, plainRow] = await screen.findAllByTestId('admin-decision-row');
        expect(within(fewRow).getByTestId('admin-too-few-to-vote')).toHaveTextContent('Fewer than 3 members could vote. If nobody else votes, an owner decides');
        expect(within(decidedRow).getByTestId('admin-owner-decided')).toHaveTextContent('An owner decided: carried out when the vote closes, if still fewer than 3 could vote. Members read: “Both who could vote saw it”');
        expect(within(decidedRow).queryByRole('button', { name: 'Decide as owner' })).toBeNull();
        expect(within(roleRow).queryByRole('button', { name: 'Decide as owner' })).toBeNull();
        expect(within(plainRow).queryByRole('button', { name: 'Decide as owner' })).toBeNull();
        expect(within(plainRow).queryByTestId('admin-too-few-to-vote')).toBeNull();

        fireEvent.click(within(fewRow).getByRole('button', { name: 'Decide as owner' }));
        const dialog = screen.getByRole('dialog', { name: 'Decide as owner' });
        expect(dialog).toHaveTextContent('Decide the vote on removing Troll?');
        const confirm = within(dialog).getByRole('button', { name: 'Decide: remove if still too few' });
        expect(confirm).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Reason (members will see this)'), { target: { value: '  Only Tia and Uma could vote; both saw it  ' } });
        fireEvent.click(confirm);
        await waitFor(() => expect(decide).toHaveBeenCalledWith('https://test-node.local', 'dec-few-1', 'Only Tia and Uma could vote; both saw it', 'pw', undefined, undefined));
        // The password viewer is asked a current code in the box, and nothing was decided yet.
        expect(await screen.findByTestId('owner-decision-proof-code')).toBeInTheDocument();
        expect(decide).toHaveBeenCalledTimes(1);
    });
});
