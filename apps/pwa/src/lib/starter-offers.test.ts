import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ request: vi.fn() }));

import { STARTER_OFFERS } from '@beanpool/core';
import { MARKETPLACE_CATEGORIES } from './marketplace';
import { request } from './api';
import { readPricingGuide } from './starter-offers';

const ITEM = { id: 'x', category: 'food', emoji: '🍞', name: 'Loaf', description: '', priceBeans: 8, unit: 'loaf' };

describe('readPricingGuide: the community guide the starter dialog shows figures from (cold start O2)', () => {
    beforeEach(() => { vi.mocked(request).mockReset(); });

    it('asks the community\'s public guide, nothing sent from the member, and gives its items', async () => {
        vi.mocked(request).mockResolvedValue({ items: [ITEM] });
        expect(await readPricingGuide()).toEqual([ITEM]);
        expect(request).toHaveBeenCalledTimes(1);
        expect(vi.mocked(request).mock.calls[0]).toEqual(['GET', '/api/pricing-guide']);
    });

    it('a refusal, a network failure or an answer that is not a list is no guide, never an error', async () => {
        vi.mocked(request).mockRejectedValueOnce(new Error('503'));
        expect(await readPricingGuide()).toBeNull();
        vi.mocked(request).mockResolvedValueOnce({ items: 'nope' });
        expect(await readPricingGuide()).toBeNull();
        vi.mocked(request).mockResolvedValueOnce(null);
        expect(await readPricingGuide()).toBeNull();
        vi.mocked(request).mockResolvedValueOnce({});
        expect(await readPricingGuide()).toBeNull();
    });
});

describe("the starter drafts and the web composer's categories (cold start O2)", () => {
    it("every category the 51 drafts are written for is one the web composer and its What are you into? chips take, so a draft opens in its own category", () => {
        const web = MARKETPLACE_CATEGORIES.map(c => c.id).sort();
        expect(Object.keys(STARTER_OFFERS).sort()).toEqual(web);
    });
});
