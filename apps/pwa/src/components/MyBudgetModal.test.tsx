/**
 * The Ledger's "Your budget to vouch from" dialog (#2915 round 4, finding 3): a ✕ at least 44 × 44 px, named by its heading,
 * Escape closes it, focus goes in on open and back to what opened it on close, as VoucherCardModal does.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { MyBudgetModal } from './MyBudgetModal';
import type { MyVouching } from '../lib/api';

const VOUCHING: MyVouching & { budget: NonNullable<MyVouching['budget']> } = {
    voucher: true,
    budget: { left: 550, held: 100, heldInvites: 1, vouched: 350, peopleVouched: 4, level: 1000 },
    history: [
        { kind: 'grant', amount: 1000, actor: 'a'.repeat(64), actorCallsign: 'marty', at: '2026-11-05T00:00:00Z' },
    ],
    presets: [25, 50, 75, 100],
    vouchMax: 100,
    budgetMax: 2000,
    vouchedBy: [],
};

function Opener() {
    const [open, setOpen] = useState(false);
    return (
        <div>
            <button type="button" onClick={() => setOpen(true)}>Open budget</button>
            {open && <MyBudgetModal vouching={VOUCHING} onClose={() => setOpen(false)} />}
        </div>
    );
}

describe('MyBudgetModal (the Ledger budget dialog)', () => {
    it('has a ✕ at least 44 × 44 px', () => {
        render(<MyBudgetModal vouching={VOUCHING} onClose={() => {}} />);
        const close = screen.getByRole('button', { name: 'Close' });
        expect(close.className).toMatch(/min-w-\[44px\]/);
        expect(close.className).toMatch(/min-h-\[44px\]/);
        expect(close.className).not.toMatch(/\bp-1\b/);
    });

    it('is named by its heading (aria-labelledby)', () => {
        render(<MyBudgetModal vouching={VOUCHING} onClose={() => {}} />);
        expect(screen.getByRole('dialog', { name: 'Your budget to vouch from' })).toBeInTheDocument();
    });

    it('Escape closes it', () => {
        const onClose = vi.fn();
        render(<MyBudgetModal vouching={VOUCHING} onClose={onClose} />);
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('focus goes to its heading on open and back to the opener on close', () => {
        render(<Opener />);
        const opener = screen.getByRole('button', { name: 'Open budget' });
        opener.focus();
        fireEvent.click(opener);
        expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your budget to vouch from' }));
        fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.activeElement).toBe(opener);
    });

    it('shows the figures and the history in words', () => {
        render(<MyBudgetModal vouching={VOUCHING} onClose={() => {}} />);
        expect(screen.getByText(/550 of 1,?000 left/)).toBeInTheDocument();
        expect(screen.getByText(/made a voucher by @marty/)).toBeInTheDocument();
        expect(screen.getByTestId('my-budget-modal').textContent).not.toMatch(/[0-9a-f]{64}/);
    });
});
