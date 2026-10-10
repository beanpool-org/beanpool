import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', () => ({
    getEnterpriseDecisions: vi.fn(),
    proposeEnterpriseDecision: vi.fn(async () => ({ success: true })),
    voteEnterpriseDecision: vi.fn(async () => ({ success: true })),
}));
import * as api from '../lib/api';
import { EnterpriseDecisions } from './EnterpriseDecisions';

const ME = 'b'.repeat(64);
const keepers = [
    { publicKey: 'a'.repeat(64), callsign: 'Ann', role: 'lead' },
    { publicKey: ME, callsign: 'Bob', role: 'keeper' },
    { publicKey: 'c'.repeat(64), callsign: 'Cat', role: 'keeper' },
];
const card = (over: Record<string, unknown> = {}) => ({
    id: 'd1', authorPubkey: 'a'.repeat(64), title: 'Pay Cat for the oven', description: 'Cat fixed the oven door.', effect: 'pay_out',
    subject: 'c'.repeat(64), params: { amount: 40 }, status: 'open', opensAt: new Date().toISOString(),
    closesAt: new Date(Date.now() + 3 * 86400_000 + 60_000).toISOString(), tally: { voted: 1, roll: 3, quorumRequired: 2, thresholdRequired: 0.6 },
    myVote: null, ...over,
});

beforeEach(() => { vi.mocked(api.getEnterpriseDecisions).mockReset(); vi.mocked(api.proposeEnterpriseDecision).mockClear(); vi.mocked(api.voteEnterpriseDecision).mockClear(); });

describe("an enterprise's Decisions block (DESIGN-group-decisions S2)", () => {
    it('open: turnout only and Yes / No; closed: the split', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({
            decisions: [card(), card({ id: 'd2', title: 'Remove Ann', effect: 'remove_keeper', subject: 'a'.repeat(64), status: 'executed', params: null,
                tally: { voted: 3, roll: 3, quorumRequired: 2, thresholdRequired: 0.6, yes: 2, no: 1 } })] as never,
            canPropose: true, rollSize: 3,
        });
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} lifecycle="ongoing" />);
        const tallies = await screen.findAllByTestId('scoped-tally');
        expect(tallies[0]).toHaveTextContent('1 of 3 have voted. 2 must vote. Yes and No show when it closes.');
        expect(tallies[0].textContent).not.toMatch(/Yes \d|No \d/);
        expect(tallies[1]).toHaveTextContent('Yes 2 · No 1. 3 of 3 voted.');
        expect(screen.getByText('Pay 40 Beans to Cat')).toBeInTheDocument();
        // The proposer's "Why?" is part of what the keepers vote on (design §2.5), on every card.
        expect(screen.getAllByTestId('scoped-why').map(p => p.textContent)).toEqual(['Cat fixed the oven door.', 'Cat fixed the oven door.']);
        fireEvent.click(screen.getByRole('button', { name: 'Vote Yes on Pay Cat for the oven' }));
        await waitFor(() => expect(api.voteEnterpriseDecision).toHaveBeenCalledWith('ent', 'd1', true));
        expect(document.body.textContent).not.toMatch(/Ʀ/);
    });

    it('nothing for someone the node does not answer, and no propose button for a roll of one', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue(null);
        const { container, rerender } = render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} />);
        await waitFor(() => expect(api.getEnterpriseDecisions).toHaveBeenCalled());
        expect(container.innerHTML).toBe('');
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [], canPropose: false, rollSize: 1 });
        rerender(<EnterpriseDecisions treasuryKey="ent2" myPubkey={ME} keepers={keepers.slice(1, 2)} balance={120} />);
        await waitFor(() => expect(api.getEnterpriseDecisions).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('button', { name: 'Propose a vote' })).toBeNull();
    });

    it('the pay-out form: the person from the roll (never yourself), the amount ≤ held, the 1.5% fee shown, then sent', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 3 });
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} lifecycle="ongoing" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Propose a vote' }));
        expect(screen.queryByRole('radio', { name: /Bob/ })).toBeNull();
        expect(screen.getByRole('radio', { name: 'Make another keeper the lead' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: 'Cat' }));
        fireEvent.change(screen.getByLabelText('How many Beans?'), { target: { value: '121' } });
        expect(screen.getByText("The enterprise holds 120 Beans, so it can't pay more than that.")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('How many Beans?'), { target: { value: '40' } });
        expect(screen.getByTestId('scoped-fee')).toHaveTextContent('Cat receives 39.4 Beans. The 1.5% trade fee (0.6 Beans) goes to the Commons.');
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Pay Cat for the oven' } });
        fireEvent.change(screen.getByLabelText('Why?'), { target: { value: 'Cat fixed the oven door last week.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Open the vote' }));
        await waitFor(() => expect(api.proposeEnterpriseDecision).toHaveBeenCalledWith('ent', {
            title: 'Pay Cat for the oven', description: 'Cat fixed the oven door last week.', effect: 'pay_out', params: { to: 'c'.repeat(64), amount: 40 },
        }));
    });

    it('what it holds, rounded down to cents (review opus-1767 N8)', async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 3 });
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={112.3125} lifecycle="ongoing" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Propose a vote' }));
        expect(screen.getByText('It holds 112.31 Beans now.')).toBeInTheDocument();
    });

    it("a project: no vote takes it off its leader; the words are a project's", async () => {
        vi.mocked(api.getEnterpriseDecisions).mockResolvedValue({ decisions: [], canPropose: true, rollSize: 3 });
        render(<EnterpriseDecisions treasuryKey="ent" myPubkey={ME} keepers={keepers} balance={120} lifecycle="bounded" />);
        fireEvent.click(await screen.findByRole('button', { name: 'Propose a vote' }));
        expect(screen.queryByRole('radio', { name: 'Make another keeper the lead' })).toBeNull();
        fireEvent.click(screen.getByRole('radio', { name: 'Remove a collaborator' }));
        expect(screen.queryByRole('radio', { name: 'Ann' })).toBeNull();
    });
});
