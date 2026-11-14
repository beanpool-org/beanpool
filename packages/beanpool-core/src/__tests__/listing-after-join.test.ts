/**
 * The slot both apps keep the listing a copy stood for in (list on global G4, DESIGN-list-on-global-fable.md §6): per
 * community, the id and the time only; a month and it lapses; nothing malformed is ever read back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    LISTING_AFTER_JOIN_MOST, LISTING_AFTER_JOIN_MS, LISTING_AFTER_JOIN_WORDS, listingAfterJoinHost, listingsAfterJoinOf, withListingAfterJoin,
} from '../listing-after-join.js';
import { setLanguage, t } from '../words.js';

const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const T0 = 1_800_000_000_000;

afterEach(() => setLanguage('en'));

describe('the community a listing is kept for', () => {
    it('is the host, from a host or an address', () => {
        expect(listingAfterJoinHost('mullum.example.org')).toBe('mullum.example.org');
        expect(listingAfterJoinHost('https://Mullum.example.org/')).toBe('mullum.example.org');
        expect(listingAfterJoinHost('https://test.example.org:8443')).toBe('test.example.org:8443');
    });

    it('is nothing for a path, a query, a scheme other than https, or no string', () => {
        for (const bad of ['https://mullum.example.org/app', 'mullum.example.org?x=1', 'http://mullum.example.org', 'javascript:alert(1)', '', null, 42]) {
            expect(listingAfterJoinHost(bad), String(bad)).toBeNull();
        }
    });
});

describe('the slot', () => {
    it('keeps the id and the time for a community, and reads them back', () => {
        const held = withListingAfterJoin({}, 'https://mullum.example.org', POST, T0)!;
        expect(held).toEqual({ 'mullum.example.org': { id: POST, at: T0 } });
        expect(listingsAfterJoinOf(JSON.stringify(held), T0 + 1)).toEqual(held);
    });

    it('a new tap for the same community starts again, unjoined', () => {
        const joined = { 'mullum.example.org': { id: 'old', at: T0, joined: true as const } };
        expect(withListingAfterJoin(joined, 'mullum.example.org', POST, T0 + 5)).toEqual({ 'mullum.example.org': { id: POST, at: T0 + 5 } });
    });

    it('writes nothing for an id that is no id, or a host that is no host', () => {
        expect(withListingAfterJoin({}, 'mullum.example.org', 'https://elsewhere.example/?x=1', T0)).toBeNull();
        expect(withListingAfterJoin({}, 'mullum.example.org', '', T0)).toBeNull();
        expect(withListingAfterJoin({}, 'not a host', POST, T0)).toBeNull();
    });

    it('lapses a month after it was kept, and never reads one kept "later" than now', () => {
        const raw = JSON.stringify(withListingAfterJoin({}, 'mullum.example.org', POST, T0));
        expect(listingsAfterJoinOf(raw, T0 + LISTING_AFTER_JOIN_MS)).toHaveProperty(['mullum.example.org', 'id'], POST);
        expect(listingsAfterJoinOf(raw, T0 + LISTING_AFTER_JOIN_MS + 1)).toEqual({});
        expect(listingsAfterJoinOf(raw, T0 - 1)).toEqual({});
    });

    it('reads only well-formed entries, and nothing from a slot that is not one', () => {
        expect(listingsAfterJoinOf(null, T0)).toEqual({});
        expect(listingsAfterJoinOf('not json', T0)).toEqual({});
        expect(listingsAfterJoinOf('[1,2]', T0)).toEqual({});
        const raw = JSON.stringify({
            'mullum.example.org': { id: POST, at: T0, joined: true, extra: 'dropped' },
            'MIXED.example.org': { id: POST, at: T0 },
            'bad host': { id: POST, at: T0 },
            'byron.example.org': { id: 'a b', at: T0 },
            'castle.example.org': { id: POST, at: 'soon' },
        });
        expect(listingsAfterJoinOf(raw, T0)).toEqual({ 'mullum.example.org': { id: POST, at: T0, joined: true } });
    });

    it(`holds at most ${LISTING_AFTER_JOIN_MOST} communities, dropping the oldest`, () => {
        let held = {};
        for (let i = 0; i < LISTING_AFTER_JOIN_MOST + 3; i++) held = withListingAfterJoin(held, `c${i}.example.org`, POST, T0 + i)!;
        const hosts = Object.keys(held);
        expect(hosts).toHaveLength(LISTING_AFTER_JOIN_MOST);
        expect(hosts).not.toContain('c0.example.org');
        expect(hosts).toContain(`c${LISTING_AFTER_JOIN_MOST + 2}.example.org`);
    });
});

describe('the line when it has gone', () => {
    it('says so in English', () => {
        expect(t(LISTING_AFTER_JOIN_WORDS.gone)).toBe('The listing you came for is no longer up.');
    });

    it('has a draft in every language core has a catalog for', () => {
        const dir = fileURLToPath(new URL('../../words/', import.meta.url));
        const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
        expect(files.length).toBeGreaterThanOrEqual(24);
        for (const file of files) {
            setLanguage(file.slice(0, -5) as Parameters<typeof setLanguage>[0], [JSON.parse(readFileSync(`${dir}${file}`, 'utf8'))]);
            expect(t(LISTING_AFTER_JOIN_WORDS.gone), file).not.toBe('The listing you came for is no longer up.');
        }
    });
});
