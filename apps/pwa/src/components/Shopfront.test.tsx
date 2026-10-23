import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ShopfrontText } from './Shopfront';

describe('ShopfrontText', () => {
    it('renders More button with focus-visible ring classes and toggles text expansion', () => {
        const longText = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nThis text is long enough to trigger the More/Less toggle button in ShopfrontText component.';
        render(<ShopfrontText title="About Us" text={longText} testID="about-shop" />);

        const moreBtn = screen.getByTestId('about-shop-more');
        expect(moreBtn).toBeInTheDocument();
        expect(moreBtn).toHaveAttribute('aria-expanded', 'false');
        expect(moreBtn.className).toContain('focus-visible:ring-2');
        expect(moreBtn.className).toContain('focus-visible:ring-emerald-500');

        fireEvent.click(moreBtn);
        expect(moreBtn).toHaveAttribute('aria-expanded', 'true');
        expect(moreBtn).toHaveTextContent('Less');
    });
});
