import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { PricingGuideModal } from './PricingGuideModal';

vi.mock('../lib/api', () => ({
    getPricingGuideApi: vi.fn().mockResolvedValue({ items: [], config: {} }),
    submitPricingReportApi: vi.fn().mockResolvedValue({ success: true }),
}));

describe('PricingGuideModal Component', () => {
    it('renders with modal dialog ARIA attributes when open', () => {
        render(<PricingGuideModal isOpen={true} onClose={() => {}} />);

        const dialog = screen.getByRole('dialog');
        expect(dialog).toBeInTheDocument();
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'pricing-guide-title');

        const title = screen.getByText(/Community Pricing Guide/i);
        expect(title).toBeInTheDocument();
        expect(title.id).toBe('pricing-guide-title');
    });

    it('renders category filter buttons with aria-pressed and min-h-[44px] touch target classes', () => {
        render(<PricingGuideModal isOpen={true} onClose={() => {}} />);

        const allItemsBtn = screen.getByRole('button', { name: /All Items/i });
        expect(allItemsBtn).toHaveAttribute('aria-pressed', 'true');
        expect(allItemsBtn.className).toContain('min-h-[44px]');
        expect(allItemsBtn.className).toContain('focus-visible:ring-2');
    });
});
