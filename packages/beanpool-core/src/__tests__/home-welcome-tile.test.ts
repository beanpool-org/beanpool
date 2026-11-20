/**
 * Slice S5 of scratch/fable-design/DESIGN-onboarding-home-landing-fable.md (Marty's picks of 21 Nov 2026): the WELCOME TO
 * BEANPOOL! tile's words and lines (§4.1 item 1), its life (full for seven days, then a band, until Got it or the tour's
 * end, §4.2-§4.3), the record it shares with 1.4.7 ("Not now" there is "Got it" here), and First steps above the Market
 * on a Home never arranged (§4.1 item 6).
 */
import { describe, expect, it } from 'vitest';
import {
    HOME_DEFAULT_LIST, WELCOME_BAND_DAYS, WELCOME_DAYS, defaultCards, welcomeDrawn, welcomeShape,
} from '../home-frame.js';
import { FIRST_STEPS_DAYS } from '../first-steps.js';
import { WELCOME_TILE_WORDS, welcomeTileLines } from '../home-welcome.js';
import { PROTOCOL_CONSTANTS } from '../protocol.js';
import { readTourRecord, tourEnded, tourRecord } from '../tour.js';

const NOW = Date.parse('2026-11-21T03:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('S5: the tile is full for seven days, then a band, until Got it or the tour ends', () => {
    it('full, then band, then gone only by the record', () => {
        expect(WELCOME_DAYS).toBe(7);
        expect(welcomeShape(false, daysAgo(0), NOW)).toBe('full');
        expect(welcomeShape(false, new Date(NOW - 7 * DAY + 1).toISOString(), NOW)).toBe('full');
        // Day 8: folded to one band, never gone without the member's tap inside the newcomer's 30 days.
        expect(welcomeShape(false, daysAgo(7), NOW)).toBe('band');
        expect(welcomeShape(false, daysAgo(29), NOW)).toBe('band');
        // Got it (skipped) or the tour's end (done): gone, full or band.
        expect(welcomeShape(true, daysAgo(0), NOW)).toBeNull();
        expect(welcomeShape(true, daysAgo(9), NOW)).toBeNull();
    });

    it("a newcomer's only: nothing from day 30, the First steps window (design §3.3 a returning member unchanged, §4.2 day 30)", () => {
        expect(WELCOME_BAND_DAYS).toBe(FIRST_STEPS_DAYS);
        expect(WELCOME_BAND_DAYS).toBe(30);
        // The table: joined today -> tile; day 8 -> band; day 29 -> band; day 31 -> nothing; March 2026 with no tour record
        // (a member of months who never ended the tour, opening a new app) -> nothing; the tour ended -> nothing.
        const rows: [string, boolean, string, ReturnType<typeof welcomeShape>][] = [
            ['joined today', false, daysAgo(0), 'full'],
            ['day 8', false, daysAgo(8), 'band'],
            ['day 29', false, daysAgo(29), 'band'],
            ['day 30, to the millisecond', false, new Date(NOW - 30 * DAY).toISOString(), null],
            ['a millisecond before day 30', false, new Date(NOW - 30 * DAY + 1).toISOString(), 'band'],
            ['day 31', false, daysAgo(31), null],
            ['March 2026, no tour record', false, '2026-03-12T09:00:00.000Z', null],
            ['a year on, no tour record', false, daysAgo(400), null],
            ['tour ended, joined today', true, daysAgo(0), null],
            ['tour ended, March 2026', true, '2026-03-12T09:00:00.000Z', null],
        ];
        for (const [name, tourOver, joinedAt, want] of rows) expect(welcomeShape(tourOver, joinedAt, NOW), name).toBe(want);
        // Take the tour again after day 30 draws nothing either: the full tile is a newcomer's too.
        expect(welcomeDrawn(false, daysAgo(31), NOW)).toBe(false);
        // A join date not heard keeps it full: never hidden, never folded, for a missing fact.
        expect(welcomeShape(false, null, NOW)).toBe('full');
        expect(welcomeShape(false, 'not a date', NOW)).toBe('full');
    });

    it('welcomeDrawn is the full tile (the web until W2, and Take the tour again)', () => {
        expect(welcomeDrawn(false, daysAgo(1), NOW)).toBe(true);
        expect(welcomeDrawn(false, daysAgo(8), NOW)).toBe(false);
        expect(welcomeDrawn(true, daysAgo(1), NOW)).toBe(false);
    });

    it("Got it writes the tour record 'skipped', the one 1.4.7's Not now writes: either ends the tile on every device", () => {
        const gotIt = tourRecord('skipped', NOW);
        // What a 1.4.7 phone wrote for Not now, read back from the account as the answer carries it.
        const notNow147 = readTourRecord({ v: 1, state: 'skipped', at: daysAgo(2) });
        for (const r of [gotIt, notNow147]) {
            expect(tourEnded(r)).toBe(true);
            expect(welcomeShape(tourEnded(r), daysAgo(1), NOW)).toBeNull();
            expect(welcomeShape(tourEnded(r), daysAgo(9), NOW)).toBeNull();
        }
        // Take the tour again ('open') brings it back.
        expect(welcomeShape(tourEnded(tourRecord('open', NOW)), daysAgo(1), NOW)).toBe('full');
    });
});

describe("S5: the tile's lines", () => {
    it('Beans on: the three facts, the rate from the protocol (40), 39 words with the title, place and buttons', () => {
        const lines = welcomeTileLines({ profile: 'local', beans: true });
        expect(lines.map((l) => l.icon)).toEqual(['swap', 'scale', 'zero']);
        expect(lines.map((l) => l.text)).toEqual([
            'Offer something first. Then ask for anything.',
            "Beans keep score: about 40 for an hour's help.",
            'Zero is a good balance: you give as much as you get.',
        ]);
        // The 40 is the protocol's reference rate (the same on every community), not a community setting.
        expect(PROTOCOL_CONSTANTS.REFERENCE_RATE / 100).toBe(40);
        const tile = [WELCOME_TILE_WORDS.title, "You're in Riverside.", ...lines.map((l) => l.text), WELCOME_TILE_WORDS.tour, WELCOME_TILE_WORDS.gotIt];
        expect(tile.reduce((n, s) => n + words(s), 0)).toBeLessThanOrEqual(39);
    });

    it('the global community: the two lines that say where Beans live, none of the Beans facts', () => {
        const lines = welcomeTileLines({ profile: 'global', beans: false });
        expect(lines.map((l) => l.text)).toEqual([
            'Meet people and find a community near you.',
            'No Beans here. Trading in Beans happens in local communities.',
        ]);
        // Global with a showcase that says Beans: still global's lines.
        expect(welcomeTileLines({ profile: 'global', beans: true }).map((l) => l.icon)).toEqual(['meet', 'none']);
    });

    it('a local community with Beans off: the first line alone, nothing untrue about Beans', () => {
        const lines = welcomeTileLines({ profile: 'local', beans: false });
        expect(lines.map((l) => l.text)).toEqual(['Offer something first. Then ask for anything.']);
    });
});

describe('S5: First steps above the Market, a Home never arranged only', () => {
    it('the default list has First steps right above the Market, under Welcome and Your way back in', () => {
        expect(HOME_DEFAULT_LIST.slice(0, 4)).toEqual(['start', 'safety', 'steps', 'market']);
        expect(defaultCards().map((c) => c.id).slice(0, 4)).toEqual(['start', 'safety', 'steps', 'market']);
    });
});
