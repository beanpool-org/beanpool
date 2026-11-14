/**
 * The credit bar's R2 and R3 on the web Ledger (DESIGN-credit-bar-amend-fable.md §6, §7, §11; Marty decided the amendment on
 * 14 Nov 2026):
 * - R2: a tap on the card opens the sheet "Your Beans and your credit line" with the same six parts as the phone's, every
 *   part's words and figures equal to core's creditSheet() for the member's own answer; Escape and ✕ close it.
 * - R3: a voucher's row reads "Vouching budget" with its line (an owner's with theirs); with no debt and no pay-back link
 *   nothing about the Commons is drawn above the tabs; the Wallet tab has the row Pay the Commons with its line.
 * - One repayment for both (review of #3137): a payment from the Wallet's row changes the notice above the tabs (and settled,
 *   it goes); a debt paid off at the top leaves no code of it in the Wallet's form.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPAYMENT_WORDS } from '../lib/debts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { forgetRecentLookups } from '../lib/members-on-demand';
import { resetReaderFeaturesOnce } from '../lib/features';
import { LedgerPage } from './LedgerPage';
import { getBalance, getMyVouching, getTransactions } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { backToEnglish, bypassing, showIn, xx } from '../words-w2.test-support';
import { CREDIT_SHEET_PARTS, creditSheet } from '@beanpool/core';

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({ getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}) }));
vi.mock('../components/CommonsInfoModal', () => ({ CommonsInfoModal: () => null }));
const debts = vi.hoisted(() => ({ getMyRepayment: vi.fn(async (): Promise<unknown> => null), payTheCommons: vi.fn() }));
vi.mock('../lib/debts', async (orig) => ({ ...(await orig<typeof import('../lib/debts')>()), ...debts }));
vi.mock('../lib/api', () => ({
    getBalance: vi.fn(),
    getMyVouching: vi.fn(async () => null),
    getTransactions: vi.fn(async () => []),
    getMembers: vi.fn(async () => []),
    getMemberCards: vi.fn(async () => []),
    sendTransfer: vi.fn(),
    request: vi.fn(),
    getCommunityMe: vi.fn(async () => ({ features: null })),
}));
vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn(async () => ({ profile: 'local', features: {} })), resetCommunityInfoOnce: vi.fn() }));

const identity: BeanPoolIdentity = { publicKey: '9'.repeat(64), privateKey: 'p', callsign: 'Visitor', createdAt: '2026-09-17T00:00:00.000Z' };

/** Owes 50 of a 500 line, all of it one vouch, one live Offer; nothing traded yet. Every figure whole hundredths. */
const VOUCHED = {
    balance_c: -5000, floor_c: -50000, usableFloor_c: -50000, knownGrant_c: 0, roomHeld_c: 50000, earnedCredit_c: 0, liveOffers: 1,
    vouchedBy: [{ callsign: 'Jane', amount_c: 50000 }], qualifiedValue: 0, avgRating: 0, reviewCount: 0,
    activated: true, commonsBalance_c: 1250, callsign: 'Visitor', tier: { name: 'Newcomer' },
};
const VOUCHER = {
    voucher: true,
    budget: { left: 55000, held: 10000, heldInvites: 1, vouched: 35000, peopleVouched: 4, level: 100000 },
    presets: [2500, 5000, 7500, 10000], vouchMax: 10000, budgetMax: 200000, vouchedBy: [], history: [],
};

beforeEach(() => {
    vi.clearAllMocks();
    forgetRecentLookups();
    resetReaderFeaturesOnce();
    debts.getMyRepayment.mockResolvedValue(null);
});
afterEach(() => { cleanup(); backToEnglish(); });

async function open(balance: Record<string, unknown> = VOUCHED) {
    vi.mocked(getBalance).mockResolvedValue(balance as any);
    const onNavigate = vi.fn();
    render(<LedgerPage identity={identity} isMember={true} onNavigate={onNavigate} />);
    await waitFor(() => expect(getTransactions).toHaveBeenCalled());
    await screen.findByTestId('credit-card');
    return onNavigate;
}

