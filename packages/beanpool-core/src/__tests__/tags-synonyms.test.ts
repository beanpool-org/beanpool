/**
 * The tag library replaces the hand-written synonym map: synonyms.ts is now generated from it (scripts/tags/to-synonyms.mjs),
 * and search must find exactly what it found before (DESIGN-owner-seeding-tags-fable.md §4.6, slice T1). Both fixtures were
 * written from main before the library existed: the map as it was, and searchTermsFor's terms for 200 queries (keys,
 * broader words, plurals, several words, other scripts, compounds, no match).
 */
import { describe, expect, it } from 'vitest';
import { searchTermsFor } from '../search-terms.js';
import { SYNONYM_MAP } from '../synonyms.js';
import before from './fixtures/synonym-map-before-tags.json';
import fixture from './fixtures/search-terms-200.json';

// The engine asks at most this many words (engine-pkg posts.ts SEARCH_TERMS_MAX) and drops the rest in order, so the
// order of the terms matters only past it.
const SEARCH_TERMS_MAX = 256;

describe('search finds what it found before the tag library', () => {
    it('the fixture holds 200 distinct queries', () => {
        expect(fixture).toHaveLength(200);
        expect(new Set(fixture.map((f) => f.query)).size).toBe(200);
    });

    it('searchTermsFor gives the same terms for every one of the 200 queries', () => {
        const differ = fixture.filter((f) => JSON.stringify([...searchTermsFor(f.query)].sort()) !== JSON.stringify(f.terms));
        expect(differ.map((f) => f.query)).toEqual([]);
    });

    it('no query expands past what the engine asks, so the terms’ order changes nothing', () => {
        for (const f of fixture) expect(searchTermsFor(f.query).length).toBeLessThanOrEqual(SEARCH_TERMS_MAX);
    });

    it('the map has the same keys, each with the same broader words, as before', () => {
        const old = before as Record<string, string[]>;
        expect(Object.keys(SYNONYM_MAP).sort()).toEqual(Object.keys(old).sort());
        const differ = Object.keys(old).filter((k) => JSON.stringify([...new Set(SYNONYM_MAP[k])].sort()) !== JSON.stringify([...new Set(old[k])].sort()));
        expect(differ).toEqual([]);
    });
});
