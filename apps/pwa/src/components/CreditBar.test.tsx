import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CreditBar } from './CreditBar';

describe('CreditBar ARIA Meter Semantics & Accessibility', () => {
    it('renders meter role with correct label and bounds for standard balance', () => {
        render(<CreditBar balance_c={5000} floor_c={-50000} />);
        const meter = screen.getByRole('meter', { name: 'Credit balance gauge' });
        expect(meter).toBeInTheDocument();
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '50');
        expect(meter).toHaveAttribute('aria-valuetext', '+50 Beans');
    });

    it('correctly handles negative balances within limit', () => {
        render(<CreditBar balance_c={-15000} floor_c={-50000} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '-150');
        expect(meter).toHaveAttribute('aria-valuetext', '−150 Beans');
    });

    it('correctly handles balance exactly at the floor', () => {
        render(<CreditBar balance_c={-50000} floor_c={-50000} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '-500');
        expect(meter).toHaveAttribute('aria-valuetext', '−500 Beans');
    });

    it('clamps aria-valuenow at floor when balance drops below floor, keeping valuetext accurate', () => {
        render(<CreditBar balance_c={-65000} floor_c={-50000} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '-500');
        expect(meter).toHaveAttribute('aria-valuetext', '−650 Beans');
    });

    it('clamps aria-valuenow at valuemax when balance exceeds the top of the scale', () => {
        render(<CreditBar balance_c={35000} floor_c={-50000} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '200');
        expect(meter).toHaveAttribute('aria-valuetext', '+350 Beans');
    });

    it('respects zero floor for members without a credit line', () => {
        render(<CreditBar balance_c={0} floor_c={0} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '0');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '0');
        expect(meter).toHaveAttribute('aria-valuetext', '+0 Beans');
    });

    it('supports custom feeFreeMax bound', () => {
        render(<CreditBar balance_c={40000} floor_c={-100000} feeFreeMax={500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-1000');
        expect(meter).toHaveAttribute('aria-valuemax', '500');
        expect(meter).toHaveAttribute('aria-valuenow', '400');
        expect(meter).toHaveAttribute('aria-valuetext', '+400 Beans');
    });

    it('formats decimal balances properly in aria-valuetext (two decimals, as formatHundredths writes them)', () => {
        render(<CreditBar balance_c={1250} floor_c={-50000} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuenow', '12.5');
        expect(meter).toHaveAttribute('aria-valuetext', '+12.50 Beans');
    });

    it('hides decorative emojis from assistive technology', () => {
        const { container } = render(
            <CreditBar
                balance_c={-10000}
                floor_c={-50000}
                usableFloor_c={-20000}
                liveOffers={1}
            />
        );

        const hiddenEmojis = container.querySelectorAll('[aria-hidden="true"]');
        const emojiTexts = Array.from(hiddenEmojis).map((el) => el.textContent?.trim());
        expect(emojiTexts).toContain('⚖️');
        expect(emojiTexts).toContain('🎣');
    });
});
