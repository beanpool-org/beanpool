import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) }));

const mem = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.store.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.store.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.store.delete(k); }),
    },
}));

import { parseNominatimResults, FIND_TOWN_SEARCH_WORDS, NOT_HERE_TYPE_YOUR_TOWN } from '@beanpool/core';
import {
    typedPlaceFrom, readTypedPlace, saveTypedPlace, forgetTypedPlace, nearLine, LOCATION_NOTES, TYPED_PLACE_STORE_KEY,
} from '../typed-place';
import { fetchCommunities, fetchGlobalHome } from '../community-directory';

const [lismore] = parseNominatimResults([
    { display_name: 'Lismore, Lismore City Council, New South Wales, 2480, Australia', name: 'Lismore', lat: '-28.8135', lon: '153.2773', type: 'town' },
]);

beforeEach(() => { mem.store.clear(); });

describe('a typed town (Marty, 14 Oct: "or enter your location manually")', () => {
    it('keeps only the short name and the point at two decimals, as Home keeps the phone’s own place', async () => {
        expect(typedPlaceFrom(lismore)).toEqual({ lat: -28.81, lng: 153.28, name: 'Lismore' });
        expect(await saveTypedPlace(lismore)).toEqual({ lat: -28.81, lng: 153.28, name: 'Lismore' });
        expect(JSON.parse(mem.store.get(TYPED_PLACE_STORE_KEY)!)).toEqual({ lat: -28.81, lng: 153.28, name: 'Lismore' });
        expect(await readTypedPlace()).toEqual({ lat: -28.81, lng: 153.28, name: 'Lismore' });
        expect(nearLine((await readTypedPlace())!)).toBe('Near Lismore');
    });

    it('"Use my location" forgets it; anything that isn’t a place is never kept or read back', async () => {
        await saveTypedPlace(lismore);
        await forgetTypedPlace();
        expect(await readTypedPlace()).toBeNull();
        expect(await saveTypedPlace({ ...lismore, lat: 91 })).toBeNull();
        expect(await saveTypedPlace({ ...lismore, lng: Number.NaN })).toBeNull();
        mem.store.set(TYPED_PLACE_STORE_KEY, '{"lat":"x","lng":2}');
        expect(await readTypedPlace()).toBeNull();
        mem.store.set(TYPED_PLACE_STORE_KEY, 'not json');
        expect(await readTypedPlace()).toBeNull();
    });

    it('the picked town is sent as lat/lng, the same request the phone’s place makes, so the nearest list follows it', async () => {
        const urls: string[] = [];
        (globalThis as any).fetch = vi.fn(async (url: string) => {
            urls.push(url);
            return new Response(JSON.stringify({ communities: [], total: 0, point: 'request', communityCount: 0 }), { status: 200 });
        });
        const p = (await saveTypedPlace(lismore))!;
        await fetchCommunities({ point: p, limit: 20 });
        await fetchGlobalHome(p);
        expect(urls[0]).toMatch(/\/api\/global\/communities\?lat=-28\.8100&lng=153\.2800&limit=20$/);
        expect(urls[1]).toMatch(/\/api\/global\/home\?lat=-28\.8100&lng=153\.2800$/);
    });

    it('location off or failed: the note offers typing the town, and searching by name', () => {
        expect(LOCATION_NOTES.off).toBe('Location is off for BeanPool. Type your town instead, or search by name below.');
        expect(LOCATION_NOTES.failed).toContain('Type your town instead');
    });

    it('the town search says it in its own words: a town, not a street; OpenStreetMap is named', () => {
        expect(FIND_TOWN_SEARCH_WORDS.placeholder).toBe('Your town or suburb');
        expect(FIND_TOWN_SEARCH_WORDS.source).toContain('OpenStreetMap');
    });
});

describe('the lookup is the shared one (no second geocoder, no new host)', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, '..', '..', p), 'utf8');

    it('the find screen and the Home card use components/AddressSearch, and neither asks a geocoder itself', () => {
        const screen = src('app/find-community.tsx');
        expect(screen).toMatch(/import \{ AddressSearch \} from '\.\.\/components\/AddressSearch'/);
        expect(screen).toContain('words={FIND_TOWN_SEARCH_WORDS}');
        // Location off or failed: the note offers the town, and the box opens.
        expect(screen).toMatch(/setLocationNote\(LOCATION_NOTES\.off\);\s*setTownOpen\(true\);/);
        expect(screen).toMatch(/setLocationNote\(LOCATION_NOTES\.failed\);\s*setTownOpen\(true\);/);
        for (const file of ['app/find-community.tsx', 'components/home/FindCommunityBody.tsx', 'utils/typed-place.ts']) {
            const s = src(file);
            expect(s, file).not.toMatch(/nominatim|geocod|openstreetmap\.org|mapbox|googleapis/i);
            expect(s, file).not.toMatch(/createAddressLookup/);
        }
    });

    // The #1917 check's findings 3 and 6 (phone side).
    it('the town box can be closed with nothing picked; a place from the phone keeps a quiet "Not here? Type your town"', () => {
        const screen = src('app/find-community.tsx');
        expect(NOT_HERE_TYPE_YOUR_TOWN).toBe('Not here? Type your town');
        // Cancel sits with the open box and only closes it: the typed town (and its "Near Lismore") stands.
        expect(screen).toMatch(/\{townOpen && \([\s\S]*?<AddressSearch [\s\S]*?onPress=\{\(\) => setTownOpen\(false\)\}[\s\S]*?testID="find-town-cancel"[\s\S]*?>Cancel<\/Text>/);
        expect(screen).toMatch(/\{typed && !townOpen && \(\s*<View style=\{styles\.placeRow\} testID="find-town-picked">/);
        // A point the phone found (not typed): the town is still one tap away.
        expect(screen).toMatch(/\{!!point && !typed && !townOpen && \(\s*<Pressable [^>]*onPress=\{\(\) => setTownOpen\(true\)\}[^>]*testID="find-type-town-instead">\s*<Text style=\{styles\.linkText\}>\{NOT_HERE_TYPE_YOUR_TOWN\}<\/Text>/);
    });

    it('Sign Out and Replace wipe the typed town with the account', () => {
        expect(src('utils/identity.ts')).toContain('storage.removeItem(TYPED_PLACE_STORE_KEY)');
    });
});
