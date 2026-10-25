import { describe, expect, it } from 'vitest';
import { shopCountsLine, shopStateLine, shopTitle } from './shop';

describe('shop words and counts line robustness', () => {
    it('says counts tolerantly: handles null, undefined, and valid counts', () => {
        expect(shopCountsLine(null)).toBe('Nothing in it yet');
        expect(shopCountsLine(undefined)).toBe('Nothing in it yet');
        expect(shopCountsLine({ things: 0, available: 0, toBorrow: 0, toBuy: 0, out: 0, newThisWeek: 0 })).toBe('Nothing in it yet');
        expect(shopCountsLine({ things: 1, available: 1, toBorrow: 1, toBuy: 0, out: 0, newThisWeek: 0 })).toBe('1 thing');
        expect(shopCountsLine({ things: 3, available: 2, toBorrow: 1, toBuy: 1, out: 1, newThisWeek: 0 })).toBe('3 things · 1 out');
    });

    it('shopStateLine handles shop with null or undefined counts when active', () => {
        expect(shopStateLine({ paused: false, backOn: null, counts: null })).toBe('Nothing in it yet');
        expect(shopStateLine({ paused: false, backOn: null, counts: undefined })).toBe('Nothing in it yet');
        expect(shopStateLine({ paused: true, backOn: null, counts: null })).toBe('Closed for now');
    });

    it('shopTitle formats title correctly', () => {
        expect(shopTitle({ name: "Bob's Bakery", ownerName: 'Bob' })).toBe("Bob's Bakery");
        expect(shopTitle({ name: null, ownerName: 'Bob' })).toBe("Bob's shop");
        expect(shopTitle({ name: null, ownerName: '' })).toBe('Your shop');
    });
});
