import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createAddressLookup, parseNominatimResults, dedupeAddressResults, shortAddressName, buildNominatimSearchUrl,
    type AddressLookupState,
} from '../address-lookup.js';

const BYRON = [{ display_name: 'Byron Bay, NSW, Australia', name: 'Byron Bay', lat: '-28.6474', lon: '153.6120', type: 'town' }];

function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
}

describe('buildNominatimSearchUrl', () => {
    it('matches the request the settings app has always sent', () => {
        expect(buildNominatimSearchUrl('Byron Bay & co')).toBe(
            'https://nominatim.openstreetmap.org/search?format=json&q=Byron%20Bay%20%26%20co&limit=5',
        );
    });
});

describe('parseNominatimResults', () => {
    it('parses lat/lon strings, rounds to 6 places, keeps type and a short name', () => {
        const r = parseNominatimResults([
            { display_name: 'Somewhere, X', lat: '-28.12345678', lon: '153.98765432', type: 'house', name: '' },
        ]);
        expect(r).toEqual([{ displayName: 'Somewhere, X', shortName: 'Somewhere', lat: -28.123457, lng: 153.987654, type: 'house' }]);
    });

    it('drops malformed and out-of-range entries and never throws on a bad body', () => {
        expect(parseNominatimResults(null)).toEqual([]);
        expect(parseNominatimResults({ error: 'x' })).toEqual([]);
        expect(parseNominatimResults([
            null, 'x', { display_name: 'a', lat: 'nope', lon: '1' }, { display_name: 'b', lat: '95', lon: '1' },
            { lat: '1', lon: '1' }, { display_name: 'ok', lat: '1', lon: '2' },
        ]).map(r => r.displayName)).toEqual(['ok']);
    });

    it('returns at most the limit', () => {
        const many = Array.from({ length: 9 }, (_, i) => ({ display_name: `P${i}`, lat: '1', lon: '1' }));
        expect(parseNominatimResults(many)).toHaveLength(5);
    });
});

describe('shortAddressName', () => {
    it('prefers Nominatim name, else the first part, keeping a house number with its street', () => {
        expect(shortAddressName({ name: 'Byron Bay', display_name: 'Byron Bay, NSW' })).toBe('Byron Bay');
        expect(shortAddressName({ name: '', display_name: '12, Main Street, Mullumbimby' })).toBe('12 Main Street');
        expect(shortAddressName({ display_name: '4/12a, Main Street, Mullumbimby' })).toBe('4/12a Main Street');
        expect(shortAddressName({ display_name: 'Civic Hall, Dalley St' })).toBe('Civic Hall');
        expect(shortAddressName({})).toBe('');
    });
});

describe('dedupeAddressResults', () => {
    it('keeps the first of rows with the same display name (street segments)', () => {
        const r = parseNominatimResults([
            { display_name: 'Dalley Street, Mullumbimby', lat: '-28.55', lon: '153.50' },
            { display_name: 'Dalley Street, Mullumbimby', lat: '-28.56', lon: '153.51' },
            { display_name: 'Dalley Lane, Mullumbimby', lat: '-28.57', lon: '153.52' },
        ]);
        expect(dedupeAddressResults(r).map(x => x.lat)).toEqual([-28.55, -28.57]);
    });
});

