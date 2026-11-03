/**
 * The Find card's listing-promise lines (Mothership A3): what a directory row says is read again, shape by shape, and said
 * in the member's language. Nothing negative is ever said, and a row from an older global node says nothing at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FIND_COMMUNITY_WORDS, closingDayAhead, communityPromiseLines, listingPromiseKept } from '../find-community';
import { setLanguage } from '../words';

const PROMISE = { v: 1, owners: 2, backups: true, reports: true, notice: true };
// 3 Nov 2026, 10:00 UTC.
const NOW = Date.UTC(2026, 10, 3, 10, 0, 0);

afterEach(() => setLanguage('en'));

describe('listingPromiseKept: only the exact promise counts', () => {
    it('true for the five fields; false when the node says it has none; null when it said nothing or something else', () => {
        expect(listingPromiseKept(PROMISE)).toBe(true);
        expect(listingPromiseKept(null)).toBe(false);
        expect(listingPromiseKept(undefined)).toBeNull();
    });

    it('a forged or odd shape is no promise: names inside, a sixth field, "true" as text, one owner, a list', () => {
        expect(listingPromiseKept({ ...PROMISE, names: ['Ana'] })).toBeNull();
        expect(listingPromiseKept({ ...PROMISE, extra: 1 })).toBeNull();
        expect(listingPromiseKept({ ...PROMISE, backups: 'true' })).toBeNull();
        expect(listingPromiseKept({ ...PROMISE, owners: 1 })).toBeNull();
        expect(listingPromiseKept({ ...PROMISE, owners: 2.5 })).toBeNull();
        expect(listingPromiseKept({ ...PROMISE, owners: 1001 })).toBeNull();
        expect(listingPromiseKept({ ...PROMISE, v: 2 })).toBeNull();
        expect(listingPromiseKept({ v: 1, owners: 2, backups: true, reports: true })).toBeNull();
        expect(listingPromiseKept([PROMISE])).toBeNull();
        expect(listingPromiseKept('promise')).toBeNull();
    });
});

describe('closingDayAhead: a real day, today or still to come', () => {
    it('today and later days are said; yesterday and earlier are not', () => {
        expect(closingDayAhead('2026-11-03', NOW)).toEqual({ y: 2026, m: 11, d: 3 });
        expect(closingDayAhead('2026-12-31', NOW)).toEqual({ y: 2026, m: 12, d: 31 });
        expect(closingDayAhead('2026-11-02', NOW)).toBeNull();
        expect(closingDayAhead('2025-01-01', NOW)).toBeNull();
    });

    it('a day that is not on the calendar, or not a day, is not said', () => {
        for (const bad of ['2026-02-31', '2026-99-99', '2027-02-29', '3 Dec', '2026-12-3', '', 20261203, null, undefined, {}]) {
            expect(closingDayAhead(bad as unknown, NOW)).toBeNull();
        }
    });
});

describe('communityPromiseLines: the Find card, in the design\'s order', () => {
    it('keeps the promise, takes requests, closing day: all three', () => {
        expect(communityPromiseLines({ promise: PROMISE, acceptingKnocks: true, closingOn: '2026-12-03' }, NOW))
            .toEqual(['Keeps the listing promise', 'Accepting members', 'Closing on 3 Dec 2026']);
    });

    it('a new listing (the node said it has no promise)', () => {
        expect(communityPromiseLines({ promise: null, acceptingKnocks: true, closingOn: null }, NOW)).toEqual(['New listing', 'Accepting members']);
    });

    it('nothing negative: no requests taken and no day say nothing', () => {
        expect(communityPromiseLines({ promise: PROMISE, acceptingKnocks: false, closingOn: null }, NOW)).toEqual(['Keeps the listing promise']);
        expect(communityPromiseLines({ promise: PROMISE, acceptingKnocks: null }, NOW)).toEqual(['Keeps the listing promise']);
    });

    it('an older global node sends none of the three: no line, and never "New listing"', () => {
        expect(communityPromiseLines({}, NOW)).toEqual([]);
        expect(communityPromiseLines({ promise: undefined, acceptingKnocks: undefined, closingOn: undefined }, NOW)).toEqual([]);
    });

    it('a forged promise is not believed, and not called new either', () => {
        expect(communityPromiseLines({ promise: { ...PROMISE, names: ['x'] }, acceptingKnocks: true }, NOW)).toEqual(['Accepting members']);
    });

    it('a closing day already past is dropped', () => {
        expect(communityPromiseLines({ promise: null, closingOn: '2026-11-01' }, NOW)).toEqual(['New listing']);
    });

    it('in the member\'s language, the date included', () => {
        setLanguage('fr', [{
            [FIND_COMMUNITY_WORDS.keepsPromise]: 'Tient sa promesse d’inscription',
            [FIND_COMMUNITY_WORDS.acceptingMembers]: 'Accepte des membres',
            [FIND_COMMUNITY_WORDS.closingOn]: 'Ferme le {date}',
        }]);
        const lines = communityPromiseLines({ promise: PROMISE, acceptingKnocks: true, closingOn: '2026-12-03' }, NOW);
        expect(lines[0]).toBe('Tient sa promesse d’inscription');
        expect(lines[1]).toBe('Accepte des membres');
        expect(lines[2]).toMatch(/^Ferme le /);
        expect(lines[2]).toContain('2026');
        expect(lines[2]).not.toContain('{date}');
    });
});
