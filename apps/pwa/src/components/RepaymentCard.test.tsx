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
import { REPAYMENT_WORDS, PAY_UNANSWERED_RETRY, PAY_REFUSED_UNSAID } from '../lib/debts';

const CODE = 'c'.repeat(32);
/** The confirmed payment the card sent on its `n`th send (from 0): its body, with the payment's id. */
const sentBody = (n = -1) => debts.payTheCommons.mock.calls.at(n)![0].body;
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
        expect(sentBody()).toEqual({ amount: 80, debtId: CODE, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
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
        expect(sentBody()).toEqual({ amount: 5, requestId: expect.any(String) });
        // A proxy's page without the node's words: plain words, never its status text.
        debts.payTheCommons.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429, unsaid: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(await screen.findByText(PAY_REFUSED_UNSAID)).toBeInTheDocument();
        expect(screen.queryByText(/Too Many Requests/)).toBeNull();
    });

    it('the link’s amount is prefilled, called what was left when the admin shared it; 150 of 300 is said not to settle, before and after paying', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-150', amount: 150, left: 300 });
            render(<RepaymentCard />);
            expect(screen.getByLabelText(/BEANS/)).toHaveValue('300');
            expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
            expect(screen.getByText('What was left when the admin shared this: 300 Beans.')).toBeInTheDocument();
            fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '150' } });
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(confirmSpy.mock.calls[0][0]).toContain('300 Beans was what was left when the admin shared this. This payment is less, so it won’t settle your debt');
            expect(await screen.findByText(/That is less than the 300 Beans left, so it won’t settle your debt.*tx-150/)).toBeInTheDocument();
            expect(screen.queryByText(/who settles your debt with it/)).toBeNull();
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('the whole amount from the link: the confirm never says it covers what is left; the settle is promised once the node says it does', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-300', amount: 300, left: 300 });
            render(<RepaymentCard />);
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(confirmSpy.mock.calls[0][0]).toContain('300 Beans was what was left when the admin shared this.');
            expect(confirmSpy.mock.calls[0][0]).toContain('If some was worked off since, your server refuses a payment above what is left and says how much, and nothing is paid.');
            expect(confirmSpy.mock.calls[0][0]).not.toMatch(/covers|can settle your debt with it/);
            expect(await screen.findByText(/Give this reference to an admin, who settles your debt with it: tx-300/)).toBeInTheDocument();
            expect(sentBody()).toEqual({ amount: 300, debtId: CODE, requestId: expect.any(String) });
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('a stale link (some worked off since): the node’s refusal with the true amount, nothing held; then paying that settles', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockRejectedValueOnce(Object.assign(new Error('Only 200 Beans are left on that debt. Pay 200 Beans to settle it.'), { status: 409 }));
            debts.payTheCommons.mockResolvedValueOnce({ transactionId: 'tx-200', amount: 200, left: 200 });
            render(<RepaymentCard />);
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(await screen.findByRole('alert')).toHaveTextContent('Only 200 Beans are left on that debt. Pay 200 Beans to settle it.');
            expect(screen.getByRole('button', { name: 'Pay the Commons' })).toBeInTheDocument();
            fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '200' } });
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(await screen.findByText(/Give this reference to an admin, who settles your debt with it: tx-200/)).toBeInTheDocument();
            expect(sentBody(1)).toEqual({ amount: 200, debtId: CODE, requestId: expect.any(String) });
            expect(sentBody(1).requestId).not.toBe(sentBody(0).requestId);
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
        expect(await screen.findByRole('alert')).toHaveTextContent(PAY_UNANSWERED_RETRY);
        expect(screen.queryByText(/Failed to fetch/)).toBeNull();
        expect(screen.queryByText(/Nothing was/)).toBeNull();
    });

    it('a lost answer keeps the confirmed payment: Try again sends the same id with no new question; a change drops it', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        debts.payTheCommons.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { status: 502, unsaid: true }));
        debts.payTheCommons.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        debts.payTheCommons.mockResolvedValueOnce({ transactionId: 'tx-8', amount: 8 });
        render(<RepaymentCard />);
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(PAY_UNANSWERED_RETRY);
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
        await waitFor(() => expect(debts.payTheCommons).toHaveBeenCalledTimes(2));
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(sentBody(1)).toBe(sentBody(0));
        // The member changes the amount: that is a new payment, asked again, with a new id.
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '8' } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(await screen.findByText(/Paid 8 Beans to the Commons/)).toBeInTheDocument();
        expect(sentBody(2)).toEqual({ amount: 8, requestId: expect.any(String) });
        expect(confirmSpy).toHaveBeenCalledTimes(2);
        expect(sentBody(2).requestId).not.toBe(sentBody(0).requestId);
    });
});
