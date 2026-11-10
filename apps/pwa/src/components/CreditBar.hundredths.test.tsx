/**
 * The web half of T6 (DESIGN-atomic-beans-fable.md §5): the credit bar takes whole hundredths of a Bean (the node's
 * balance_c, floor_c, usableFloor_c) and writes every figure as core formatHundredths does: "0.01", "1", "49.25",
 * "−9.82" (a true minus) and "500", never a rounded "49.3" or a hundredths count shown as Beans ("4925").
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CreditBar } from './CreditBar';

const tagOf = (balance_c: number, floor_c = -20000) => {
    const { unmount } = render(<CreditBar balance_c={balance_c} floor_c={floor_c} />);
    const meter = screen.getByRole('meter');
    const words = meter.getAttribute('aria-valuetext');
    const shown = meter.textContent ?? '';
    unmount();
    return { words, shown };
};

describe('the credit bar writes whole hundredths as every figure is written', () => {
    it.each([
        [1, '+0.01 Beans', '+0.01 B'],
        [100, '+1 Beans', '+1 B'],
        [4925, '+49.25 Beans', '+49.25 B'],
        [-982, '−9.82 Beans', '−9.82 B'],
        [50000, '+500 Beans', '+500 B'],
    ])('%i hundredths read "%s"', (balance_c, words, shown) => {
        const tag = tagOf(balance_c);
        expect(tag.words).toBe(words);
        expect(tag.shown).toContain(shown);
    });

    it('never shows a count of hundredths as Beans, nor a figure rounded to one decimal', () => {
        const tag = tagOf(4925);
        expect(tag.shown).not.toContain('4925');
        expect(tag.shown).not.toContain('49.3');
        expect(tagOf(-982).shown).not.toContain('-9.8 ');
    });

    it('draws the gauge in Beans from the hundredths: the meter sits where the Beans figure does', () => {
        render(<CreditBar balance_c={4925} floor_c={-50000} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuenow', '49.25');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
    });

    it("writes the floor's own figure from its hundredths", () => {
        render(<CreditBar balance_c={0} floor_c={-12345} usableFloor_c={-12345} />);
        expect(screen.getByRole('meter').textContent).toContain('−123.45');
    });
});
