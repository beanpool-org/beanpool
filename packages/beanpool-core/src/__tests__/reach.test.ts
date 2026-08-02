import { describe, it, expect } from 'vitest';
import { reachAdmitsPeer, parseReachPeers, isPostReach, POST_REACH_VALUES } from '../protocol.js';

const BYRON = '12D3KooWByronPeerId';
const BRISBANE = '12D3KooWBrisbanePeerId';

describe('reachAdmitsPeer', () => {
    it('admits everyone when reach is everywhere', () => {
        expect(reachAdmitsPeer('everywhere', null, BYRON)).toBe(true);
        expect(reachAdmitsPeer('everywhere', [], BRISBANE)).toBe(true);
    });

    it('admits nobody when reach is local', () => {
        expect(reachAdmitsPeer('local', null, BYRON)).toBe(false);
        // Even a named peer is refused: the reach is what the poster chose, and the list is stale data
        // left behind by an earlier choice.
        expect(reachAdmitsPeer('local', [BYRON], BYRON)).toBe(false);
    });

    it('admits only the named peers', () => {
        expect(reachAdmitsPeer('peers', [BYRON], BYRON)).toBe(true);
        expect(reachAdmitsPeer('peers', [BYRON], BRISBANE)).toBe(false);
        expect(reachAdmitsPeer('peers', [], BYRON)).toBe(false);
        expect(reachAdmitsPeer('peers', null, BYRON)).toBe(false);
    });

    it('matches peer ids exactly, never by prefix', () => {
        // A peer id is a public-key hash and a prefix match would let a peer that merely shares an opening
        // read another community's listings. Cheap to assert, catastrophic to get wrong.
        expect(reachAdmitsPeer('peers', [BYRON], BYRON.slice(0, 10))).toBe(false);
        expect(reachAdmitsPeer('peers', [BYRON.slice(0, 10)], BYRON)).toBe(false);
    });

    it('FAILS CLOSED on anything unrecognised', () => {
        // A row written before the column existed reads as null. Anything else is a client bug or a
        // future value this build does not know. All of them mean "stays home" — the alternative exports a
        // listing whose author never agreed to it travelling.
        for (const bad of [null, undefined, '', 'LOCAL', 'Everywhere', 'peer', 'all', 'global', 0, 1, true, {}, []]) {
            expect(reachAdmitsPeer(bad as any, [BYRON], BYRON)).toBe(false);
        }
    });

    it('refuses a blank peer id whatever the reach', () => {
        // Otherwise 'everywhere' would admit a caller that failed to identify itself at all.
        expect(reachAdmitsPeer('everywhere', null, '')).toBe(false);
        expect(reachAdmitsPeer('peers', [''], '')).toBe(false);
    });
});

describe('parseReachPeers', () => {
    it('reads a JSON array of ids', () => {
        expect(parseReachPeers(JSON.stringify([BYRON, BRISBANE]))).toEqual([BYRON, BRISBANE]);
    });

    it('returns an empty list for anything unusable rather than throwing', () => {
        // This value is client-written and is read on the marketplace path. A throw here would take a
        // listing read down with it; an empty list just means the listing stays home.
        for (const bad of [null, undefined, '', 'not json', '{"a":1}', '42', '"a string"', '[']) {
            expect(parseReachPeers(bad as any)).toEqual([]);
        }
    });

    it('drops non-string and empty entries', () => {
        expect(parseReachPeers(JSON.stringify([BYRON, 42, null, '', BRISBANE, {}]))).toEqual([BYRON, BRISBANE]);
    });
});

describe('isPostReach', () => {
    it('accepts exactly the three tiers', () => {
        expect(POST_REACH_VALUES).toEqual(['local', 'peers', 'everywhere']);
        for (const v of POST_REACH_VALUES) expect(isPostReach(v)).toBe(true);
        for (const v of ['LOCAL', 'Peers', 'everywhere ', '', null, undefined, 1]) {
            expect(isPostReach(v)).toBe(false);
        }
    });
});
