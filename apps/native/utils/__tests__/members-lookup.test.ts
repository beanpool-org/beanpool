import { describe, it, expect, vi, beforeEach } from 'vitest';

// Finding people on a community that says `membersOnDemand` (DESIGN-global-members-by-area §2.3–§2.4): the node search
// asks nothing under 2 letters, the near read is at most 50, a profile fetches a card by key when it is missing or a
// day old and keeps it stamped, and an unreachable node is said, never waited on. The lists' lines never say "Loading"
// for a list that will not load.

const calls: string[] = [];
const writes: any[] = [];
const writtenTo: unknown[][] = [];
let answer: { ok: boolean; body: unknown } | 'throw' = { ok: true, body: [] };
vi.mock('../db', () => ({
    signedGet: vi.fn(async (path: string) => {
        calls.push(path);
        if (answer === 'throw') throw new TypeError('Network request failed');
        const a = answer;
        return { ok: a.ok, json: async () => a.body };
    }),
    applyDelta: vi.fn(async (delta: any, ...copy: unknown[]) => { writes.push(delta); writtenTo.push(copy); return true; }),
    copyForRead: vi.fn(async () => ({ dbName: 'beanpool_global.example.db', generation: 3 })),
}));

import { searchPath, nearPath, lookUpMembers, cardNeedsFetch, fetchCardByKey, keepCards, asHeldRow, CARD_FRESH_MS } from '../members-lookup';
import { communityListEmpty, communityListNote } from '../community-list-note';

const KEY = 'c'.repeat(64);

beforeEach(() => {
    calls.length = 0;
    writes.length = 0;
    writtenTo.length = 0;
    answer = { ok: true, body: [] };
});

describe('the node search and near reads', () => {
    it('asks nothing under 2 letters, at most 20 by name, at most 50 near', () => {
        expect(searchPath('')).toBeNull();
        expect(searchPath(' a ')).toBeNull();
        expect(searchPath('An')).toBe('/api/members?q=An&limit=20');
        expect(searchPath('a%_b')).toBe('/api/members?q=a%25_b&limit=20');
        expect(nearPath({ lat: -28.5, lng: 153.5 })).toBe('/api/members?lat=-28.5&lng=153.5&limit=50');
    });

    it('a result is shown with its distance and never kept; an unreachable node answers null', async () => {
        answer = { ok: true, body: [{ publicKey: KEY, callsign: 'Cy', avatarUrl: null, joinedAt: '2026-01-01T00:00:00Z', distanceKm: 12 }] };
        expect(await lookUpMembers(nearPath({ lat: 0, lng: 0 }))).toEqual([expect.objectContaining({ public_key: KEY, callsign: 'Cy', distance_km: 12 })]);
        expect(writes).toEqual([]);
        answer = { ok: false, body: { code: 'heavy_read_busy' } };
        expect(await lookUpMembers('/api/members?q=Cy&limit=20')).toBeNull();
        answer = 'throw';
        expect(await lookUpMembers('/api/members?q=Cy&limit=20')).toBeNull();
    });

    it('a row with no name shows the key\'s first 8 characters', () => {
        expect(asHeldRow({ publicKey: KEY, callsign: '' })?.callsign).toBe(KEY.slice(0, 8));
        expect(asHeldRow({})).toBeNull();
    });
});

describe('a profile opened by key', () => {
    it('fetches when no card is held, never fetched by key, or a day old; not when fresh', () => {
        const now = Date.parse('2026-10-13T00:00:00Z');
        expect(cardNeedsFetch(null, now)).toBe(true);
        expect(cardNeedsFetch({ card_fetched_at: null }, now)).toBe(true);
        expect(cardNeedsFetch({ card_fetched_at: new Date(now - CARD_FRESH_MS - 1).toISOString() }, now)).toBe(true);
        expect(cardNeedsFetch({ card_fetched_at: new Date(now - 60_000).toISOString() }, now)).toBe(false);
    });

    it('keeps the card stamped; says none or unreachable otherwise', async () => {
        answer = { ok: true, body: [{ publicKey: KEY, callsign: 'Cy' }] };
        expect(await fetchCardByKey(KEY)).toBe('fetched');
        expect(calls).toEqual([`/api/members?keys=${KEY}`]);
        expect(writes[0].members).toEqual([{ publicKey: KEY, callsign: 'Cy' }]);
        expect(writes[0].membersFetched.keys).toEqual([KEY]);
        answer = { ok: true, body: [] };
        expect(await fetchCardByKey(KEY)).toBe('none');
        answer = { ok: false, body: {} };
        expect(await fetchCardByKey(KEY)).toBe('unreachable');
        answer = 'throw';
        expect(await fetchCardByKey(KEY)).toBe('unreachable');
        calls.length = 0;
        expect(await fetchCardByKey('escrow_x')).toBe('none');
        expect(calls).toEqual([]);
    });

    it('binds the card to the key asked, not the first row; writes it as a by-key answer, into the copy the read began in', async () => {
        const OTHER = 'd'.repeat(64);
        answer = { ok: true, body: [{ publicKey: OTHER, callsign: 'NotAsked' }, { publicKey: KEY, callsign: 'Cy', avatarUrl: null }] };
        expect(await fetchCardByKey(KEY)).toBe('fetched');
        expect(writes[0].members).toEqual([{ publicKey: KEY, callsign: 'Cy', avatarUrl: null }]);
        // A by-key answer's null clears a removed photo (review of #1859, B2), in the copy open when it was asked (NB3).
        expect(writes[0].membersByKey).toBe(true);
        expect(writtenTo[0]).toEqual(['beanpool_global.example.db', 3]);
    });

    it('a DM from a search result keeps that card in the copy the search was read for', async () => {
        answer = { ok: true, body: [{ publicKey: KEY, callsign: 'Cy' }] };
        const rows = await lookUpMembers('/api/members?q=Cy&limit=20');
        await keepCards(rows!);
        expect(writes[0].membersFetched.keys).toEqual([KEY]);
        expect(writtenTo[0]).toEqual(['beanpool_global.example.db', 3]);
    });
});

describe('People → Community lines on a membersOnDemand community', () => {
    it('never says Loading for a list that will not load', () => {
        for (const note of ['near', 'search', 'noArea', 'held'] as const) {
            expect(communityListEmpty(note, '')).not.toMatch(/Loading/);
            expect(communityListEmpty(note, 'ab')).not.toMatch(/Loading/);
            expect(communityListNote(note, 'ab').length).toBeGreaterThan(0);
        }
        expect(communityListNote('noArea', '')).toBe("Set your area to see who's near you. Search a name to find anyone.");
        expect(communityListNote('held', '')).toMatch(/^People you've dealt with/);
        // A community that doesn't say keeps its words.
        expect(communityListEmpty(null, '')).toBe('Loading community...');
        expect(communityListEmpty(null, 'x')).toBe('No members match your search.');
    });
});
