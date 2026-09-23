import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { PricingGuideItem } from '@beanpool/core';
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

    it('puts the unit and trend in the row name when rows are selectable, because the select control carries no text of its own', async () => {
        const api = await import('../lib/api');
        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: [{ id: 'eggs', category: 'food', emoji: '🥚', name: 'Eggs', description: 'A dozen', priceBeans: 12, unit: 'dozen', trend: 'up' }],
            config: {},
        } as any);
        render(<PricingGuideModal isOpen={true} onClose={() => {}} onSelectOfferItem={() => {}} />);

        expect(await screen.findByRole('button', { name: 'Select Eggs for offer at 12 Beans per dozen, price rising' })).toBeInTheDocument();
    });
});

describe('PricingGuideModal selectable row accessibility', () => {
    const TOMATOES = {
        id: 'fp-010',
        category: 'food',
        emoji: '🍅',
        name: 'Heirloom Tomatoes',
        description: 'Sun-ripened heritage varieties',
        priceBeans: 8,
        unit: 'kg',
        seasonalityHint: 'Plentiful & cheaper in summer/autumn',
    };

    async function renderSelectable(onSelect: (item: PricingGuideItem, price: number) => void = vi.fn()) {
        const api = await import('../lib/api');
        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: [TOMATOES],
            config: { showSeasonality: true },
        } as any);
        render(<PricingGuideModal isOpen={true} onClose={() => {}} onSelectOfferItem={onSelect} />);
        const row = await screen.findByRole('button', { name: /^Select Heirloom Tomatoes/ });
        return { row, onSelect };
    }

    it('describes the row with the item description and the seasonality hint, which the label leaves out', async () => {
        const { row } = await renderSelectable();

        expect(row).toHaveAccessibleDescription(/Sun-ripened heritage varieties/);
        expect(row).toHaveAccessibleDescription(/Plentiful & cheaper in summer\/autumn/);
    });

    it('leaves the seasonality hint out of the description when the node hides seasonality', async () => {
        const api = await import('../lib/api');
        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: [TOMATOES],
            config: { showSeasonality: false },
        } as any);
        render(<PricingGuideModal isOpen={true} onClose={() => {}} onSelectOfferItem={() => {}} />);

        const row = await screen.findByRole('button', { name: /^Select Heirloom Tomatoes/ });
        expect(row).toHaveAccessibleDescription(/Sun-ripened heritage varieties/);
        expect(row).not.toHaveAccessibleDescription(/Plentiful/);
    });

    it('keeps the short accessible name — name, price in Beans, unit and trend, nothing else', async () => {
        const { row } = await renderSelectable();

        expect(row).toHaveAccessibleName('Select Heirloom Tomatoes for offer at 8 Beans per kg');
    });

    it('keeps the Report button out of the selectable control, tabbable after it, and still working', async () => {
        const { row, onSelect } = await renderSelectable();
        const report = screen.getByRole('button', { name: 'Report price for Heirloom Tomatoes' });

        expect(row.contains(report)).toBe(false);

        row.focus();
        await userEvent.tab();
        expect(report).toHaveFocus();

        await userEvent.click(report);
        expect(await screen.findByRole('heading', { name: /Report Price/ })).toBeInTheDocument();
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('selects the item with Enter', async () => {
        const onSelect = vi.fn();
        const { row } = await renderSelectable(onSelect);

        row.focus();
        await userEvent.keyboard('{Enter}');
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'fp-010' }), 8);
    });

    it('selects the item with Space', async () => {
        const onSelect = vi.fn();
        const { row } = await renderSelectable(onSelect);

        row.focus();
        await userEvent.keyboard('[Space]');
        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'fp-010' }), 8);
    });
});
