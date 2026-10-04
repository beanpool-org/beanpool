import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Ledger's repayment card (#1597 item 4): the banner only while the member works a debt off; Pay the Commons checks
 * what is typed, asks first, pays with the code as the debt id, and shows the reference or the node's refusal.
 * The requests themselves are lib/debts.test.ts's (signed, through the real `request`); here they are stubbed.
 */
const debts = vi.hoisted(() => ({ getMyRepayment: vi.fn(), payTheCommons: vi.fn() }));
vi.mock('../lib/debts', async (orig) => ({ ...(await orig<typeof import('../lib/debts')>()), ...debts }));

import { RepaymentCard } from './RepaymentCard';

const CODE = 'c'.repeat(32);
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    debts.getMyRepayment.mockReset();
    debts.payTheCommons.mockReset();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { confirmSpy.mockRestore(); });

describe('RepaymentCard', () => {
    it('shows what is left while they work a debt off, nothing when they owe nothing', async () => {
        debts.getMyRepayment.mockResolvedValue({ amount: 300, repaid: 120, left: 180 });
        const { unmount } = render(<RepaymentCard />);
        expect(await screen.findByRole('status')).toHaveTextContent('180 Beans left of 300 Beans');
        unmount();
        debts.getMyRepayment.mockResolvedValue(null);
        render(<RepaymentCard />);
        await waitFor(() => expect(debts.getMyRepayment).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('pays for a debt after asking, and shows the reference to give an admin', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-42', amount: 80 });
        const onPaid = vi.fn();
        render(<RepaymentCard onPaid={onPaid} />);
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '80' } });
        fireEvent.change(screen.getByLabelText(/PAY-BACK CODE/), { target: { value: CODE } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(confirmSpy).toHaveBeenCalledWith('Pay 80 Beans to the Commons for your debt? This can’t be undone.');
        expect(await screen.findByText(/Give this reference to an admin, who settles your debt with it: tx-42/)).toBeInTheDocument();
        expect(debts.payTheCommons).toHaveBeenCalledWith(80, CODE);
        expect(onPaid).toHaveBeenCalled();
    });

    it('a bad amount or code is said and nothing is sent; cancelling the question sends nothing; a refusal is the node’s words', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        render(<RepaymentCard />);
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '1.234' } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(screen.getByRole('alert')).toHaveTextContent('to the cent');
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '5' } });
        fireEvent.change(screen.getByLabelText(/PAY-BACK CODE/), { target: { value: 'nope' } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(screen.getByRole('alert')).toHaveTextContent('32 letters and digits');
        fireEvent.change(screen.getByLabelText(/PAY-BACK CODE/), { target: { value: '' } });
        confirmSpy.mockReturnValueOnce(false);
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(debts.payTheCommons).not.toHaveBeenCalled();
        debts.payTheCommons.mockRejectedValue(new Error('You hold 2 Beans: you can pay the Commons only what you hold.'));
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('You hold 2 Beans: you can pay the Commons only what you hold.');
        expect(debts.payTheCommons).toHaveBeenCalledWith(5, undefined);
    });
});
