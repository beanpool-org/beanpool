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

    // The 1.2 s "Feedback Submitted" timer, by its delay: the testing library's own timers use other delays.
    const reportTimers = (spy: { mock: { calls: unknown[][]; results: { value: unknown }[] } }) =>
        spy.mock.calls.flatMap((c, i) => (c[1] === 1200 ? [spy.mock.results[i].value] : []));

    it('clears the pending feedback timer itself on unmount', async () => {
        // Each timer remembers when it has fired: on a busy machine the 1.2 s can pass before the unmount, and then nothing is pending.
        const fired = new Set<unknown>();
        const realSetTimeout = window.setTimeout.bind(window);
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
            let id: unknown;
            id = realSetTimeout(() => { fired.add(id); fn(...args); }, ms);
            return id;
        }) as typeof window.setTimeout);
        const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
        try {
            const { unmount } = render(<PricingGuideModal isOpen={true} onClose={() => {}} />);
            const reportBtns = await screen.findAllByRole('button', { name: /Report price for/i });
            await userEvent.click(reportBtns[0]);
            await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
            expect(await screen.findByRole('heading', { name: /Feedback Submitted/i })).toBeInTheDocument();

            const [timer] = reportTimers(setTimeoutSpy);
            expect(timer).toBeDefined();
            unmount();
            // Cleared by the unmount, unless it had already fired (nothing left to clear).
            expect(fired.has(timer) || clearTimeoutSpy.mock.calls.some(c => c[0] === timer)).toBe(true);
        } finally {
            setTimeoutSpy.mockRestore();
            clearTimeoutSpy.mockRestore();
        }
    });

    it('a submit still out when the modal goes starts no timer and sets no state after it', async () => {
        const api = await import('../lib/api');
        let answer!: (v: { success: boolean }) => void;
        vi.mocked(api.submitPricingReportApi).mockImplementationOnce(() => new Promise(r => { answer = r; }) as any);
        const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
        try {
            const { unmount } = render(<PricingGuideModal isOpen={true} onClose={() => {}} />);
            const reportBtns = await screen.findAllByRole('button', { name: /Report price for/i });
            await userEvent.click(reportBtns[0]);
            await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
            unmount();
            answer({ success: true });
            await new Promise(r => setTimeout(r, 0));
            expect(reportTimers(setTimeoutSpy)).toEqual([]);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('resets reporting feedback state when modal closes and reopens', async () => {
        const { rerender } = render(<PricingGuideModal isOpen={true} onClose={() => {}} />);
        const reportBtns = await screen.findAllByRole('button', { name: /Report price for/i });
        await userEvent.click(reportBtns[0]);

        const submitBtn = screen.getByRole('button', { name: 'Submit' });
        await userEvent.click(submitBtn);

        expect(await screen.findByRole('heading', { name: /Feedback Submitted/i })).toBeInTheDocument();

        // Close modal while success message is showing
        rerender(<PricingGuideModal isOpen={false} onClose={() => {}} />);
        expect(screen.queryByRole('heading', { name: /Feedback Submitted/i })).not.toBeInTheDocument();

        // Reopen modal: should be back in main catalog view, not stuck on Feedback Submitted
        rerender(<PricingGuideModal isOpen={true} onClose={() => {}} />);
        expect(screen.queryByRole('heading', { name: /Feedback Submitted/i })).not.toBeInTheDocument();

        // Clicking report again should show the report form, not Feedback Submitted
        const reopenedReportBtns = await screen.findAllByRole('button', { name: /Report price for/i });
        await userEvent.click(reopenedReportBtns[0]);
        expect(screen.getByRole('heading', { name: /Report Price/i })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: /Feedback Submitted/i })).not.toBeInTheDocument();
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

    it('keeps the confidence dot above the select overlay, so its tooltip still takes the hover', async () => {
        await renderSelectable();

        // The overlay is a positioned sibling inside the row's `isolate` context, so it paints over
        // every in-flow child unless that child is lifted too. Without this the dot's title tooltip
        // is unreachable by mouse. jsdom has no paint order, so pin the classes the stacking rests on.
        const dot = screen.getByTitle('Confidence: 0 listings');
        expect(dot).toHaveClass('relative', 'z-10');
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
