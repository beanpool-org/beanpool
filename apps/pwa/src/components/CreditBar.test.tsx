import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CreditBar } from './CreditBar';

describe('CreditBar ARIA Meter Semantics & Accessibility', () => {
    it('renders meter role with correct label and bounds for standard balance', () => {
        render(<CreditBar balance={50} floor={-500} />);
        const meter = screen.getByRole('meter', { name: 'Credit balance gauge' });
        expect(meter).toBeInTheDocument();
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '50');
        expect(meter).toHaveAttribute('aria-valuetext', '+50 Beans');
    });

    it('correctly handles negative balances within limit', () => {
        render(<CreditBar balance={-150} floor={-500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '-150');
        expect(meter).toHaveAttribute('aria-valuetext', '-150 Beans');
    });

    it('correctly handles balance exactly at the floor', () => {
        render(<CreditBar balance={-500} floor={-500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '-500');
        expect(meter).toHaveAttribute('aria-valuetext', '-500 Beans');
    });

    it('clamps aria-valuenow at floor when balance drops below floor, keeping valuetext accurate', () => {
        render(<CreditBar balance={-650} floor={-500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '-500');
        expect(meter).toHaveAttribute('aria-valuetext', '-650 Beans');
    });

    it('clamps aria-valuenow at valuemax when balance exceeds the top of the scale', () => {
        render(<CreditBar balance={350} floor={-500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-500');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '200');
        expect(meter).toHaveAttribute('aria-valuetext', '+350 Beans');
    });

    it('respects zero floor for members without a credit line', () => {
        render(<CreditBar balance={0} floor={0} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '0');
        expect(meter).toHaveAttribute('aria-valuemax', '200');
        expect(meter).toHaveAttribute('aria-valuenow', '0');
        expect(meter).toHaveAttribute('aria-valuetext', '+0 Beans');
    });

    it('supports custom feeFreeMax bound', () => {
        render(<CreditBar balance={400} floor={-1000} feeFreeMax={500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuemin', '-1000');
        expect(meter).toHaveAttribute('aria-valuemax', '500');
        expect(meter).toHaveAttribute('aria-valuenow', '400');
        expect(meter).toHaveAttribute('aria-valuetext', '+400 Beans');
    });

    it('formats decimal balances properly in aria-valuetext', () => {
        render(<CreditBar balance={12.5} floor={-500} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveAttribute('aria-valuenow', '12.5');
        expect(meter).toHaveAttribute('aria-valuetext', '+12.5 Beans');
    });

    it('hides decorative emojis from assistive technology', () => {
        const { container } = render(
            <CreditBar
                balance={-100}
                floor={-500}
                usableFloor={-200}
                liveOffers={1}
            />
        );

        const hiddenEmojis = container.querySelectorAll('[aria-hidden="true"]');
        const emojiTexts = Array.from(hiddenEmojis).map((el) => el.textContent?.trim());
        expect(emojiTexts).toContain('⚖️');
        expect(emojiTexts).toContain('🎣');
    });
});