describe('createAddressLookup', () => {
    let states: AddressLookupState[];
    let clock: number;
    beforeEach(() => {
        vi.useFakeTimers();
        states = [];
        clock = 0;
    });
    afterEach(() => { vi.useRealTimers(); });

    const make = (fetch: any, extra: Record<string, unknown> = {}) => createAddressLookup({
        fetch, onState: s => states.push(s), now: () => clock, ...extra,
    });
    const tick = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };

    it('debounces: one request 1 s after the typing stops, not one per keystroke', async () => {
        const fetch = vi.fn().mockResolvedValue(okResponse(BYRON));
        const l = make(fetch);
        l.input('Byr'); await tick(300);
        l.input('Byro'); await tick(300);
        l.input('Byron Bay'); await tick(999);
        expect(fetch).not.toHaveBeenCalled();
        expect(states.at(-1)?.status).toBe('searching');
        await tick(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][0]).toContain('q=Byron%20Bay');
        expect(states.at(-1)).toEqual({ status: 'done', query: 'Byron Bay', results: parseNominatimResults(BYRON) });
    });

    it('under 3 characters goes idle at once and cancels the pending search', async () => {
        const fetch = vi.fn().mockResolvedValue(okResponse(BYRON));
        const l = make(fetch);
        l.input('Syd');
        expect(states.at(-1)?.status).toBe('searching');
        l.input('Sy');
        expect(states.at(-1)?.status).toBe('idle');
        await tick(2000);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('aborts the in-flight request when the text changes, and its late answer is never reported', async () => {
        let firstSignal: AbortSignal | undefined;
        let resolveFirst: (v: unknown) => void = () => {};
        const fetch = vi.fn()
            .mockImplementationOnce((_url: string, init: any) => {
                firstSignal = init.signal;
                return new Promise(r => { resolveFirst = r; });
            })
            .mockResolvedValueOnce(okResponse([{ display_name: 'Lismore', lat: '-28.8', lon: '153.2' }]));
        const l = make(fetch);
        l.input('Byron'); await tick(1000);
        expect(fetch).toHaveBeenCalledTimes(1);
        l.input('Lismore');
        expect(firstSignal?.aborted).toBe(true);
        resolveFirst(okResponse(BYRON));
        await tick(1000);
        const done = states.filter(s => s.status === 'done');
        expect(done).toHaveLength(1);
        expect(done[0].results[0].displayName).toBe('Lismore');
    });

    it('never sends two requests less than 1 s apart, even with submit()', async () => {
        const fetch = vi.fn().mockImplementation(async () => okResponse(BYRON));
        const l = make(fetch);
        l.submit('Byron');
        await tick(0);
        expect(fetch).toHaveBeenCalledTimes(1);
        l.submit('Lismore');
        await tick(500);
        expect(fetch).toHaveBeenCalledTimes(1);
        await tick(500);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('answers a repeated query from its cache without a request', async () => {
        const fetch = vi.fn().mockImplementation(async () => okResponse(BYRON));
        const l = make(fetch);
        l.input('Byron Bay'); await tick(1000);
        l.input('Byron'); l.input('byron bay ');
        expect(states.at(-1)?.status).toBe('done');
        await tick(3000);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('reports a failure (offline, HTTP error, bad JSON) as error rather than spinning', async () => {
        const offline = make(vi.fn().mockRejectedValue(new TypeError('Network request failed')));
        offline.input('Byron'); await tick(1000);
        expect(states.at(-1)).toEqual({ status: 'error', query: 'Byron', results: [] });

        states = [];
        const http = make(vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
        http.input('Byron'); await tick(1000);
        expect(states.at(-1)?.status).toBe('error');

        states = [];
        const bad = make(vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('x'); } }));
        bad.input('Byron'); await tick(1000);
        expect(states.at(-1)?.status).toBe('error');
    });

    it('does not cache a failure', async () => {
        const fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('offline'))
            .mockResolvedValueOnce(okResponse(BYRON));
        const l = make(fetch);
        l.input('Byron'); await tick(1000);
        l.input('Byron'); await tick(1000);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(states.at(-1)?.status).toBe('done');
    });

    it('sends the headers it is given (the phone names the app in User-Agent)', async () => {
        const fetch = vi.fn().mockResolvedValue(okResponse([]));
        const l = make(fetch, { headers: { 'User-Agent': 'BeanPool/1 (+https://beanpool.org)' } });
        l.input('Byron'); await tick(1000);
        expect(fetch.mock.calls[0][1].headers).toEqual({ 'User-Agent': 'BeanPool/1 (+https://beanpool.org)' });
        expect(states.at(-1)).toEqual({ status: 'done', query: 'Byron', results: [] });
    });

    it('dedupes only when asked, so the settings app lists exactly what Nominatim sent', async () => {
        const twice = [BYRON[0], { ...BYRON[0], lat: '-28.65' }];
        const plain = make(vi.fn().mockResolvedValue(okResponse(twice)));
        plain.input('Byron'); await tick(1000);
        expect(states.at(-1)?.results).toHaveLength(2);
        states = [];
        const deduped = make(vi.fn().mockResolvedValue(okResponse(twice)), { dedupe: true });
        deduped.input('Byron'); await tick(1000);
        expect(states.at(-1)?.results).toHaveLength(1);
    });

    it('dispose() clears the timer, aborts, and reports nothing afterwards', async () => {
        let signal: AbortSignal | undefined;
        const fetch = vi.fn().mockImplementation((_u: string, init: any) => { signal = init.signal; return new Promise(() => {}); });
        const l = make(fetch);
        l.input('Byron'); await tick(1000);
        l.input('Lismore');
        const before = states.length;
        l.dispose();
        expect(vi.getTimerCount()).toBe(0);
        await tick(5000);
        expect(states.length).toBe(before);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(signal?.aborted).toBe(true);
    });
});
