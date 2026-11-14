import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

/**
 * The Ledger's repayment card (#1597 item 4; credit bar R3): at the top, the notice and its Pay back now only while the member
 * works a debt off (or the form, opened by an admin's pay-back link), nothing otherwise; in the Wallet, the row Pay the Commons
 * with its line, for everyone. The form (opened either way) checks
 * what is typed, asks first, pays with the code as the debt id, and shows what is left (or that it is settled) or the node's refusal.
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
        debts.getMyRepayment.mockResolvedValue({ amount_c: 30000, repaid_c: 12000, left_c: 18000 });
        const { unmount } = render(<RepaymentCard />);
        expect(await screen.findByRole('status')).toHaveTextContent('180 Beans left of 300 Beans');
        unmount();
        debts.getMyRepayment.mockResolvedValue(null);
        render(<RepaymentCard />);
        await waitFor(() => expect(debts.getMyRepayment).toHaveBeenCalledTimes(2));
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('pays for a debt after asking; a node that doesn’t say what is left gets the reference, and no promise', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-42', amount_c: 8000 });
        const onPaid = vi.fn();
        render(<RepaymentCard place="wallet" onPaid={onPaid} />);
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '80' } });
        fireEvent.change(screen.getByLabelText(/PAY-BACK CODE/), { target: { value: CODE } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        // A code typed by hand: the page doesn't know what is left, so it promises nothing and says the node refuses above it.
        expect(confirmSpy).toHaveBeenCalledWith(REPAYMENT_WORDS.payConfirm(8000, true, null)); // 80 typed: 8000 hundredths
        expect(confirmSpy.mock.calls[0][0]).toContain('It comes off your debt at once. If less is left now, your server refuses it and says how much, and nothing is paid.');
        expect(await screen.findByText('Paid 80 Beans to the Commons. Reference: tx-42')).toBeInTheDocument();
        expect(screen.queryByText(/settled|to an admin/)).toBeNull();
        expect(sentBody()).toEqual({ amount_c: 8000, debtId: CODE, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
        expect(onPaid).toHaveBeenCalled();
    });

    it('a bad amount or code is said and nothing is sent; cancelling the question sends nothing; a refusal is the node’s words', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        render(<RepaymentCard place="wallet" />);
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
        expect(sentBody()).toEqual({ amount_c: 500, requestId: expect.any(String) });
        // A proxy's page without the node's words: plain words, never its status text.
        debts.payTheCommons.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { status: 429, unsaid: true }));
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(await screen.findByText(PAY_REFUSED_UNSAID)).toBeInTheDocument();
        expect(screen.queryByText(/Too Many Requests/)).toBeNull();
    });

    it('the link’s amount is prefilled, called what was left when the admin shared it; 150 of 300 comes off it, and 150 is left', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-150', amount_c: 15000, left_c: 30000, leftAfter_c: 15000, settled: false });
            render(<RepaymentCard />);
            expect(screen.getByLabelText(/BEANS/)).toHaveValue('300');
            expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
            expect(screen.getByText('What was left when the admin shared this: 300 Beans.')).toBeInTheDocument();
            fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '150' } });
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(confirmSpy.mock.calls[0][0]).toContain('300 Beans was what was left when the admin shared this. It comes off your debt at once.');
            expect(await screen.findByText('Paid 150 Beans to the Commons. That came off your debt: 150 Beans left.')).toBeInTheDocument();
            expect(screen.queryByText(/settled|to an admin/)).toBeNull();
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('the whole amount from the link: the confirm never says it covers what is left; the settle is promised once the node says it does', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-300', amount_c: 30000, left_c: 30000, leftAfter_c: 0, settled: true });
            render(<RepaymentCard />);
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(confirmSpy.mock.calls[0][0]).toContain('300 Beans was what was left when the admin shared this.');
            expect(confirmSpy.mock.calls[0][0]).toContain('If less is left now, your server refuses it and says how much, and nothing is paid.');
            expect(confirmSpy.mock.calls[0][0]).not.toMatch(/covers|can settle your debt with it/);
            expect(await screen.findByText('Paid 300 Beans to the Commons. Your debt is paid off and settled.')).toBeInTheDocument();
            expect(sentBody()).toEqual({ amount_c: 30000, debtId: CODE, requestId: expect.any(String) });
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('a stale link (some worked off since): the node’s refusal with the true amount, nothing held; then paying that settles', async () => {
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            debts.getMyRepayment.mockResolvedValue(null);
            debts.payTheCommons.mockRejectedValueOnce(Object.assign(new Error('Only 200 Beans are left on that debt. Pay 200 Beans to settle it.'), { status: 409 }));
            debts.payTheCommons.mockResolvedValueOnce({ transactionId: 'tx-200', amount_c: 20000, left_c: 20000, leftAfter_c: 0, settled: true });
            render(<RepaymentCard />);
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(await screen.findByRole('alert')).toHaveTextContent('Only 200 Beans are left on that debt. Pay 200 Beans to settle it.');
            expect(screen.getByRole('button', { name: 'Pay the Commons' })).toBeInTheDocument();
            fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '200' } });
            fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
            expect(await screen.findByText('Paid 200 Beans to the Commons. Your debt is paid off and settled.')).toBeInTheDocument();
            expect(sentBody(1)).toEqual({ amount_c: 20000, debtId: CODE, requestId: expect.any(String) });
            expect(sentBody(1).requestId).not.toBe(sentBody(0).requestId);
        } finally { window.history.replaceState(null, '', '/'); }
    });

    it('no answer shows plain words that it may have paid, never "Failed to fetch" or "nothing was paid"; a second click sends nothing', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        let fail!: (e: unknown) => void;
        debts.payTheCommons.mockImplementation(() => new Promise((_, j) => { fail = j; }));
        render(<RepaymentCard place="wallet" />);
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
        debts.payTheCommons.mockResolvedValueOnce({ transactionId: 'tx-8', amount_c: 800 });
        render(<RepaymentCard place="wallet" />);
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
        expect(sentBody(2)).toEqual({ amount_c: 800, requestId: expect.any(String) });
        expect(confirmSpy).toHaveBeenCalledTimes(2);
        expect(sentBody(2).requestId).not.toBe(sentBody(0).requestId);
    });

    it('working a debt off, the notice\'s Pay back now opens the form with their own code, and the payment comes off the debt (confirmation 4)', async () => {
        debts.getMyRepayment.mockResolvedValue({ debtId: CODE, amount_c: 20000, repaid_c: 0, left_c: 20000 });
        debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-8', amount_c: 20000, left_c: 20000, leftAfter_c: 0, settled: true });
        render(<RepaymentCard />);
        expect(await screen.findByRole('status')).toHaveTextContent('You’re working off a debt to the Commons: 200 Beans left of 200 Beans. Every Bean you receive above 0 goes to the Commons until it is cleared. You can also pay some or all of it yourself: it comes off at once.');
        fireEvent.click(screen.getByRole('button', { name: 'Pay back now' }));
        expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '200' } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(confirmSpy).toHaveBeenCalledWith(REPAYMENT_WORDS.payConfirm(20000, true, null, false));
        expect(await screen.findByText('Paid 200 Beans to the Commons. Your debt is paid off and settled.')).toBeInTheDocument();
        expect(sentBody()).toEqual({ amount_c: 20000, debtId: CODE, requestId: expect.any(String) });
    });

    it('working a debt off, a payment without the code is said not to come off it, before and after, with the reference for an admin', async () => {
        debts.getMyRepayment.mockResolvedValue({ debtId: CODE, amount_c: 20000, repaid_c: 0, left_c: 20000 });
        debts.payTheCommons.mockResolvedValue({ transactionId: 'tx-9', amount_c: 5000 });
        render(<RepaymentCard />);
        await screen.findByRole('status');
        fireEvent.click(screen.getByRole('button', { name: 'Pay back now' }));
        // Cleared by the member: it stays cleared.
        fireEvent.change(screen.getByLabelText(/PAY-BACK CODE/), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText(/BEANS/), { target: { value: '50' } });
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        expect(confirmSpy).toHaveBeenCalledWith(REPAYMENT_WORDS.payConfirm(5000, false, null, true));
        expect(confirmSpy.mock.calls[0][0]).toContain('This won’t come off your debt: it has no pay-back code.');
        expect(await screen.findByText(/This did not come off your debt: it was paid without your pay-back code\. .*reference: tx-9\. Until an admin counts it, your debt is still being worked off: .*what you hold above 0\.$/)).toBeInTheDocument();
        expect(sentBody()).toEqual({ amount_c: 5000, requestId: expect.any(String) });
    });
});

describe('where Pay the Commons is drawn (credit bar R3, Marty\'s pick 2)', () => {
    it('at the top, with no debt and no pay-back link, nothing about the Commons is drawn', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        const { container } = render(<RepaymentCard />);
        await waitFor(() => expect(debts.getMyRepayment).toHaveBeenCalled());
        await Promise.resolve();
        expect(container.innerHTML).toBe('');
        expect(screen.queryByText(/Commons/)).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
    });

    it('at the top, working a debt off: the notice holds one real button, Pay back now, and no bare Pay the Commons words', async () => {
        debts.getMyRepayment.mockResolvedValue({ debtId: CODE, amount_c: 30000, repaid_c: 18000, left_c: 12000 });
        render(<RepaymentCard />);
        expect(await screen.findByRole('status')).toHaveTextContent('120 Beans left of 300 Beans');
        const notice = screen.getByRole('status').parentElement!;
        const button = screen.getByRole('button', { name: 'Pay back now' });
        expect(notice).toContainElement(button);
        expect(button.tagName).toBe('BUTTON');
        expect(screen.queryByRole('button', { name: 'Pay the Commons' })).toBeNull();
        expect(screen.queryByLabelText(/PAY-BACK CODE/)).toBeNull();
        fireEvent.click(button);
        expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
        expect(screen.queryByRole('button', { name: 'Pay back now' })).toBeNull();
    });

    it('in the Wallet: the row Pay the Commons with its line, for a member with no debt; it opens the form there', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        render(<RepaymentCard place="wallet" />);
        const row = screen.getByRole('button', { name: 'Pay the Commons' });
        expect(row).toHaveAccessibleDescription('Give Beans you hold to your community’s shared pot, or pay back a debt with a code from an admin.');
        expect(row).toHaveTextContent('Give Beans you hold to your community’s shared pot, or pay back a debt with a code from an admin.');
        fireEvent.click(row);
        expect(screen.getByRole('heading', { name: 'Pay the Commons' })).toBeInTheDocument();
        expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue('');
    });

    it('in the Wallet, working a debt off: no second notice, and the row\'s form has their own code filled in', async () => {
        debts.getMyRepayment.mockResolvedValue({ debtId: CODE, amount_c: 30000, repaid_c: 0, left_c: 30000 });
        render(<RepaymentCard place="wallet" />);
        await waitFor(() => expect(debts.getMyRepayment).toHaveBeenCalled());
        expect(screen.queryByRole('status')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Pay the Commons' }));
        await waitFor(() => expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE));
    });

    it('an admin\'s pay-back link opens the form at the top on its own, never a second one in the Wallet', async () => {
        debts.getMyRepayment.mockResolvedValue(null);
        window.history.replaceState(null, '', `/?payback=${CODE}&amount=300`);
        try {
            const top = render(<RepaymentCard />);
            expect(screen.getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
            top.unmount();
            render(<RepaymentCard place="wallet" />);
            expect(screen.queryByLabelText(/PAY-BACK CODE/)).toBeNull();
            expect(screen.getByRole('button', { name: 'Pay the Commons' })).toBeInTheDocument();
        } finally { window.history.replaceState(null, '', '/'); }
    });
});
