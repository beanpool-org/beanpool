import { afterEach, describe, expect, it, vi } from 'vitest';
import { STARTER_OFFERS } from '@beanpool/core';
import { POST_CATEGORIES } from '../../constants/categories';
import { STARTER_GUIDE_TIMEOUT_MS, readPricingGuide } from '../starter-offers';

const ITEM = { id: 'x', category: 'food', emoji: '🍞', name: 'Loaf', description: '', priceBeans: 8, unit: 'loaf' };
const answering = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe('readPricingGuide: the community guide the starter sheet shows figures from (cold start O2)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('asks the node\'s public guide, nothing sent from the member, with any trailing slash dropped, and gives its items', async () => {
        const f = answering({ items: [ITEM] });
        expect(await readPricingGuide('https://mullum.example/', f)).toEqual([ITEM]);
        expect(f).toHaveBeenCalledTimes(1);
        expect(vi.mocked(f).mock.calls[0][0]).toBe('https://mullum.example/api/pricing-guide');
        expect(Object.keys(vi.mocked(f).mock.calls[0][1] ?? {})).toEqual(['signal']);
    });

    it('no node address means no request and no guide', async () => {
        const f = answering({ items: [ITEM] });
        for (const none of [null, undefined, '', '   ']) expect(await readPricingGuide(none, f)).toBeNull();
        expect(f).not.toHaveBeenCalled();
    });

    it('a refusal, a network failure or an answer that is not a list is no guide, never an error', async () => {
        expect(await readPricingGuide('https://a.example', answering({ items: [ITEM] }, false))).toBeNull();
        expect(await readPricingGuide('https://a.example', answering({ items: 'nope' }))).toBeNull();
        expect(await readPricingGuide('https://a.example', answering(null))).toBeNull();
        expect(await readPricingGuide('https://a.example', vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
    });

    it('a node that takes the request and never answers is let go after the wait, so the sheet goes without figures', async () => {
        vi.useFakeTimers();
        const hung = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
        const read = readPricingGuide('https://a.example', hung);
        await vi.advanceTimersByTimeAsync(STARTER_GUIDE_TIMEOUT_MS + 1);
        expect(await read).toBeNull();
    });
});

describe("the starter drafts and the phone's categories (cold start O2)", () => {
    it("every category the 51 drafts are written for is one the phone's composer and its What are you into? chips take, so a draft opens in its own category", () => {
        const phone = POST_CATEGORIES.map(c => c.id).sort();
        expect(Object.keys(STARTER_OFFERS).sort()).toEqual(phone);
    });
});
