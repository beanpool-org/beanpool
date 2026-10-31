import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { DecideSection } from './DecideSection';
import { castDecisionVote, replyToRemovalCase, reportRemovalCase } from '../lib/api';

// The card looks up no separate credits figure (the node checks the cost); a removal vote's member replies to its case
// and reports it as false (removal by vote, Amendment A).
vi.mock('../lib/api', () => ({
    castDecisionVote: vi.fn(async () => ({ success: true, creditsUsed: 9 })),
    replyToRemovalCase: vi.fn(async () => ({ success: true })),
    reportRemovalCase: vi.fn(async () => ({ success: true })),
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
    adminHaltReason: null,
    updatedAt: '2026-09-18T00:00:00.000Z',
    tally: {
        decisionId: id, status: 'open', totalVoters: 1, electorate: 20, quorumRatio: 0.3, quorumRequired: 6, quorumMet: false,
        yesWeight: 1, noWeight: 0, totalWeight: 1, supportRatio: 1, thresholdRequired: 0.6, passed: false,
    },
    myVote,
});

const renderDecide = (canPropose: boolean, decisions: any[] = [], myPoolVoting: any = null) => render(
    <DecideSection
        decisions={decisions}
        myPoolVoting={myPoolVoting}
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

        expect(screen.getByText(/Open to members who have completed a trade, and to node admins\./)).toBeInTheDocument();
        expect(screen.getByText(/You can propose once you have completed a trade\./)).toBeInTheDocument();
        expect(container.textContent).not.toMatch(/earnedCredit/);
        // Badges unlock nothing (Marty, 23 Oct): a trust badge is no way in, so no second route is offered.
        expect(container.textContent).not.toMatch(/earned standing|badge/i);
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

describe('DecideSection voting answers', () => {
    beforeEach(() => vi.mocked(castDecisionVote).mockClear());

    it('tells a member with no completed trade, before they try, and does not send the vote (H)', () => {
        renderDecide(true, [decisionCard('p', 'quadratic_trade', null)], { voiceCredits: 0, hasCompletedTrade: false });
        expect(screen.getByTestId('pool-vote-blocker').textContent).toBe('Voting on community money opens after your first completed trade.');
        expect(screen.getByRole('button', { name: /Vote YES/ })).toBeDisabled();
        expect(screen.getByRole('button', { name: /Vote NO/ })).toBeDisabled();
    });

    it('shows the voice credits the node checks and what they buy (H)', () => {
        renderDecide(true, [decisionCard('p', 'quadratic_trade', null)], { voiceCredits: 16.4, hasCompletedTrade: true });
        expect(screen.getByText('You have 16 voice credits: up to 4 votes on this Decision.')).toBeInTheDocument();
        expect(screen.queryByTestId('pool-vote-blocker')).toBeNull();
    });

    it('the no-trade note never blocks a one-member-one-vote Decision', () => {
        renderDecide(true, [decisionCard('m', '1m1v', null)], { voiceCredits: 0, hasCompletedTrade: false });
        expect(screen.queryByTestId('pool-vote-blocker')).toBeNull();
        expect(screen.getByRole('button', { name: /Vote YES/ })).toBeEnabled();
    });

    it('turnout reads against the members active in the last 30 days (K)', () => {
        renderDecide(true, [decisionCard('m', '1m1v', null)]);
        expect(screen.getByText('Turnout: 1 of 6 votes needed')).toBeInTheDocument();
        expect(screen.getByText('30% of 20 members active in the last 30 days')).toBeInTheDocument();
    });

    it('says the floor of 3 when it applies', () => {
        const card = decisionCard('m', '1m1v', null);
        card.tally = { ...card.tally, electorate: 4, quorumRequired: 3 };
        renderDecide(true, [card]);
        expect(screen.getByText('30% of 4 members active in the last 30 days (at least 3)')).toBeInTheDocument();
    });

    it('says the ballot is secret (I)', () => {
        renderDecide(true, [decisionCard('m', '1m1v', null)]);
        expect(screen.getByTestId('secret-ballot-note').textContent).toMatch(/Secret ballot/);
    });

    it('explains an emergency suspension vote (L)', () => {
        const card = decisionCard('k', '1m1v', null);
        card.effect = 'keep_suspension';
        card.params = { memberName: 'Dave', suspendedAt: '2026-09-19T10:00:00.000Z', reason: 'Threats in the market chat' };
        renderDecide(true, [card]);
        const box = screen.getByTestId('keep-suspension-box');
        // The date through core's formatDate (the words layer's tables, the phone's lib/decision-card.ts since S3g), not the
        // browser's own locale.
        expect(box.textContent).toContain('An admin suspended Dave on 19 Sep 2026. Keep the suspension?');
        expect(box.textContent).toContain("If this vote doesn't pass, the suspension lifts by itself.");
    });

    // Removal by vote S2: an admin's pause opens the community's vote on removing the member, the node's own (rule 2).
    it('explains a pause\'s own vote: who was paused and when, and what each answer does', () => {
        const card = decisionCard('p', '1m1v', null);
        card.authorPubkey = 'SYSTEM';
        card.effect = 'remove_member';
        card.title = 'Remove Dave?';
        card.params = { memberName: 'Dave', pausedAt: '2026-10-22T10:00:00.000Z', rule: 2, reason: 'Threats in the market chat', commonsPool: 240 };
        const first = renderDecide(true, [card]);
        const box = screen.getByTestId('pause-vote-box');
        expect(box.textContent).toContain('An admin paused Dave on 22 Oct 2026.');
        expect(box.textContent).toContain('Yes removes Dave after 7 days. No brings Dave back as soon as the vote closes.');
        expect(screen.queryByTestId('keep-suspension-box')).toBeNull();
        // It is a removal vote: its debt disclosure is there too.
        expect(screen.getByTestId('removal-debt-write-off-box')).toBeInTheDocument();
        first.unmount();

        // An admin paused: no vote removes an owner or admin (§3.8), and the card says so.
        card.params = { ...card.params, serverRole: 'admin' };
        const second = renderDecide(true, [card]);
        expect(screen.getByTestId('pause-vote-box').textContent).toContain(
            "Dave holds a role that runs this community's server, and no community vote removes an owner or admin: whatever this vote decides, Dave is back when it closes.");
        second.unmount();

        // A removal a member proposed is no pause's vote, whatever its params say.
        const proposed = decisionCard('q', '1m1v', null);
        proposed.effect = 'remove_member';
        proposed.params = { memberName: 'Eve', rule: 2, pausedAt: '2026-10-22T10:00:00.000Z' };
        renderDecide(true, [proposed]);
        expect(screen.queryByTestId('pause-vote-box')).toBeNull();
    });

    // Removal by vote S4 (design §3.4): an owner's second pause within 30 days of a vote that didn't remove the member says so,
    // by how that vote ended; a first pause says nothing of it.
    it('a second pause within 30 days says so on its card, by how the last vote ended', () => {
        const card = decisionCard('s', '1m1v', null);
        card.authorPubkey = 'SYSTEM';
        card.effect = 'remove_member';
        card.title = 'Remove Dave?';
        const base = { memberName: 'Dave', pausedAt: '2026-10-22T10:00:00.000Z', rule: 2, reason: 'Deposits again', commonsPool: 240 };
        const shown: Array<[string, string]> = [
            ['no', 'Second pause in 30 days. The last vote said No.'],
            ['too_few', 'Second pause in 30 days. Too few members voted on the last one.'],
            ['stopped', 'Second pause in 30 days. The last vote was stopped before it closed.'],
        ];
        for (const [after, words] of shown) {
            card.params = { ...base, secondPause: { after, endedAt: '2026-10-15T10:00:00.000Z' } };
            const view = renderDecide(true, [card]);
            expect(screen.getByTestId('second-pause-line').textContent).toBe(words);
            expect(screen.getByTestId('pause-vote-box').textContent).toContain(words);
            view.unmount();
        }
        card.params = base;
        renderDecide(true, [card]);
        expect(screen.getByTestId('pause-vote-box')).toBeInTheDocument();
        expect(screen.queryByTestId('second-pause-line')).toBeNull();
    });

    // Nobody votes on their own removal (the node refuses it): its subject reads why, and gets no buttons to press.
    it('a vote on removing the reader says they can\'t vote on it, in place of the buttons; anyone else votes', () => {
        const mine = decisionCard('o', '1m1v', null);
        mine.authorPubkey = 'SYSTEM';
        mine.effect = 'remove_member';
        mine.subject = 'viewer';
        mine.params = { memberName: 'Visitor', rule: 2, pausedAt: '2026-10-22T10:00:00.000Z' };
        const first = renderDecide(true, [mine]);
        expect(screen.getByTestId('own-removal-note').textContent).toBe("This vote is about you, so you can't vote on it.");
        expect(screen.queryByText('Vote YES')).toBeNull();
        expect(screen.queryByText('Vote NO')).toBeNull();
        first.unmount();

        renderDecide(true, [{ ...mine, subject: 'someone-else' }]);
        expect(screen.queryByTestId('own-removal-note')).toBeNull();
        expect(screen.getByText('Vote YES')).toBeInTheDocument();
    });

    // Balances are private (2026-09-28): the node sends a removal vote's record of the member's balance and debt only to
    // those who can vote in it. Anyone else is told so, never shown a made-up −0.
    it('a removal vote: a voter reads the debt the node sent; anyone else reads that it is for voters only', () => {
        const voter = decisionCard('r1', '1m1v', null);
        voter.effect = 'remove_member';
        voter.params = { memberName: 'Eve', debt: 12, balance: -12, commonsPool: 300 };
        const { unmount } = renderDecide(true, [voter]);
        expect(screen.getByTestId('removal-debt-write-off-line').textContent).toContain("Eve's balance is −12 beans");
        unmount();

        const other = decisionCard('r2', '1m1v', null);
        other.effect = 'remove_member';
        other.params = { memberName: 'Eve', commonsPool: 300 };
        renderDecide(true, [other]);
        const line = screen.getByTestId('removal-debt-write-off-line').textContent ?? '';
        expect(line).toContain("only the members who can vote in this see Eve's balance");
        expect(line).not.toContain('−0');
    });
});

// Removal by vote, Amendment A: a fair vote on removing a member. The member is heard (their reply beside the case), who
// brought it is named, a case shown false is hidden with a public reason, and the member can report it as false.
describe('DecideSection: a fair vote on removing a member', () => {
    const pauseCard = (over: Record<string, any> = {}): any => ({
        ...decisionCard('pv', '1m1v', null),
        authorPubkey: 'SYSTEM',
        effect: 'remove_member',
        title: 'Remove Dave?',
        description: 'An admin paused Dave on 2026-10-22. Reason given: Took deposits for repairs and never came back',
        subject: 'dave-key',
        params: { memberName: 'Dave', pausedAt: '2026-10-22T10:00:00.000Z', rule: 2, commonsPool: 240 },
        proposer: { kind: 'admin', name: 'Ada' },
        ...over,
    });
    const renderAs = (me: string, decisions: any[], activeView: 'open' | 'history' = 'open', onRefresh = async () => {}) => render(
        <DecideSection
            decisions={decisions}
            identity={{ publicKey: me, privateKey: 'k', callsign: 'Me', createdAt: '2026-09-17T00:00:00.000Z' }}
            commonsBalance={0}
            onRefresh={onRefresh}
            onOpenPropose={() => {}}
            canPropose={true}
            hasOpenDecision={false}
            activeView={activeView}
            onChangeView={() => {}}
        />
    );
    beforeEach(() => {
        vi.mocked(replyToRemovalCase).mockClear();
        vi.mocked(reportRemovalCase).mockClear();
    });

    it('names who brought it: the admin who paused, an owner with the password, a member\'s own older proposal', () => {
        const first = renderAs('viewer', [pauseCard()]);
        expect(screen.getByTestId('pause-vote-box').textContent).toContain('Ada, an admin, paused Dave on 22 Oct 2026.');
        first.unmount();

        const second = renderAs('viewer', [pauseCard({ proposer: { kind: 'password', name: null } })]);
        expect(screen.getByTestId('pause-vote-box').textContent).toContain("An owner paused Dave on 22 Oct 2026, signed in with the server's password.");
        second.unmount();

        // A node from before sends no proposer: the card says what it always said.
        const third = renderAs('viewer', [pauseCard({ proposer: undefined })]);
        expect(screen.getByTestId('pause-vote-box').textContent).toContain('An admin paused Dave on 22 Oct 2026.');
        third.unmount();

        const proposed = { ...pauseCard({ authorPubkey: 'tia-key', proposer: { kind: 'member', name: 'Tia' } }), params: { memberName: 'Finn' } };
        const fourth = renderAs('viewer', [proposed]);
        expect(screen.getByTestId('removal-proposed-by').textContent).toBe('Proposed by Tia.');
        fourth.unmount();

        // Another Decision names nobody.
        renderAs('viewer', [decisionCard('g', '1m1v', null)]);
        expect(screen.queryByTestId('removal-proposed-by')).toBeNull();
    });

    it('shows the member\'s reply beside the case to everyone; the member writes it, and changes it, while the vote is open', async () => {
        const first = renderAs('viewer', [pauseCard({ subjectReply: 'I refunded every deposit. Ask Wu.' })]);
        const shown = screen.getByTestId('removal-reply');
        expect(shown.textContent).toContain("Dave's reply");
        expect(shown.textContent).toContain('I refunded every deposit. Ask Wu.');
        // A voter can't write it.
        expect(screen.queryByTestId('removal-reply-form')).toBeNull();
        expect(screen.queryByText('Change your reply')).toBeNull();
        first.unmount();

        // The member, with no reply yet: the form is there, and sends their words.
        const refresh = vi.fn(async () => {});
        const second = renderAs('dave-key', [pauseCard()], 'open', refresh);
        const form = screen.getByTestId('removal-reply-form');
        expect(form.textContent).toContain('Reply to this case');
        expect(form.textContent).toContain('Everyone who reads this vote sees your reply beside the case.');
        const send = screen.getByRole('button', { name: 'Send reply' });
        expect(send).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Reply to this case'), { target: { value: '  Every repair was done.  ' } });
        fireEvent.click(send);
        await waitFor(() => expect(replyToRemovalCase).toHaveBeenCalledWith('pv', 'Every repair was done.'));
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        second.unmount();

        // With a reply sent: theirs, headed "Your reply", and Change your reply opens it again to change.
        const third = renderAs('dave-key', [pauseCard({ subjectReply: 'Every repair was done.' })]);
        expect(screen.getByTestId('removal-reply').textContent).toContain('Your reply');
        fireEvent.click(screen.getByRole('button', { name: 'Change your reply' }));
        expect((screen.getByLabelText('Change your reply') as HTMLTextAreaElement).value).toBe('Every repair was done.');
        third.unmount();

        // Closed: the reply stands, and nobody can change it.
        renderAs('dave-key', [pauseCard({ status: 'failed', subjectReply: 'Every repair was done.' })], 'history');
        expect(screen.getByTestId('removal-reply').textContent).toContain('Every repair was done.');
        expect(screen.queryByText('Change your reply')).toBeNull();
        expect(screen.queryByTestId('removal-reply-form')).toBeNull();
    });

    it('a case an admin hid shows their reason in its place, open and in the history; who brought it and the reply stay', () => {
        const hidden = pauseCard({
            description: 'An admin hid the case for this vote, as one shown to be false. Their reason: Wu confirmed every repair',
            caseHiddenAt: '2026-10-25T10:00:00.000Z', caseHiddenReason: 'Wu confirmed every repair', subjectReply: 'Every repair was done.',
        });
        const first = renderAs('viewer', [hidden]);
        expect(screen.getByTestId('removal-case-hidden').textContent).toBe(
            'An admin hid the case for this vote, as one shown to be false. Their reason: Wu confirmed every repair');
        // The node's own sentence, for older apps, is not shown as well: in English it is this one, once.
        expect(screen.getAllByText(hidden.description)).toHaveLength(1);
        expect(screen.getByTestId('pause-vote-box').textContent).toContain('Ada, an admin, paused Dave');
        expect(screen.getByTestId('removal-reply').textContent).toContain('Every repair was done.');
        first.unmount();

        renderAs('viewer', [{ ...hidden, status: 'failed' }], 'history');
        expect(screen.getByTestId('removal-case-hidden').textContent).toContain('Their reason: Wu confirmed every repair');
    });

    // Removal by vote S6 (design §5): at least 3 Yes; too few to vote, the owner decides when it closes.
    it('a removal says the 3-Yes floor; too few to vote, the card says the owner decides, then shows their reason, and the history says the owner decided it', () => {
        const tally = { ...decisionCard('x', '1m1v', null).tally, electorate: 2, quorumRatio: 0.25, quorumRequired: 3, thresholdRequired: 0.66, minYes: 3, tooFewToVote: true };
        const first = renderAs('viewer', [pauseCard({ tally })]);
        expect(screen.getByTestId('min-yes-line').textContent).toBe('Removing a member also needs at least 3 Yes votes.');
        expect(screen.getByTestId('owner-decision-line').textContent).toBe('Fewer than 3 members could vote. If nobody else votes, the owner decides when it closes.');
        expect(screen.getByTestId('pause-vote-box').textContent).toContain('the owner decides when it closes');
        first.unmount();

        const decided = pauseCard({ tally, ownerDecidedAt: '2026-10-30T10:00:00.000Z', ownerDecidedReason: 'Both who could vote saw the shed emptied' });
        const second = renderAs('viewer', [decided]);
        expect(screen.getByTestId('owner-decision-line').textContent).toBe(
            'Too few members can vote, so an owner decided: unless more of them vote, Dave is removed when this vote closes. Their reason: Both who could vote saw the shed emptied');
        second.unmount();

        const third = renderAs('viewer', [{ ...decided, status: 'executed', ownerDecisionCarriedAt: '2026-11-06T10:00:00.000Z', executionReason: 'Pruned automatically after 7-day grace window' }], 'history');
        expect(screen.getByTestId('owner-decision-line').textContent).toBe('Decided by the owner: too few members to vote. Their reason: Both who could vote saw the shed emptied');
        expect(screen.queryByText(/Authorised by: Community Vote/)).toBeNull();
        third.unmount();

        // An admin hid the case: the node leaves the owner's reason off, as it may repeat the accusation, and the card says the rest.
        const noReason = renderAs('viewer', [{ ...decided, ownerDecidedReason: null }]);
        expect(screen.getByTestId('owner-decision-line').textContent).toBe('Too few members can vote, so an owner decided: unless more of them vote, Dave is removed when this vote closes.');
        noReason.unmount();
        const noReasonClosed = renderAs('viewer', [{ ...decided, ownerDecidedReason: null, status: 'executed', ownerDecisionCarriedAt: '2026-11-06T10:00:00.000Z' }], 'history');
        expect(screen.getByTestId('owner-decision-line').textContent).toBe('Decided by the owner: too few members to vote.');
        noReasonClosed.unmount();

        // A vote enough members can vote on says nothing of an owner; one stopped only by the floor says so in the history.
        const plain = { ...tally, electorate: 6, tooFewToVote: false, totalVoters: 3, quorumMet: true, yesWeight: 2, noWeight: 1, totalWeight: 3, supportRatio: 2 / 3 };
        const fourth = renderAs('viewer', [pauseCard({ tally: plain })]);
        expect(screen.queryByTestId('owner-decision-line')).toBeNull();
        fourth.unmount();
        renderAs('viewer', [pauseCard({ tally: plain, status: 'failed' })], 'history');
        expect(screen.getByText('Not executed: fewer than 3 Yes votes')).toBeInTheDocument();
    });

    it("a reply an admin took down: their reason in its place, open and in the history; the member can't write another", () => {
        const takenDown = pauseCard({ subjectReply: null, replyHiddenAt: '2026-10-25T10:00:00.000Z', replyHiddenReason: "It gave a neighbour's address" });
        const first = renderAs('viewer', [takenDown]);
        expect(screen.getByTestId('removal-reply-taken-down').textContent).toBe("An admin took down Dave's reply. Their reason: It gave a neighbour's address");
        expect(screen.queryByTestId('removal-reply')).toBeNull();
        first.unmount();

        // To the member: their reply, with no form, no Reply or Change button; reporting the case stays.
        const second = renderAs('dave-key', [takenDown]);
        expect(screen.getByTestId('removal-reply-taken-down').textContent).toBe("An admin took down your reply. Their reason: It gave a neighbour's address");
        expect(screen.queryByTestId('removal-reply-form')).toBeNull();
        expect(screen.queryByText('Reply to this case')).toBeNull();
        expect(screen.queryByText('Change your reply')).toBeNull();
        expect(screen.getByTestId('removal-case-report')).toBeTruthy();
        second.unmount();

        renderAs('viewer', [{ ...takenDown, status: 'failed' }], 'history');
        expect(screen.getByTestId('removal-reply-taken-down').textContent).toBe("An admin took down Dave's reply. Their reason: It gave a neighbour's address");
    });

    it('the member reports the case as false, after saying yes; not offered on a password\'s case, nor to anyone else', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const first = renderAs('dave-key', [pauseCard()]);
        fireEvent.click(screen.getByTestId('removal-case-report'));
        expect(confirmSpy).toHaveBeenCalledWith('Report this case as a false accusation? The admins and owners see your report, and who brought the case.');
        await waitFor(() => expect(reportRemovalCase).toHaveBeenCalledWith('pv'));
        expect((await screen.findByTestId('removal-case-reported')).textContent).toBe('Reported. The admins and owners will look at it.');
        first.unmount();

        // Said no: nothing is sent.
        confirmSpy.mockReturnValue(false);
        vi.mocked(reportRemovalCase).mockClear();
        const second = renderAs('dave-key', [pauseCard()]);
        fireEvent.click(screen.getByTestId('removal-case-report'));
        expect(reportRemovalCase).not.toHaveBeenCalled();
        second.unmount();
        confirmSpy.mockRestore();

        const third = renderAs('dave-key', [pauseCard({ proposer: { kind: 'password', name: null } })]);
        expect(screen.queryByTestId('removal-case-report')).toBeNull();
        third.unmount();

        renderAs('viewer', [pauseCard()]);
        expect(screen.queryByTestId('removal-case-report')).toBeNull();
    });
});

describe('DecideSection in preview mode', () => {
    beforeEach(() => vi.mocked(castDecisionVote).mockClear());

    it('renders the sample decision, tags, turnout, tally, and marker actions opening the sheet without lock icons', async () => {
        const previewItem = {
            id: 'sample-decide-1',
            authorPubkey: 'author',
            title: 'Grant 50 Beans from the Commons pool to Example Valley Bakery for community grain mill repairs',
            description: '50 Beans from the pool: Community grain mill repairs.',
            touches: 'pool' as const,
            effect: 'grant_enterprise' as const,
            subject: 'enterprise',
            params: { amount: 50, subject: 'enterprise' },
            franchise: 'quadratic_trade' as const,
            status: 'open' as const,
            opensAt: '2026-04-10T12:00:00.000Z',
            closesAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
            gracePeriodEndsAt: null,
            createdAt: '2026-04-10T12:00:00.000Z',
            executedAt: null,
            executionError: null,
            executionReason: null,
            adminHaltedAt: null,
            adminHaltReason: null,
            updatedAt: '2026-04-10T12:00:00.000Z',
            tally: {
                decisionId: 'sample-decide-1',
                status: 'open' as const,
                totalVoters: 9,
                electorate: 20,
                quorumRatio: 0.3,
                quorumRequired: 6,
                quorumMet: true,
                yesWeight: 12,
                noWeight: 2,
                totalWeight: 14,
                supportRatio: 12 / 14,
                thresholdRequired: 0.6,
                passed: true,
            },
            myVote: null,
        };

        const { container } = render(
            <DecideSection
                preview
                decisions={[previewItem]}
                myPoolVoting={{ voiceCredits: 582, hasCompletedTrade: true }}
                identity={{ publicKey: 'viewer', privateKey: 'k', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' }}
                commonsBalance={640}
                onRefresh={async () => {}}
                onOpenPropose={() => {}}
                canPropose={true}
                hasOpenDecision={true}
                activeView="open"
                onChangeView={() => {}}
            />
        );

        // Strip and Sample Header
        expect(screen.getByTestId('local-community-strip')).toBeInTheDocument();
        expect(screen.getByTestId('sample-header')).toBeInTheDocument();
        expect(screen.getByTestId('voice-credits-card')).toBeInTheDocument();
        expect(screen.getByTestId('voice-credits-card')).toHaveTextContent('582');

        // Sample decision card
        const card = screen.getByTestId('sample-decision');
        expect(card).toBeInTheDocument();
        expect(card).toHaveTextContent('Touches: pool');
        expect(card).toHaveTextContent('Grant Enterprise');
        expect(card).toHaveTextContent('Quadratic on Trade');
        expect(card).toHaveTextContent('Turnout: 9 of 6 votes needed');
        expect(card).toHaveTextContent('Quorum Met');
        expect(card).toHaveTextContent('Yes 12 (86%)');
        expect(card).toHaveTextContent('No 2');
        expect(card).toHaveTextContent(/3 days left/);

        // Secret ballot note has no lock icon
        const secretNote = screen.getByTestId('secret-ballot-note');
        expect(secretNote.textContent).toBe('Secret ballot: members see the totals, never who voted how.');

        // Entire container has no lock icon
        expect(container.innerHTML).not.toMatch(/🔒|Locked|locked|Ʀ/);

        // Marker actions open the sheet and never call castDecisionVote
        const actions = screen.getAllByTestId('local-community-action');
        expect(actions.length).toBeGreaterThanOrEqual(3); // Propose, Vote YES, Vote NO
        for (const action of actions) {
            fireEvent.click(action);
            const sheet = await screen.findByTestId('local-community-sheet');
            expect(sheet).toBeInTheDocument();
            expect(sheet).toHaveTextContent('A vote binds a community');
            fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        }
        expect(castDecisionVote).not.toHaveBeenCalled();
    });
});
