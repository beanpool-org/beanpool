import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../lib/api', () => ({
    getEnterpriseDecisions: vi.fn(),
    proposeEnterpriseDecision: vi.fn(),
    voteEnterpriseDecision: vi.fn(),
    getGroupDecisions: vi.fn(),
    proposeGroupDecision: vi.fn(async () => ({ success: true })),
    voteGroupDecision: vi.fn(async () => ({ success: true })),
}));
import * as api from '../lib/api';
import { GroupDecisions } from './EnterpriseDecisions';

const ME = 'ada';
const people = [
    { pubkey: 'lou', name: 'Lou', role: 'lead' }, { pubkey: 'cyd', name: 'Cyd', role: 'convenor' },
    { pubkey: 'ada', name: 'Ada', role: 'member' }, { pubkey: 'bo', name: 'Bo', role: 'member' }, { pubkey: 'obi', name: 'Obi', role: 'observer' },
];
const card = (over: Record<string, unknown> = {}) => ({
    id: 'g1', authorPubkey: 'bo', title: 'Cyd leads', description: 'Lou has stepped back from the guild.', effect: 'replace_lead_convenor',
    subject: 'cyd', params: null, status: 'open', opensAt: new Date().toISOString(), scopeKind: 'group', scopeId: 'grp',
    closesAt: new Date(Date.now() + 6 * 86400_000 + 60_000).toISOString(), tally: { voted: 2, roll: 4, quorumRequired: 3, thresholdRequired: 0.5 },
    myVote: null, ...over,
});

beforeEach(() => {
    vi.mocked(api.getGroupDecisions).mockReset();
    vi.mocked(api.proposeGroupDecision).mockClear();
    vi.mocked(api.voteGroupDecision).mockClear();
});

describe("a chat group's Decisions block (DESIGN-group-decisions S3)", () => {
    it('open: turnout only and Yes / No; closed: the split, in the group\'s words', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({
            decisions: [card({ canVote: true }), card({ id: 'g2', title: 'Close it', effect: 'close_group', subject: null, status: 'unresolved',
                // What the node writes when too few voted: the card says it in plain words (#1784 review N5).
                executionReason: 'Quorum not met (1/3)', canVote: false,
                tally: { voted: 1, roll: 4, quorumRequired: 3, thresholdRequired: 0.6, yes: 1, no: 0 } })] as never,
            canPropose: true, rollSize: 4, onRoll: true, closedAt: null,
        });
        const changed = vi.fn();
        render(<GroupDecisions groupId="grp" myPubkey={ME} people={people} joinPolicy="open" onChanged={changed} />);
        const block = await screen.findByTestId('group-decisions');
        const tallies = within(block).getAllByTestId('scoped-tally');
        expect(tallies[0]).toHaveTextContent('2 of 4 have voted. 3 must vote. Yes and No show when it closes.');
        expect(tallies[0].textContent).not.toMatch(/Yes \d|No \d/);
        expect(tallies[1]).toHaveTextContent('Yes 1 · No 0. 1 of 4 voted.');
        expect(within(block).getByText('Make Cyd the lead convenor')).toBeInTheDocument();
        expect(within(block).getByText(/Not enough people voted/)).toBeInTheDocument();
        fireEvent.click(within(block).getByRole('button', { name: 'Vote Yes on Cyd leads' }));
        await waitFor(() => expect(api.voteGroupDecision).toHaveBeenCalledWith('grp', 'g1', true));
        await waitFor(() => expect(changed).toHaveBeenCalled());
    });

    it('an observer sees the votes but no Yes / No and no propose button', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({ decisions: [card({ canVote: false })] as never, canPropose: false, rollSize: 4, onRoll: false, watching: true, closedAt: null });
        render(<GroupDecisions groupId="grp" myPubkey="obi" people={people} />);
        const block = await screen.findByTestId('group-decisions');
        expect(within(block).getByText(/You watch this group/)).toBeInTheDocument();
        expect(within(block).queryByRole('button', { name: /Vote Yes/ })).toBeNull();
        expect(within(block).queryByRole('button', { name: 'Propose a vote' })).toBeNull();
    });

    it('a closed group: its votes to read, nothing to propose', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({
            decisions: [card({ status: 'executed', effect: 'close_group', subject: null, tally: { voted: 4, roll: 4, quorumRequired: 3, thresholdRequired: 0.6, yes: 4, no: 0 } })] as never,
            canPropose: false, rollSize: 4, onRoll: true, closedAt: new Date().toISOString(),
        });
        render(<GroupDecisions groupId="grp" myPubkey={ME} people={people} />);
        const block = await screen.findByTestId('group-decisions');
        expect(within(block).getByText('Close the group. Its chat stays to read.')).toBeInTheDocument();
        expect(within(block).queryByRole('button', { name: 'Propose a vote' })).toBeNull();
    });

    it('the form: a role vote names a member, a join rule names a policy; no recipient, no amount', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 4, onRoll: true, closedAt: null });
        render(<GroupDecisions groupId="grp" myPubkey={ME} people={people} joinPolicy="open" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Propose a vote' }));
        const form = screen.getByTestId('propose-group-decision');
        expect(within(form).queryByLabelText(/Beans/)).toBeNull();
        fireEvent.click(within(form).getByRole('radio', { name: 'Make someone a convenor' }));
        // Members on the roll only: never the lead, a convenor or an observer.
        expect(within(form).getAllByRole('radio').map(r => r.textContent)).toEqual(expect.arrayContaining(['Ada (you)', 'Bo']));
        expect(within(form).queryByRole('radio', { name: 'Obi' })).toBeNull();
        expect(within(form).queryByRole('radio', { name: 'Lou' })).toBeNull();
        fireEvent.click(within(form).getByRole('radio', { name: 'Bo' }));
        fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Bo convenes' } });
        fireEvent.change(within(form).getByLabelText('Why?'), { target: { value: 'Bo runs the Tuesday sessions.' } });
        fireEvent.click(within(form).getByRole('button', { name: 'Open the vote' }));
        await waitFor(() => expect(api.proposeGroupDecision).toHaveBeenCalledWith('grp', {
            title: 'Bo convenes', description: 'Bo runs the Tuesday sessions.', effect: 'set_group_role', subject: 'bo', params: { role: 'convenor' },
        }));
    });

    it('the join rule: every policy but the group\'s own', async () => {
        vi.mocked(api.getGroupDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 4, onRoll: true, closedAt: null });
        render(<GroupDecisions groupId="grp" myPubkey={ME} people={people} joinPolicy="open" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Propose a vote' }));
        const form = screen.getByTestId('propose-group-decision');
        fireEvent.click(within(form).getByRole('radio', { name: 'Change who can join' }));
        expect(within(form).queryByRole('radio', { name: /^Open/ })).toBeNull();
        fireEvent.click(within(form).getByRole('radio', { name: 'Invite only' }));
        fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Invite only' } });
        fireEvent.change(within(form).getByLabelText('Why?'), { target: { value: 'Strangers keep joining to sell things.' } });
        fireEvent.click(within(form).getByRole('button', { name: 'Open the vote' }));
        await waitFor(() => expect(api.proposeGroupDecision).toHaveBeenCalledWith('grp', expect.objectContaining({ effect: 'set_join_policy', params: { policy: 'invite_only' } })));
    });
});