describe('R2: the card opens the sheet, the same six parts as core\'s', () => {
    it('a tap opens "Your Beans and your credit line": six parts in order, each one\'s words and figures core\'s own', async () => {
        await open();
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByTestId('credit-card'));
        const dialog = screen.getByRole('dialog', { name: 'Your Beans and your credit line' });
        const sheet = creditSheet(VOUCHED, { qualifiedValue: VOUCHED.qualifiedValue, avgRating: 0, reviewCount: 0 });
        const parts = within(dialog).getAllByTestId(/^credit-sheet-part-/);
        expect(parts.map((p) => p.dataset.testid)).toEqual(CREDIT_SHEET_PARTS.map((id) => `credit-sheet-part-${id}`));
        sheet.parts.forEach((part, i) => {
            const el = parts[i]!;
            expect(within(el).getByRole('heading', { level: 3 }).textContent).toBe(`${i + 1}.${part.title}`);
            for (const row of part.rows) {
                expect(el.textContent).toContain(row.text);
                if (row.line) expect(el.textContent).toContain(row.line);
            }
        });
        // The member's own figures: the line part by part, what is open, and their earning.
        expect(parts[1]!.textContent).toContain('Your credit line: 500');
        expect(parts[1]!.textContent).toContain('@Jane vouched 500');
        expect(parts[1]!.textContent).toContain('You have 1 live Offer: all 500 is open.');
        expect(parts[2]!.textContent).toContain('Nothing traded in the market yet. Your first 100 Beans traded add about 37.');
        // The old modal's words are nowhere.
        expect(dialog.textContent).not.toMatch(/Credit Slider|Sweet Spot|Overdraft|Fee-Free/i);
    });

    it('Escape and ✕ close it, focus back on the card; More in the guide opens the credit-line page', async () => {
        const onNavigate = await open();
        const card = screen.getByTestId('credit-card');
        card.focus();
        fireEvent.click(card);
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your Beans and your credit line' }));
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(card);
        fireEvent.click(card);
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(card);
        fireEvent.click(screen.getByTestId('credit-sheet-guide'));
        expect(onNavigate).toHaveBeenCalledWith('guide', 'credit-line');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('in the pseudo-locale every word of the sheet goes through the words layer', async () => {
        await showIn('xx');
        await open();
        fireEvent.click(screen.getByTestId('credit-card'));
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).getByRole('heading', { level: 2 }).textContent).toBe(xx('Your Beans and your credit line'));
        expect(bypassing(dialog)).toEqual([]);
    });
});

