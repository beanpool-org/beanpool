/**
 * The Community Pricing Guide in the member's language (words S3, web sweep W1): every section it shows (header, search,
 * category pills, the tip, loading, no match, a row with its price, unit, trend and confidence, the report form and its
 * thanks) through t(). The catalog's own items (names, descriptions, units, season hints) come from the node's catalog
 * and are shown as written; the category pills are core's PRICING_CATEGORIES, marked in the modal and translated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PRICING_CATEGORIES } from '@beanpool/core';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', () => ({
    getPricingGuideApi: vi.fn(),
    submitPricingReportApi: vi.fn().mockResolvedValue({ success: true }),
}));

import { getPricingGuideApi } from '../lib/api';
import { PricingGuideModal } from './PricingGuideModal';

const ITEMS = [
    { id: 'eggs', category: 'food', emoji: '🥚', name: 'Eggs', description: 'A dozen free-range', priceBeans: 12, unit: 'dozen', trend: 'up', confidenceCount: 4, seasonalityHint: 'Fewer in winter' },
    { id: 'bread', category: 'food', emoji: '🍞', name: 'Sourdough', description: 'A loaf', priceBeans: 8, trend: 'down', confidenceCount: 1 },
    { id: 'fix', category: 'services', emoji: '🔧', name: 'Bike fix', description: 'A puncture', priceBeans: 20, unit: 'hour' },
];
const others = ITEMS.flatMap(i => [i.name, i.description, i.unit ?? '', i.seasonalityHint ?? '']).filter(Boolean);

async function draw(ui: React.ReactElement) {
    await act(async () => { render(ui); });
}

beforeEach(() => {
    vi.mocked(getPricingGuideApi).mockResolvedValue({ items: ITEMS, config: { showSeasonality: true } } as unknown as Awaited<ReturnType<typeof getPricingGuideApi>>);
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('the pricing guide in the pseudo-locale', () => {
    it('the guide with selectable rows: header, search, pills, tip, rows and their prices', async () => {
        await showIn('xx');
        await draw(<PricingGuideModal isOpen onClose={() => {}} onSelectOfferItem={() => {}} />);
        expect(await screen.findByText('Eggs')).toBeInTheDocument();
        expect(screen.getByText(xx('{n} items & services benchmarked').replace('{n}', '3'))).toBeInTheDocument();
        expect(screen.getByText(xx('Tap any item to auto-fill your offer listing with community price estimates.'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('{label}, price rising').replace('{label}', xx('Select {name} for offer at {n} Beans per {unit}').replace('{name}', 'Eggs').replace('{n}', '12').replace('{unit}', 'dozen')) })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Select {name} for offer at {n} Beans per {unit}').replace('{name}', 'Bike fix').replace('{n}', '20').replace('{unit}', 'hour') })).toBeInTheDocument();
        expect(screen.getByTitle(xx('Confidence: {n} listings').replace('{n}', '4'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: new RegExp(xx('Food & Produce').replace(/[[\]~]/g, '.')) })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('read-only rows, no match, and loading', async () => {
        await showIn('xx');
        await draw(<PricingGuideModal isOpen onClose={() => {}} />);
        expect(await screen.findByText(xx('Community estimates based on local marketplace trades and seasonal averages.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);

        fireEvent.change(screen.getByRole('textbox', { name: xx('Search community price catalog') }), { target: { value: 'zzz' } });
        expect(screen.getByText(xx('No items found matching "{query}"').replace('{query}', 'zzz'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('Clear search') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: [...others, 'zzz'] })).toEqual([]);
        cleanup();

        vi.mocked(getPricingGuideApi).mockReturnValueOnce(new Promise(() => {}));
        await draw(<PricingGuideModal isOpen onClose={() => {}} />);
        expect(screen.getByText(xx('Loading community estimates...'))).toBeInTheDocument();
        // The built-in catalog (core's DEFAULT_PRICING_CATALOG) fills the count while the node's is on its way.
        expect(bypassing(document.body)).toEqual([]);
    });

    it('the report form and its thanks', async () => {
        await showIn('xx');
        await draw(<PricingGuideModal isOpen onClose={() => {}} />);
        fireEvent.click(await screen.findByRole('button', { name: xx('Report price for {name}').replace('{name}', 'Eggs') }));
        const form = screen.getByRole('heading', { name: new RegExp(xx('Report Price').replace(/[[\]~]/g, '.')) }).closest('form')!;
        expect(form.textContent).toContain(xx('{name} • Current: {price}').replace('{name}', 'Eggs').split('{price}')[0]);
        expect(screen.getByRole('radiogroup', { name: xx('Feedback reason') })).toBeInTheDocument();
        expect(screen.getByPlaceholderText(xx('Optional: Why is this estimate wrong?'))).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Submit') })); });
        expect(await screen.findByText(xx('Feedback Submitted'))).toBeInTheDocument();
        expect(bypassing(document.body, { others })).toEqual([]);
    });

    it('in English nothing is bracketed, and the words are as they were', async () => {
        await draw(<PricingGuideModal isOpen onClose={() => {}} onSelectOfferItem={() => {}} />);
        expect(await screen.findByText('Eggs')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByText('3 items & services benchmarked')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Select Eggs for offer at 12 Beans per dozen, price rising' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Select Sourdough for offer at 8 Beans, price falling' })).toBeInTheDocument();
        expect(screen.getByTitle('Confidence: 1 listings')).toBeInTheDocument();
        expect(screen.getAllByText('Offer →')).toHaveLength(3);
        // Each pill reads core's own category name.
        for (const cat of PRICING_CATEGORIES) {
            expect(screen.getByRole('button', { name: cat.label })).toBeInTheDocument();
        }
        fireEvent.click(screen.getByRole('button', { name: 'Report price for Eggs' }));
        // Drawn: "Eggs • Current: 🫘 12"; read out: "Eggs • Current: 12 Beans" (the bean and the drawn number are hidden).
        expect(screen.getByRole('heading', { name: 'Report Price' }).nextElementSibling!.textContent).toBe('Eggs • Current: 🫘 1212 Beans');
        expect(screen.getByRole('radio', { name: 'Too High' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    });
});
