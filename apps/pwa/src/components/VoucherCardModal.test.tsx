import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { VoucherCardModal } from './VoucherCardModal';
import * as api from '../lib/api';

vi.mock('../lib/api', () => ({
    getVoucherCard: vi.fn(),
    setVoucherBudget: vi.fn(),
    stopVoucher: vi.fn(),
}));

const SAMPLE_CARD: api.VoucherCardData = {
    memberPubkey: '1111111111111111111111111111111111111111111111111111111111111111',
    callsign: 'jane',
    source: 'entry',
    entryId: 'entry-1',
    madeBy: '2222222222222222222222222222222222222222222222222222222222222222',
    madeByCallsign: 'marty',
    madeAt: '2026-11-01T00:00:00Z',
    stoppedAt: null,
    stopReason: null,
    left: 55000,
    held: 35000,
    heldInvites: 2,
    vouched: 10000,
    peopleVouched: 1,
    level: 100000,
    belowZero: 0,
    writtenOff: 0,
    passedOn: { amount_c: 0, people: 0 },
    invitesWithVouch: 3,
    trading: { withOthers: 1, insideOnly: 0 },
    canChange: true,
    history: [
        {
            kind: 'grant',
            amount_c: 100000,
            actor: '3333333333333333333333333333333333333333333333333333333333333333',
            actorCallsign: 'marty',
            at: '2026-11-01T00:00:00Z',
        },
        {
            kind: 'hold',
            amount_c: -10000,
            actor: '1111111111111111111111111111111111111111111111111111111111111111',
            actorCallsign: 'jane',
            at: '2026-11-02T00:00:00Z',
            for: 'invite',
            outcome: 'held',
        },
        {
            kind: 'return',
            amount_c: 10000,
            actor: 'node',
            actorCallsign: null,
            at: '2026-11-03T00:00:00Z',
            for: 'invite',
            why: 'expired',
        },
        {
            kind: 'top_up',
            amount_c: 50000,
            actor: '4444444444444444444444444444444444444444444444444444444444444444',
            actorCallsign: 'damo',
            at: '2026-11-04T00:00:00Z',
        },
    ],
    people: [
        {
            memberPubkey: '5555555555555555555555555555555555555555555555555555555555555555',
            callsign: 'sam',
            joinedAt: '2026-11-02T00:00:00Z',
            amount_c: 10000,
            raised: false,
            byInvite: true,
            belowZero: false,
            left: false,
            writtenOff: 0,
            vouchesForMe: false,
            trading: 'others',
        },
    ],
};

