import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

/**
 * The Ledger's repayment card (#1597 item 4): the banner only while the member works a debt off; Pay the Commons checks
 * what is typed, asks first, pays with the code as the debt id, and shows the reference or the node's refusal.
 * The requests themselves are lib/debts.test.ts's (signed, through the real `request`); here they are stubbed.
 */
const debts = vi.hoisted(() => ({ getMyRepayment: vi.fn(), payTheCommons: vi.fn() }));
vi.mock('../lib/debts', async (orig) => ({ ...(await orig<typeof import('../lib/debts')>()), ...debts }));

import { RepaymentCard } from './RepaymentCard';
import { REPAYMENT_WORDS, PAY_UNANSWERED } from '../lib/debts';

const CODE = 'c'.repeat(32);
let confirmSpy: MockInstance<typeof window.confirm>;

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
        // A code typed by hand: the page doesn't know what is left, so it promises nothing and says the one-payment rule.
        expect(confirmSpy).toHaveBeenCalledWith(REPAYMENT_WORDS.payConfirm(80, true, null));
        expect(confirmSpy.mock.calls[0][0]).toContain('only if this one payment is at least what is left');
        expect(await screen.findByText(/Give this reference to an admin\. It settles your debt only if this one payment is at least what was left to repay.*tx-42/)).toBeInTheDocument();
        expect(screen.queryByText(/who settles your debt with it/)).toBeNull();
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
        // As `request` throws a refusal: the node's words, with its status.
        debts.payTheCommons.mockRejectedValue(Object.assign(new Error('You hold 2 Beans: you can pay the Commons only what you hold.'), { status: 409 }));
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('You hold 2 Beans: you can pay the Commons only what you hold.');
        expect(debts.payTheCommons).toHaveBeenCalledWith(5, undefined);
    });

    it('the link’s amount is prefilled; 150 of the 300 left is said not to settle the debt, before and after paying', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-150', amount: 150 });
            render(<RepaymentCard />);
            expect(screen.getByLabelText(/BEANS/)).toHaveValue('300');
            expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
            fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '150' } });
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(confirmSpy.mock.calls[0][0]).toContain('300 Beans are left, so this payment won’t settle your debt');
            expect(await screen.findByText(/That is less than the 300 Beans left, so it won’t settle your debt.*tx-150/)).toBeInTheDocument();
            expect(screen.queryByText(/who settles your debt with it/)).toBeNull();
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('the whole amount from the link promises the settle', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-300', amount: 300 });
            render(<RepaymentCard />);
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(confirmSpy.mock.calls[0][0]).toContain('It covers the 300 Beans left, so an admin can settle your debt with it.');
            expect(await screen.findByText(/Give this reference to an admin, who settles your debt with it: tx-300/)).toBeInTheDocument();
            expect(debts.payTheCommons).toHaveBeenCalledWith(300, CODE);
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('no answer shows plain words that it may have paid, never "Failed to fetch" or "nothing was paid"; a second click sends nothing', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        let fail!: (e: unknown) => void;
        debts.payTheCommons.mockImplementation(() => new Promise((_, j) => { fail = j; }));
        render(<RepaymentCard />);
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '5' } });
        const payButton = screen.getByRole('button', { name: 'Pay the Commons' });
        fireEvent.click(payButton);
        fireEvent.click(payButton);
        expect(debts.payTheCommons).toHaveBeenCalledTimes(1);
        fail(new TypeError('Failed to fetch'));
        expect(await screen.findByRole('alert')).toHaveTextContent(PAY_UNANSWERED);
        expect(screen.queryByText(/Failed to fetch/)).toBeNull();
        expect(screen.queryByText(/Nothing was/)).toBeNull();
    });
});
