import { describe, it, expect } from 'vitest';
import { FIND_COMMUNITY_WORDS, NEAR_COMMUNITY_KM, findCommunityState, knownCommunityCount } from '../find-community';

const FETCHED = '2026-10-14T08:00:00.000Z';
const at = (km: number | null) => ({ distanceKm: km });

describe('findCommunityState: what "Find your community" may say', () => {
    it('near: the nearest listed is within 250 km, the radius both apps call "within reach"', () => {
        expect(NEAR_COMMUNITY_KM).toBe(250);
        expect(findCommunityState({ communities: [at(12)], communityCount: 38, point: 'request', directoryFetchedAt: FETCHED })).toBe('near');
        expect(findCommunityState({ communities: [at(250)], communityCount: 1, point: 'area', directoryFetchedAt: FETCHED })).toBe('near');
    });

    it('far: Nairobi and Lyon get Lismore at 12,489 km (rehearsal B2): never "nearest you"', () => {
        expect(findCommunityState({ communities: [at(12_489), at(12_530)], communityCount: 10, point: 'request', directoryFetchedAt: FETCHED })).toBe('far');
        expect(findCommunityState({ communities: [at(250.5)], communityCount: 1, point: 'request', directoryFetchedAt: FETCHED })).toBe('far');
    });

    it('not_loaded: an empty answer before the first fetch is unknown, never "none" (privacy review M3)', () => {
        // The node's answer, measured, on the first hour after a boot: communities [], count 0, directoryFetchedAt null.
        expect(findCommunityState({ communities: [], communityCount: 0, point: 'request', directoryFetchedAt: null })).toBe('not_loaded');
        expect(findCommunityState({ communities: [], communityCount: 0, point: null, directoryFetchedAt: null })).toBe('not_loaded');
        expect(findCommunityState({ communities: [], point: 'request' })).toBe('not_loaded');
    });

    it('none: only once the directory is loaded', () => {
        expect(findCommunityState({ communities: [], communityCount: 0, point: 'request', directoryFetchedAt: FETCHED })).toBe('none');
        expect(findCommunityState({ communities: [], communityCount: 0, point: null, directoryFetchedAt: FETCHED })).toBe('none');
        // Listed, but none with a place: none near, measured.
        expect(findCommunityState({ communities: [], communityCount: 4, point: 'area', directoryFetchedAt: FETCHED })).toBe('none');
    });

    it('no_point: measured from nowhere, a count said when the node said one, never a missing count as 0', () => {
        expect(findCommunityState({ communities: [], communityCount: 38, point: null, directoryFetchedAt: null })).toBe('no_point');
        expect(findCommunityState({ communities: [], communityCount: null, point: null, directoryFetchedAt: FETCHED })).toBe('no_point');
        expect(findCommunityState({ communities: [], point: null, directoryFetchedAt: FETCHED })).toBe('no_point');
    });

    it('a community with no distance is near nothing', () => {
        expect(findCommunityState({ communities: [at(null)], communityCount: 1, point: null, directoryFetchedAt: FETCHED })).toBe('no_point');
        expect(findCommunityState({ communities: [at(null), at(30)], communityCount: 2, point: 'request', directoryFetchedAt: FETCHED })).toBe('near');
    });

    it('knownCommunityCount: a whole number from 0, else unknown', () => {
        expect(knownCommunityCount(0)).toBe(0);
        expect(knownCommunityCount(38)).toBe(38);
        for (const v of [undefined, null, -1, 2.5, '3', NaN, Infinity]) expect(knownCommunityCount(v)).toBeNull();
    });

    it('one "none" sentence, and no promise the web cannot keep', () => {
        expect(FIND_COMMUNITY_WORDS.noneNear).toBe('No community near you yet.');
        expect(FIND_COMMUNITY_WORDS.farLead(1)).toBe('The nearest listed is far from here:');
        expect(FIND_COMMUNITY_WORDS.farLead(3)).toBe('The nearest listed are far from here:');
        const all = [FIND_COMMUNITY_WORDS.notLoaded, FIND_COMMUNITY_WORDS.noneNear, FIND_COMMUNITY_WORDS.farLead(2), FIND_COMMUNITY_WORDS.start].join(' ');
        expect(all).not.toMatch(/ask to be told|Beans|Ʀ/i);
        expect(FIND_COMMUNITY_WORDS.notLoaded).not.toMatch(/\bno community\b|\bnone\b/i);
    });
});
