// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PricingGuideModal } from './PricingGuideModal';
import * as api from '../lib/api';
import { DEFAULT_PRICING_CATALOG, DEFAULT_PRICING_CONFIG, type PricingGuideItem } from '@beanpool/core';

vi.mock('../lib/api', () => ({
    getPricingGuideApi: vi.fn(),
    submitPricingReportApi: vi.fn(),
}));

describe('PricingGuideModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not render when isOpen is false', () => {
        const { container } = render(<PricingGuideModal isOpen={false} onClose={() => {}} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('handles getPricingGuideApi error gracefully and falls back to default catalog', async () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(api.getPricingGuideApi).mockRejectedValueOnce(new Error('Network failure'));

        render(<PricingGuideModal isOpen={true} onClose={() => {}} />);

        // Should initially render loading state
        expect(screen.getByText(/Loading community estimates/i)).toBeInTheDocument();

        // Wait for fetchCatalog to catch the error and finish loading
        await waitFor(() => {
            expect(screen.queryByText(/Loading community estimates/i)).not.toBeInTheDocument();
        });

        // Verify warning was logged
        expect(consoleWarnSpy).toHaveBeenCalledWith(
            '[PricingGuide] Using local fallback catalog:',
            expect.any(Error)
        );

        // Default catalog title and items should be visible
        expect(screen.getByText('Community Pricing Guide')).toBeInTheDocument();
        expect(screen.getByText(DEFAULT_PRICING_CATALOG[0].name)).toBeInTheDocument();

        consoleWarnSpy.mockRestore();
    });

    it('fetches and displays custom catalog items on success', async () => {
        const mockItems: PricingGuideItem[] = [
            {
                id: 'custom-1',
                category: 'food_produce',
                name: 'Fresh Organic Tomatoes',
                description: 'Vine ripened red tomatoes',
                priceBeans: 12,
                unit: 'kg',
                emoji: '🍅',
            },
        ];

        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: mockItems,
            config: DEFAULT_PRICING_CONFIG,
            categories: [],
        });

        render(<PricingGuideModal isOpen={true} onClose={() => {}} />);

        await waitFor(() => {
            expect(screen.getByText('Fresh Organic Tomatoes')).toBeInTheDocument();
        });

        expect(screen.getByText('Vine ripened red tomatoes')).toBeInTheDocument();
    });

    it('filters items by search query', async () => {
        const mockItems: PricingGuideItem[] = [
            {
                id: 'custom-1',
                category: 'food_produce',
                name: 'Apples',
                description: 'Crisp green apples',
                priceBeans: 10,
                unit: 'kg',
                emoji: '🍏',
            },
            {
                id: 'custom-2',
                category: 'labour_services',
                name: 'Lawn Mowing',
                description: 'Yard care service',
                priceBeans: 50,
                unit: 'hr',
                emoji: '🚜',
            },
        ];

        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: mockItems,
            config: DEFAULT_PRICING_CONFIG,
            categories: [],
        });

        render(<PricingGuideModal isOpen={true} onClose={() => {}} />);

        await waitFor(() => {
            expect(screen.getByText('Apples')).toBeInTheDocument();
        });

        const searchInput = screen.getByPlaceholderText(/Search produce, services, trades, gear/i);
        fireEvent.change(searchInput, { target: { value: 'Lawn' } });

        expect(screen.queryByText('Apples')).not.toBeInTheDocument();
        expect(screen.getByText('Lawn Mowing')).toBeInTheDocument();
    });

    it('allows selecting an offer item', async () => {
        const onSelect = vi.fn();
        const onClose = vi.fn();
        const mockItems: PricingGuideItem[] = [
            {
                id: 'custom-1',
                category: 'food_produce',
                name: 'Apples',
                description: 'Crisp green apples',
                priceBeans: 10,
                unit: 'kg',
                emoji: '🍏',
            },
        ];

        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: mockItems,
            config: DEFAULT_PRICING_CONFIG,
            categories: [],
        });

        render(
            <PricingGuideModal
                isOpen={true}
                onClose={onClose}
                onSelectOfferItem={onSelect}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Offer →')).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText('Offer →'));

        expect(onSelect).toHaveBeenCalledWith(mockItems[0], 10);
        expect(onClose).toHaveBeenCalled();
    });

    it('allows reporting price feedback', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.mocked(api.getPricingGuideApi).mockResolvedValueOnce({
            items: DEFAULT_PRICING_CATALOG,
            config: DEFAULT_PRICING_CONFIG,
            categories: [],
        });
        vi.mocked(api.submitPricingReportApi).mockRejectedValueOnce(new Error('Submit failed'));

        render(<PricingGuideModal isOpen={true} onClose={() => {}} reporterPubkey="test-pubkey" />);

        await waitFor(() => {
            expect(screen.getByText(DEFAULT_PRICING_CATALOG[0].name)).toBeInTheDocument();
        });

        const reportBtn = screen.getByLabelText(`Report price for ${DEFAULT_PRICING_CATALOG[0].name}`);
        fireEvent.click(reportBtn);

        expect(screen.getByText('🚩 Report Price')).toBeInTheDocument();

        const submitBtn = screen.getByRole('button', { name: /Submit/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                '[PricingGuide] Failed to submit report:',
                expect.any(Error)
            );
        });

        consoleErrorSpy.mockRestore();
    });
});
