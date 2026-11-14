/**
 * The web half of T6 (DESIGN-atomic-beans-fable.md §5), on the R1 card: it takes whole hundredths of a Bean (the node's
 * balance_c, floor_c, usableFloor_c) and writes every figure as core formatHundredths does: "0.01", "1", "49.25", "−9.82"
 * (a true minus) and "500", never a rounded "49.3" or a hundredths count shown as Beans ("4925"), and never "B".
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreditBar } from './CreditBar';

const shownFor = (balance_c: number, floor_c = -20000) => {
    const { unmount } = render(<CreditBar answer={{ balance_c, floor_c, usableFloor_c: floor_c, liveOffers: 1, roomHeld_c: -floor_c }} />);
    const label = screen.getByTestId('credit-label').textContent ?? '';
    const spoken = screen.getByRole('button').getAttribute('aria-label') ?? '';
    const shown = screen.getByRole('button').textContent ?? '';
    unmount();
    return { label, spoken, shown };
};

describe('the credit card writes whole hundredths as every figure is written', () => {
    it.each([
        [1, '+0.01 Beans', 'You hold 0.01 Beans'],
        [100, '+1 Beans', 'You hold 1 Beans'],
        [4925, '+49.25 Beans', 'You hold 49.25 Beans'],
        [-982, '−9.82 Beans', 'You owe 9.82 Beans'],
        [50000, '+500 Beans', 'You hold 500 Beans'],
    ])('%i hundredths: the label "%s", the headline "%s"', (balance_c, label, headline) => {
        const s = shownFor(balance_c);
        expect(s.label).toBe(label);
        expect(s.spoken.startsWith(`${headline}.`)).toBe(true);
    });

    it('never shows a count of hundredths as Beans, a figure rounded to one decimal, or a "B" after a figure', () => {
        const s = shownFor(4925);
        expect(s.shown).not.toContain('4925');
        expect(s.shown).not.toContain('49.3');
        expect(shownFor(-982).shown).not.toContain('-9.8 ');
        expect(s.shown).not.toMatch(/\d\s?B\b/);
    });

    it("writes the limit's own figure from its hundredths", () => {
        render(<CreditBar answer={{ balance_c: 0, floor_c: -12345, usableFloor_c: -12345, liveOffers: 1, roomHeld_c: 12345 }} />);
        expect(screen.getByRole('button').textContent).toContain('−123.45');
        expect(screen.getByTestId('credit-sentence').textContent).toBe('You have given as much as you have received. You can spend 123.45 from your credit line.');
    });
});