describe('R3: the vouching budget, and Pay the Commons', () => {
    it('a voucher\'s row reads "Vouching budget" with its line; never "Your budget:"', async () => {
        vi.mocked(getMyVouching).mockResolvedValue(VOUCHER as any);
        await open();
        const row = await screen.findByTestId('ledger-budget-row');
        expect(row.textContent).toContain('Vouching budget: 550 of 1,000 left');
        expect(within(row).getByTestId('ledger-budget-line').textContent).toBe('What you can give other members as credit line when you vouch for them. Not Beans, and not your own spending.');
        expect(document.body.textContent).not.toContain('Your budget:');
        fireEvent.click(row);
        expect(screen.getByRole('dialog', { name: 'Your vouching budget' })).toBeInTheDocument();
    });

    it('an owner\'s row: "Vouching budget: no limit" and the owner\'s line', async () => {
        vi.mocked(getMyVouching).mockResolvedValue({ ...VOUCHER, noLimit: true } as any);
        await open();
        const row = await screen.findByTestId('ledger-budget-row');
        expect(row.textContent).toContain('Vouching budget: no limit');
        expect(within(row).getByTestId('ledger-budget-line').textContent).toBe('As an owner you can vouch for members without a limit. This is credit line you give to others: not Beans, and not your own spending.');
    });

    it('with no debt and no pay-back link nothing about the Commons is drawn above the tabs; the Wallet has the row with its line', async () => {
        await open();
        await waitFor(() => expect(debts.getMyRepayment).toHaveBeenCalled());
        expect(screen.queryByTestId('ledger-repayment')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Pay the Commons' })).toBeNull();
        expect(screen.queryByText('Pay the Commons')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        const row = await screen.findByRole('button', { name: 'Pay the Commons' });
        expect(row).toHaveAccessibleDescription('Give Beans you hold to your community’s shared pot, or pay back a debt with a code from an admin.');
        expect(within(screen.getByTestId('ledger-wallet')).getByTestId('ledger-pay-commons-row')).toBe(row);
    });

    it('working a debt off: the notice above the tabs holds Pay back now, which opens the form with their code filled in', async () => {
        const CODE = 'd'.repeat(32);
        debts.getMyRepayment.mockResolvedValue({ debtId: CODE, amount_c: 30000, repaid_c: 18000, left_c: 12000 } as any);
        await open();
        const notice = await screen.findByTestId('ledger-repayment');
        fireEvent.click(within(notice).getByRole('button', { name: 'Pay back now' }));
        expect(within(notice).getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
    });
});

describe('one repayment for the notice and the Wallet\'s row (review of #3137)', () => {
    const CODE = 'e'.repeat(32);
    /** The node's debt, as getMyRepayment answers it; each payment with its code comes off it (null once settled). */
    let debt: { debtId: string; amount_c: number; repaid_c: number; left_c: number } | null;
    beforeEach(() => {
        debt = { debtId: CODE, amount_c: 30000, repaid_c: 12000, left_c: 18000 };
        debts.getMyRepayment.mockImplementation(async () => debt);
        debts.payTheCommons.mockImplementation(async ({ body }: { body: { amount_c: number; debtId?: string } }) => {
            if (!debt || body.debtId !== CODE) return { transactionId: `tx-${body.amount_c}`, amount_c: body.amount_c };
            const left = debt.left_c;
            const after = left - body.amount_c;
            debt = after > 0 ? { ...debt, repaid_c: debt.repaid_c + body.amount_c, left_c: after } : null;
            return { transactionId: `tx-${body.amount_c}`, amount_c: body.amount_c, left_c: left, leftAfter_c: Math.max(after, 0), settled: after <= 0 };
        });
        vi.spyOn(window, 'confirm').mockReturnValue(true);
    });
    afterEach(() => { vi.mocked(window.confirm).mockRestore(); });

    const payInWallet = (beans: string) => {
        const wallet = screen.getByTestId('ledger-wallet');
        fireEvent.click(within(wallet).getByRole('button', { name: 'Pay the Commons' }));
        expect(within(wallet).getByLabelText(/PAY-BACK CODE/)).toHaveValue(CODE);
        fireEvent.change(within(wallet).getByLabelText(/BEANS/), { target: { value: beans } });
        fireEvent.click(within(wallet).getByRole('button', { name: 'Pay the Commons' }));
    };

    it('paid from the Wallet\'s row, the notice above the tabs shows what is left now; settled, it goes; one read for both cards', async () => {
        await open();
        expect(within(await screen.findByTestId('ledger-repayment')).getByRole('status')).toHaveTextContent('180 Beans left of 300 Beans');
        expect(debts.getMyRepayment).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        payInWallet('80');
        expect(await within(screen.getByTestId('ledger-wallet')).findByText('Paid 80 Beans to the Commons. That came off your debt: 100 Beans left.')).toBeInTheDocument();
        await waitFor(() => expect(within(screen.getByTestId('ledger-repayment')).getByRole('status')).toHaveTextContent('100 Beans left of 300 Beans'));
        expect(within(screen.getByTestId('ledger-repayment')).getByRole('button', { name: 'Pay back now' })).toBeInTheDocument();
        fireEvent.click(within(screen.getByTestId('ledger-wallet')).getByRole('button', { name: 'Done' }));
        payInWallet('100');
        expect(await within(screen.getByTestId('ledger-wallet')).findByText('Paid 100 Beans to the Commons. Your debt is paid off and settled.')).toBeInTheDocument();
        await waitFor(() => expect(screen.queryByTestId('ledger-repayment')).toBeNull());
        expect(screen.queryByRole('button', { name: 'Pay back now' })).toBeNull();
        expect(debts.getMyRepayment).toHaveBeenCalledTimes(3);
    });

    it('paid off from the notice while the Wallet is open, the Wallet\'s form holds no code of the settled debt and gives no warning about it', async () => {
        await open();
        fireEvent.click(screen.getByRole('button', { name: /Wallet/ }));
        const notice = await screen.findByTestId('ledger-repayment');
        fireEvent.click(within(notice).getByRole('button', { name: 'Pay back now' }));
        fireEvent.change(within(notice).getByLabelText(/BEANS/), { target: { value: '180' } });
        fireEvent.click(within(notice).getByRole('button', { name: 'Pay the Commons' }));
        expect(await within(notice).findByText('Paid 180 Beans to the Commons. Your debt is paid off and settled.')).toBeInTheDocument();
        await waitFor(() => expect(debts.getMyRepayment).toHaveBeenCalledTimes(2));
        const wallet = screen.getByTestId('ledger-wallet');
        fireEvent.click(within(wallet).getByRole('button', { name: 'Pay the Commons' }));
        await waitFor(() => expect(within(wallet).getByLabelText(/PAY-BACK CODE/)).toHaveValue(''));
        fireEvent.change(within(wallet).getByLabelText(/BEANS/), { target: { value: '5' } });
        fireEvent.click(within(wallet).getByRole('button', { name: 'Pay the Commons' }));
        expect(window.confirm).toHaveBeenLastCalledWith(REPAYMENT_WORDS.payConfirm(500, false, null, false));
        expect(vi.mocked(window.confirm).mock.lastCall![0]).not.toContain('won’t come off your debt');
    });
});
