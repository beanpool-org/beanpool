/**
 * Back to the listing after the join, the phone's half (list on global G4, DESIGN-list-on-global-fable.md §6 steps 4 and 7):
 * kept at Send from a copy's door, marked when that yes is joined, taken once on Home in that community, lapsed after a
 * month, never opened by a join someone else's invite made; and where it has gone, the post screen's one line.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, DeviceEventEmitter: { emit: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));

import { LISTING_AFTER_JOIN_MS, setLanguage } from '@beanpool/core';
import {
    CAME_FOR_PARAM, joinedForListing, keepListingAfterJoin, missingListingLine, openedForListing, takeListingAfterJoin,
} from '../listing-after-join';
import { LISTING_AFTER_JOIN_STORE_KEY } from '../storage-keys';
import { communityCardRoute } from '../community-card-link';
import type { PostStore } from '../post-after-join';

const POST = '3f2b8c1e-5d4a-4e7b-9a10-0c6d2e8f1a34';
const BYRON = 'https://byron.example.org';
const MULLUM = 'https://mullum.example.org';
const T0 = 1_800_000_000_000;

function memory(): PostStore & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        getItem: async (k) => map.get(k) ?? null,
        setItem: async (k, v) => { map.set(k, v); },
        removeItem: async (k) => { map.delete(k); },
    };
}

afterEach(() => setLanguage('en'));

describe("the listing a request was sent from, by a copy's door", () => {
    it('the door tells the card which listing: in its in-app route, an id and nothing else', () => {
        expect(communityCardRoute(BYRON, undefined, POST)).toBe(`/community-card?node=${encodeURIComponent(BYRON)}&listing=${POST}`);
        expect(communityCardRoute(BYRON)).toBe(`/community-card?node=${encodeURIComponent(BYRON)}`);
        expect(communityCardRoute(BYRON, undefined, null)).toBe(`/community-card?node=${encodeURIComponent(BYRON)}`);
    });

    it('is kept at Send as the community and the id, and is not opened before its yes is joined', async () => {
        const store = memory();
        await keepListingAfterJoin(BYRON, POST, T0, store);
        expect(JSON.parse(store.map.get(LISTING_AFTER_JOIN_STORE_KEY)!)).toEqual({ 'byron.example.org': { id: POST, at: T0 } });
        // On Byron's Home by someone else's invite: nothing opens, and it stays for its own join.
        expect(await takeListingAfterJoin(BYRON, T0 + 1, store)).toBeNull();
        expect(store.map.has(LISTING_AFTER_JOIN_STORE_KEY)).toBe(true);
    });

    it('once the yes is joined, Home in that community takes it once: its screen, marked as the one they came for', async () => {
        const store = memory();
        await keepListingAfterJoin(BYRON, POST, T0, store);
        await joinedForListing(BYRON, T0 + 10, store);
        // Not on another community's Home: that one waits.
        expect(await takeListingAfterJoin(MULLUM, T0 + 11, store)).toBeNull();
        expect(await takeListingAfterJoin(`${BYRON}/`, T0 + 12, store)).toBe(`/post/${POST}?${CAME_FOR_PARAM}=1`);
        expect(await takeListingAfterJoin(BYRON, T0 + 13, store)).toBeNull();
        expect(store.map.has(LISTING_AFTER_JOIN_STORE_KEY)).toBe(false);
    });

    it('a join with no listing kept for it changes nothing, and a community not heard yet reads nothing', async () => {
        const store = memory();
        await keepListingAfterJoin(BYRON, POST, T0, store);
        await joinedForListing(MULLUM, T0 + 1, store);
        expect(await takeListingAfterJoin(MULLUM, T0 + 2, store)).toBeNull();
        await joinedForListing(BYRON, T0 + 3, store);
        expect(await takeListingAfterJoin(null, T0 + 4, store)).toBeNull();
        expect(await takeListingAfterJoin(BYRON, T0 + 5, store)).toBe(`/post/${POST}?${CAME_FOR_PARAM}=1`);
    });

    it('lapses a month after Send, joined or not, and the slot is cleared as it is read', async () => {
        const store = memory();
        await keepListingAfterJoin(BYRON, POST, T0, store);
        await joinedForListing(BYRON, T0 + 1, store);
        expect(await takeListingAfterJoin(BYRON, T0 + LISTING_AFTER_JOIN_MS + 1, store)).toBeNull();
        expect(store.map.has(LISTING_AFTER_JOIN_STORE_KEY)).toBe(false);
        // A yes joined after the month opens nothing either.
        await keepListingAfterJoin(BYRON, POST, T0, store);
        await joinedForListing(BYRON, T0 + LISTING_AFTER_JOIN_MS + 1, store);
        expect(await takeListingAfterJoin(BYRON, T0 + LISTING_AFTER_JOIN_MS + 2, store)).toBeNull();
    });

    it('keeps nothing that is no id, and a slot that is not one opens nothing', async () => {
        const store = memory();
        await keepListingAfterJoin(BYRON, 'https://spy.example.org/?x=1', T0, store);
        await keepListingAfterJoin('not an address', POST, T0, store);
        expect(store.map.size).toBe(0);
        store.map.set(LISTING_AFTER_JOIN_STORE_KEY, 'not json');
        expect(await takeListingAfterJoin(BYRON, T0, store)).toBeNull();
        store.map.set(LISTING_AFTER_JOIN_STORE_KEY, JSON.stringify({ 'byron.example.org': { id: '../settings', at: T0, joined: true } }));
        expect(await takeListingAfterJoin(BYRON, T0, store)).toBeNull();
    });
});

describe('where the listing they came for has gone', () => {
    it('the post screen says so in one line, not the screen\'s own', () => {
        expect(openedForListing('1')).toBe(true);
        expect(openedForListing(['1'])).toBe(true);
        expect(openedForListing(undefined)).toBe(false);
        expect(missingListingLine(true)).toBe('The listing you came for is no longer up.');
        expect(missingListingLine(false)).toBe('Post not found. It may have been expired by the Network.');
    });

    it('in the member\'s language', () => {
        const es = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../packages/beanpool-core/words/es.json', import.meta.url).href), 'utf8'));
        setLanguage('es', [es]);
        expect(missingListingLine(true)).toBe('El anuncio por el que viniste ya no está publicado.');
    });
});