describe('VoucherCardModal (slice V3, §5, §10)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.getVoucherCard).mockResolvedValue(SAMPLE_CARD);
    });

    it('Stop vouching shows only where the node says this viewer may stop it (canStop; an admin\'s budget is an owner\'s, I5), asks first, then stops', async () => {
        vi.mocked(api.getVoucherCard).mockResolvedValue({ ...SAMPLE_CARD, source: 'role', canStop: true });
        vi.mocked(api.stopVoucher).mockResolvedValue({ ...SAMPLE_CARD, source: 'role', stoppedAt: '2026-11-10T00:00:00Z', stopReason: 'stopped', left: 0, held: 0, level: 0 });
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        const onUpdated = vi.fn();
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} onUpdated={onUpdated} />);
        const stop = await screen.findByTestId('voucher-stop');
        expect(stop).toHaveTextContent('Stop vouching');
        expect(stop.className).toMatch(/min-h-\[44px\]/);
        fireEvent.click(stop);
        expect(api.stopVoucher).not.toHaveBeenCalled();
        fireEvent.click(stop);
        await waitFor(() => expect(api.stopVoucher).toHaveBeenCalledWith(SAMPLE_CARD.memberPubkey));
        expect(confirmSpy.mock.calls[0][0]).toContain('Stop @jane from vouching?');
        await waitFor(() => expect(screen.queryByTestId('voucher-stop')).toBeNull());
        expect(onUpdated).toHaveBeenCalled();
        confirmSpy.mockRestore();
    });

    it('no Stop vouching where the node says this viewer may not (an owner\'s budget; an admin\'s to a committee admin) or says nothing', async () => {
        for (const canStop of [false, undefined]) {
            vi.mocked(api.getVoucherCard).mockResolvedValue({ ...SAMPLE_CARD, canStop });
            const { unmount } = render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
            await waitFor(() => expect(screen.getByText('Set budget to')).toBeInTheDocument());
            expect(screen.queryByTestId('voucher-stop')).toBeNull();
            unmount();
        }
    });

    it('renders tabs with role=tablist and min-h-[44px], and close button >= 44x44', async () => {
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(3);
        expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
        expect(tabs[0].className).toMatch(/min-h-\[44px\]/);
        expect(tabs[1].className).toMatch(/min-h-\[44px\]/);
        expect(tabs[2].className).toMatch(/min-h-\[44px\]/);

        const closeBtn = screen.getByRole('button', { name: 'Close' });
        expect(closeBtn.className).toMatch(/min-w-\[44px\]/);
        expect(closeBtn.className).toMatch(/min-h-\[44px\]/);
    });

    it('the card puts its numbers first (invites-vouching I4): the headline, then the budget; the 30-day figure from the node, no balance', async () => {
        vi.mocked(api.getVoucherCard).mockResolvedValue({ ...SAMPLE_CARD, vouched: 35000, peopleVouched: 4, vouchedLast30Days: 10000, belowZero: 1, writtenOff: 0 });
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        const headline = await screen.findByTestId('voucher-headline');
        expect(headline).toHaveTextContent('Vouched 350 to 4 people · 100 in the last 30 days · 1 below zero · written off 0');
        // First in the card, ahead of the budget line.
        const budget = screen.getByText(/550 of 1,?000 left/);
        expect(headline.compareDocumentPosition(budget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(document.body.textContent).not.toContain('people who joined');
        expect(document.body.textContent).not.toMatch(/balance/i);
    });

    it("an owner's card says No limit, with no held line and no Set budget to (Marty, 9 Nov)", async () => {
        vi.mocked(api.getVoucherCard).mockResolvedValue({ ...SAMPLE_CARD, noLimit: true });
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByText('No limit')).toBeInTheDocument());
        expect(screen.queryByText('Set budget to')).toBeNull();
        expect(screen.queryByText(/of 1,?000 left/)).toBeNull();
        expect(screen.queryByText(/^Held /)).toBeNull();
    });

    it('the quick budget levels (500 · 1,000 · 1,500 · 2,000) are at least 44 px tall, like the steppers (#2915 round 4)', async () => {
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByText('Set budget to')).toBeInTheDocument());

        for (const lvl of [500, 1000, 1500, 2000]) {
            const pill = screen.getByTestId(`voucher-level-${lvl}`);
            expect(pill.className).toMatch(/min-h-\[44px\]/);
            expect(pill.className).not.toMatch(/min-h-\[40px\]/);
        }
        // Four in a row overflowed "2000" at 320 px × 1.3 text (seen in the round-4 shot): two a row under 400 px.
        const row = screen.getByTestId('voucher-levels');
        expect(row.className).toMatch(/\bgrid-cols-2\b/);
        expect(row.className).toMatch(/min-\[400px\]:grid-cols-4/);
    });

    it('controls "Set budget to": quick levels, raise/lower stepper, never below held', async () => {
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByText('Set budget to')).toBeInTheDocument());

        // Held is 350 Beans (35000 hundredths) -> minLevel is the next 100 Beans up: 400 (40000)
        const decreaseBtn = screen.getByLabelText('Decrease budget');
        const increaseBtn = screen.getByLabelText('Increase budget');
        expect(decreaseBtn.className).toMatch(/min-w-\[44px\]/);
        expect(increaseBtn.className).toMatch(/min-w-\[44px\]/);

        // Current level is 1,000. Stepper increase to 1,100 (figures as formatHundredths writes them):
        fireEvent.click(increaseBtn);
        expect(screen.getByRole('button', { name: 'Set budget to: 1,100' })).toBeInTheDocument();

        // Stepper decrease
        fireEvent.click(decreaseBtn);
        expect(screen.getByRole('button', { name: 'Set budget to: 1,000' })).toBeDisabled(); // same as current level

        // Quick level 500
        const btn500 = screen.getByRole('button', { name: '500' });
        fireEvent.click(btn500);
        expect(screen.getByRole('button', { name: 'Set budget to: 500' })).not.toBeDisabled();

        // Cannot decrease below minLevel (400)
        fireEvent.click(decreaseBtn); // 500 -> 400
        expect(decreaseBtn).toBeDisabled(); // at 400, cannot decrease further

        // Submit budget change
        vi.mocked(api.setVoucherBudget).mockResolvedValueOnce({
            ...SAMPLE_CARD,
            changed: true,
            left: 5000,
            level: 40000,
        });
        fireEvent.click(screen.getByRole('button', { name: 'Set budget to: 400' }));
        await waitFor(() => {
            // The level goes in whole hundredths, as the node takes it (core isBudgetLevel): 400 Beans.
            expect(api.setVoucherBudget).toHaveBeenCalledWith(SAMPLE_CARD.memberPubkey, 40000);
        });
    });

    it('renders server refusal when setVoucherBudget rejects', async () => {
        vi.mocked(api.setVoucherBudget).mockRejectedValueOnce(new Error('Over ceiling'));
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByText('Set budget to')).toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: '1,500' }));
        fireEvent.click(screen.getByRole('button', { name: 'Set budget to: 1,500' }));

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Over ceiling');
        });
    });

    it('renders Budget history with no raw enum words or 64-hex keys', async () => {
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());

        // Switch to history tab
        const tabs = screen.getAllByRole('tab');
        fireEvent.click(tabs[1]);

        await waitFor(() => expect(screen.getAllByText(/made a voucher by @marty/).length).toBeGreaterThanOrEqual(1));
        expect(screen.getByText(/held for an invite/)).toBeInTheDocument();
        expect(screen.getByText(/back, invite expired/)).toBeInTheDocument();
        expect(screen.getByText(/top-up by @damo/)).toBeInTheDocument();

        // Check container text for forbidden raw enums or 64-hex pubkeys
        const historyRows = screen.getAllByTestId('voucher-history-line');
        expect(historyRows.length).toBe(4);
        const combinedText = historyRows.map((r) => r.textContent).join(' ');

        expect(combinedText).not.toMatch(/[0-9a-f]{64}/i);
        expect(combinedText).not.toMatch(/\b(grant|top_up|lower|not_landed)\b/i);
    });

    it('renders People tab without raw trading enum', async () => {
        render(<VoucherCardModal memberPubkey={SAMPLE_CARD.memberPubkey} onClose={() => {}} />);
        await waitFor(() => expect(screen.getByRole('tablist')).toBeInTheDocument());

        // Switch to people tab
        const tabs = screen.getAllByRole('tab');
        fireEvent.click(tabs[2]);

        await waitFor(() => expect(screen.getByText('@sam')).toBeInTheDocument());
        expect(screen.getByText('trading with others')).toBeInTheDocument();
        expect(screen.queryByText(/trading:\s*others/i)).not.toBeInTheDocument();
    });
});
