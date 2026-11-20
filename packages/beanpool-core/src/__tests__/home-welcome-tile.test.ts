/**
 * Slice S5 of scratch/fable-design/DESIGN-onboarding-home-landing-fable.md (Marty's picks of 21 Nov 2026): the WELCOME TO
 * BEANPOOL! tile's words and lines (§4.1 item 1), its life (full for seven days, then a band, until Got it or the tour's
 * end, §4.2-§4.3), the record it shares with 1.4.7 ("Not now" there is "Got it" here), and First steps above the Market
 * on a Home never arranged (§4.1 item 6).
 */
import { describe, expect, it } from 'vitest';
import {
    HOME_DEFAULT_LIST, WELCOME_DAYS, defaultCards, welcomeDrawn, welcomeShape,
} from '../home-frame.js';
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
        // Day 8: folded to one band, never gone without the member's tap.
        expect(welcomeShape(false, daysAgo(7), NOW)).toBe('band');
        expect(welcomeShape(false, daysAgo(30), NOW)).toBe('band');
        expect(welcomeShape(false, daysAgo(400), NOW)).toBe('band');
        // Got it (skipped) or the tour's end (done): gone, full or band.
        expect(welcomeShape(true, daysAgo(0), NOW)).toBeNull();
        expect(welcomeShape(true, daysAgo(30), NOW)).toBeNull();
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
