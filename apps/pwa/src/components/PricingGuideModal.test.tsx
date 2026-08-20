import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DEFAULT_PRICING_CONFIG, type PricingGuideItem } from '@beanpool/core';
import { PricingGuideModal } from './PricingGuideModal';
import { getPricingGuideApi, submitPricingReportApi } from '../lib/api';

vi.mock('../lib/api', () => ({
    getPricingGuideApi: vi.fn(),
    submitPricingReportApi: vi.fn(),
}));

const mockCatalogItem: PricingGuideItem = {
    id: 'item-eggs-12',
    name: 'Fresh Eggs (Dozen)',
    category: 'food_produce',
    description: 'Pasture-raised organic eggs',
    priceBeans: 12,
    unit: 'dozen',
    trend: 'stable',
    emoji: '🥚',
    confidenceCount: 5,
};

const mockPricingResponse = {
    items: [mockCatalogItem],
    config: DEFAULT_PRICING_CONFIG,
    categories: [],
};

describe('PricingGuideModal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getPricingGuideApi).mockResolvedValue(mockPricingResponse);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('renders modal content when open', async () => {
        render(<PricingGuideModal isOpen={true} onClose={vi.fn()} />);

        expect(screen.getByRole('dialog', { name: /Community Pricing Guide/i })).toBeInTheDocument();
        expect(await screen.findByText('Fresh Eggs (Dozen)')).toBeInTheDocument();
    });

    it('handles error when submitPricingReportApi rejects during report submission', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const submitError = new Error('Network error: failed to submit price report');
        vi.mocked(submitPricingReportApi).mockRejectedValueOnce(submitError);

        render(<PricingGuideModal isOpen={true} onClose={vi.fn()} reporterPubkey="pubkey-123" />);

        // Wait for items to load
        await screen.findByText('Fresh Eggs (Dozen)');

        // Open report modal for the item
        const reportBtn = screen.getByRole('button', { name: /Report price for Fresh Eggs \(Dozen\)/i });
        fireEvent.click(reportBtn);

        // Verify report feedback modal title is visible
        expect(screen.getByRole('heading', { name: /Report Price/i })).toBeInTheDocument();

        // Optionally type notes
        const textarea = screen.getByPlaceholderText(/Optional: Why is this estimate wrong\?/i);
        fireEvent.change(textarea, { target: { value: 'Price is too high for local market' } });

        // Submit report
        const submitBtn = screen.getByRole('button', { name: /Submit/i });
        fireEvent.click(submitBtn);

        // Verify API was called with reportingItem.id, reportType, comment, and reporterPubkey
        await waitFor(() => {
            expect(submitPricingReportApi).toHaveBeenCalledWith(
                'item-eggs-12',
                'too_high',
                'Price is too high for local market',
                'pubkey-123'
            );
        });

        // Verify error was caught and logged to console.error
        await waitFor(() => {
            expect(consoleSpy).toHaveBeenCalledWith('[PricingGuide] Failed to submit report:', submitError);
        });

        // Verify that success feedback message is NOT shown
        expect(screen.queryByText('Feedback Submitted')).not.toBeInTheDocument();

        // Verify submit button is re-enabled (reportSubmitting reset to false)
        expect(screen.getByRole('button', { name: /Submit/i })).not.toBeDisabled();
    });

    it('handles successful report submission', async () => {
        vi.mocked(submitPricingReportApi).mockResolvedValueOnce({ success: true, reportId: 'report-1' });

        render(<PricingGuideModal isOpen={true} onClose={vi.fn()} />);

        await screen.findByText('Fresh Eggs (Dozen)');

        const reportBtn = screen.getByRole('button', { name: /Report price for Fresh Eggs \(Dozen\)/i });
        fireEvent.click(reportBtn);

        const submitBtn = screen.getByRole('button', { name: /Submit/i });
        fireEvent.click(submitBtn);

        await waitFor(() => {
            expect(screen.getByText('Feedback Submitted')).toBeInTheDocument();
        });
    });

    it('calls onClose when close button is clicked', async () => {
        const onCloseMock = vi.fn();
        render(<PricingGuideModal isOpen={true} onClose={onCloseMock} />);

        await screen.findByText('Fresh Eggs (Dozen)');

        const closeBtn = screen.getByRole('button', { name: /Close pricing guide/i });
        fireEvent.click(closeBtn);

        expect(onCloseMock).toHaveBeenCalledTimes(1);
    });
});
