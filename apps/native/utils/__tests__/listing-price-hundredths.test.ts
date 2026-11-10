// @vitest-environment jsdom
/**
 * A listing's money on the phone in whole hundredths of a Bean (DESIGN-atomic-beans-fable.md M2): the card's figure
 * (components/ListingPrice.tsx, the Market's three cards and the map's pin card), and utils/listing-money.ts, what a deal on a
 * listing comes to before it is asked for and the price as the edit box starts it. A price is `price_c`: 1 is a hundredth.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => {
    const el = (tag: string) => ({ children }: { children?: unknown }) => createElement(tag, null, children as any);
    const flatten = (s: unknown) => Object.assign({}, ...[s].flat(4).filter((x) => x && typeof x === 'object'));
    return { Platform: { OS: 'android' }, StyleSheet: { create: <T,>(s: T) => s, flatten }, View: el('div'), Text: el('span'), Image: el('img') };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) } }));
vi.mock('../nodes', () => ({ getSavedNodes: async () => [] }));
vi.mock('../db', () => ({ signedGet: vi.fn(), signedRequestWithMethod: vi.fn() }));

import { parseHundredths, setLanguage } from '@beanpool/core';
import { ListingPrice } from '../../components/ListingPrice';
import { dealAmountOrNull, priceAsTyped } from '../listing-money';
import { readPeekPost } from '../peek';

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; setLanguage('en'); });

function figure(price_c: number | null | undefined, unit = '', type = 'offer'): string {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(ListingPrice, { price_c, type, unit }) as any));
    // CurrencyDisplay writes the figure, a no-break space, then the Beans sign (an image, no text).
    return (host.textContent ?? '').replace(/\u00A0/g, '');
}

describe('the card\'s figure (ListingPrice) reads whole hundredths', () => {
    it.each([
        [1, '0.01'], [100, '1'], [4925, '49.25'], [50000, '500'], [123456, '1,234.56'], [1250, '12.50'],
    ])('%i hundredths: "%s" and its unit', (price_c, shown) => {
        expect(figure(price_c, '/Hr')).toBe(`${shown}/Hr`);
    });

    it('0 is Free, words only (no figure, no unit); no figure held is "—", never Free; none sent is "?"', () => {
        expect(figure(0, '/Hr')).toBe('Free');
        expect(figure(null)).toBe('—');
        expect(figure(undefined)).toBe('?');
    });

    it('in the member\'s language: the decimal mark is theirs', () => {
        setLanguage('fr');
        expect(figure(4925)).toBe('49,25');
    });
});

describe('what a deal on a listing comes to (dealAmountOrNull: core dealAmountFor, the node\'s figure)', () => {
    it('the price times the quantity, exactly, the part below a hundredth kept by the payer', () => {
        expect(dealAmountOrNull(1500, 2)).toBe(3000);
        expect(dealAmountOrNull(1500, 1.5)).toBe(2250);
        // 33 hundredths for a third of an hour: 0.33 × 33 = 10.89, truncated once to 10.
        expect(dealAmountOrNull(33, 0.33)).toBe(10);
        expect(dealAmountOrNull(1, 1)).toBe(1);
    });

    it("no figure where there can't be one: never a guess, never a throw", () => {
        for (const [price, quantity] of [[null, 1], [12.5, 1], ['1200', 1], [-100, 1], [1200, 0], [1200, -1], [1200, Number.NaN], [Number.MAX_SAFE_INTEGER, 3]] as const) {
            expect(dealAmountOrNull(price, quantity as number)).toBeNull();
        }
    });
});

describe('the price as the edit box starts it (priceAsTyped) reads back as the same price', () => {
    it.each([[1, '0.01'], [100, '1'], [4925, '49.25'], [50000, '500'], [123456, '1234.56'], [0, '0']])('%i hundredths: "%s"', (price_c, typed) => {
        expect(priceAsTyped(price_c)).toBe(typed);
        expect(parseHundredths(typed)).toEqual({ ok: true, value: price_c });
    });

    it('in French, the comma: it reads back in French', () => {
        setLanguage('fr');
        expect(priceAsTyped(123456)).toBe('1234,56');
        expect(parseHundredths(priceAsTyped(123456))).toEqual({ ok: true, value: 123456 });
    });

    it('no figure: an empty box', () => {
        expect(priceAsTyped(null)).toBe('');
        expect(priceAsTyped(12.5)).toBe('');
    });
});

describe('a shared link\'s listing (readPeekPost) keeps the node\'s price_c, whole hundredths, or none', () => {
    const answer = (post: Record<string, unknown>) => ({ post: { id: 'p1', type: 'offer', title: 'Eggs', ...post } });
    it('whole hundredths, as sent', () => {
        expect(readPeekPost(answer({ price_c: 4925 }), 'p1')?.price_c).toBe(4925);
        expect(readPeekPost(answer({ price_c: 0 }), 'p1')?.price_c).toBe(0);
    });
    it('anything else is no price: a float, a figure in text, a negative, the old key', () => {
        for (const post of [{ price_c: 49.25 }, { price_c: '4925' }, { price_c: -100 }, { credits: 49 }]) {
            expect(readPeekPost(answer(post), 'p1')?.price_c).toBeUndefined();
        }
    });
});
