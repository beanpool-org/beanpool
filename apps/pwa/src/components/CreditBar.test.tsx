import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CreditBar } from './CreditBar';

describe('CreditBar Component', () => {
    it('renders basic anchors, hints, and zero balance tag label', () => {
        render(<CreditBar balance={0} floor={-500} />);

        // Check tag label
        expect(screen.getByText('+0 B')).toBeInTheDocument();

        // Check anchors
        expect(screen.getByText('-500')).toBeInTheDocument();
        expect(screen.getByText('your limit')).toBeInTheDocument();
        expect(screen.getByText('⚖️ 0')).toBeInTheDocument();
        expect(screen.getByText('sweet spot')).toBeInTheDocument();
        expect(screen.getByText('+200')).toBeInTheDocument();
        expect(screen.getByText('fee-free')).toBeInTheDocument();

        // Check directional hints
        expect(screen.getByText('← carry credit')).toBeInTheDocument();
        expect(screen.getByText('hold credit →')).toBeInTheDocument();
    });

    it('renders positive balances below and above feeFreeMax with circulation rates', () => {
        const { rerender } = render(<CreditBar balance={150} floor={-500} />);
        expect(screen.getByText('+150 B')).toBeInTheDocument();

        // Above 200 (rate 1%)
        rerender(<CreditBar balance={350} floor={-500} />);
        expect(screen.getByText('+350 B · ≈1%/mo')).toBeInTheDocument();

        // Above 500 (rate 1.5%)
        rerender(<CreditBar balance={800} floor={-500} />);
        expect(screen.getByText('+800 B · ≈1.5%/mo')).toBeInTheDocument();

        // Above 1000 (rate 2%)
        rerender(<CreditBar balance={1500} floor={-500} />);
        expect(screen.getByText('+1500 B · ≈2%/mo')).toBeInTheDocument();

        // Above 2000 (rate 2.5%)
        rerender(<CreditBar balance={2500} floor={-500} />);
        expect(screen.getByText('+2500 B · ≈2.5%/mo')).toBeInTheDocument();
    });

    it('displays fee ladder monthly zone labels when balance > feeFreeMax / 2', () => {
        render(<CreditBar balance={150} floor={-500} feeFreeMax={200} />);
        expect(screen.getByText('fee/mo')).toBeInTheDocument();
        expect(screen.getByText('1%')).toBeInTheDocument();
        expect(screen.getByText('1.5%')).toBeInTheDocument();
        expect(screen.getByText('2%')).toBeInTheDocument();
    });

    it('renders negative balances and handles near-limit state formatting', () => {
        const { rerender } = render(<CreditBar balance={-100} floor={-500} />);
        const normalTag = screen.getByText('-100 B');
        expect(normalTag).toBeInTheDocument();
        expect(normalTag).toHaveStyle({ backgroundColor: '#16211b' });

        // Near limit: balance - floor < Math.abs(floor) * 0.12 => -460 - (-500) = 40 < 60
        rerender(<CreditBar balance={-460} floor={-500} />);
        const nearLimitTag = screen.getByText('-460 B');
        expect(nearLimitTag).toBeInTheDocument();
        expect(nearLimitTag).toHaveStyle({ backgroundColor: '#bb4b32' });
    });

    it('formats decimal balances correctly', () => {
        const { rerender } = render(<CreditBar balance={12.5} floor={-200} />);
        expect(screen.getByText('+12.5 B')).toBeInTheDocument();

        rerender(<CreditBar balance={-12.5} floor={-200} />);
        expect(screen.getByText('-12.5 B')).toBeInTheDocument();
    });

    it('renders offer ladder caption when usableFloor is locked and uFloor < 0', () => {
        render(<CreditBar balance={0} floor={-1000} usableFloor={-200} liveOffers={1} />);

        // Caption should include liveOffers count and unlock information
        expect(screen.getByText('1 offer')).toBeInTheDocument();
        expect(screen.getByText(/unlocks/)).toBeInTheDocument();
        expect(screen.getByText(/−200/)).toBeInTheDocument();
        expect(screen.getByText('2 offers')).toBeInTheDocument();
        expect(screen.getByText(/−500/)).toBeInTheDocument();
    });

    it('renders offer ladder prompt when usableFloor is 0 and no offers posted', () => {
        render(<CreditBar balance={0} floor={-500} usableFloor={0} liveOffers={0} />);

        expect(screen.getByText('Post an Offer')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
        expect(screen.getByText(/unlock/)).toBeInTheDocument();
        expect(screen.getByText(/full/)).toBeInTheDocument();
        expect(screen.getByText(/−500/)).toBeInTheDocument();
    });

    it('does not display offer ladder when usableFloor is omitted or equals floor', () => {
        const { container, rerender } = render(<CreditBar balance={0} floor={-500} />);
        expect(container.textContent).not.toContain('🎣');

        rerender(<CreditBar balance={0} floor={-500} usableFloor={-500} liveOffers={2} />);
        expect(container.textContent).not.toContain('🎣');
    });

    it('respects custom feeFreeMax and custom className', () => {
        const { container } = render(
            <CreditBar balance={300} floor={-500} feeFreeMax={500} className="custom-credit-bar" />
        );

        expect(container.firstChild).toHaveClass('custom-credit-bar');
        // Since balance (300) <= feeFreeMax (500), tag does not show fee rate
        expect(screen.getByText('+300 B')).toBeInTheDocument();
        expect(screen.getByText('+500')).toBeInTheDocument(); // fee-free anchor
    });
});
