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

describe('PricingGuideModal price accessible text', () => {
    it('says Beans and the trend in words, since the bean and the arrow are hidden from screen readers', async () => {
        const api = await import('../lib/api');
        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: [
                { id: 'eggs', category: 'food', emoji: '🥚', name: 'Eggs', description: 'A dozen', priceBeans: 12, unit: 'dozen', trend: 'up' },
                { id: 'bread', category: 'food', emoji: '🍞', name: 'Bread', description: 'A loaf', priceBeans: 8, trend: 'down' },
            ],
            config: {},
        } as any);
        render(<PricingGuideModal isOpen={true} onClose={() => {}} />);

        const rising = await screen.findByText(', price rising');
        expect(rising.parentElement?.textContent).toContain('12 Beans');
        expect(screen.getByText(', price falling')).toHaveClass('sr-only');
        expect(rising).toHaveClass('sr-only');
    });

    it('puts the unit and trend in the row name when rows are selectable, because that name replaces the text inside', async () => {
        const api = await import('../lib/api');
        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: [{ id: 'eggs', category: 'food', emoji: '🥚', name: 'Eggs', description: 'A dozen', priceBeans: 12, unit: 'dozen', trend: 'up' }],
            config: {},
        } as any);
        render(<PricingGuideModal isOpen={true} onClose={() => {}} onSelectOfferItem={() => {}} />);

        expect(await screen.findByRole('button', { name: 'Select Eggs for offer at 12 Beans per dozen, price rising' })).toBeInTheDocument();
    });
});
