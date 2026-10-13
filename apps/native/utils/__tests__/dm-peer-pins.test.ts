import { describe, it, expect } from 'vitest';
import { readDmPeerPins, writeDmPeerPins, applyDmListings, pinAtFirstSight, dmPinFor, dmOpenPeers, acceptOffer, DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT, type DmPeerPins } from '../dm-peer-pins';
import { dmPeerPinsStoreKey } from '../storage-keys';

// The pin store itself (utils/dm-peer-pins.ts): what a listing may do to a pin, and what an unreadable store does. The
// phone's real sync and send over it are in dm-line-binding.test.ts.

const ME = 'aa'.repeat(32);
const BEN = 'bb'.repeat(32);
const PUPPET = 'cc'.repeat(32);
const OTHER = 'dd'.repeat(32);
const D0 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-10-14T00:00:00.000Z';

function memory(seed: Record<string, string> = {}) {
    const data = new Map(Object.entries(seed));
    return {
        data,
        getItem: async (k: string) => data.get(k) ?? null,
        setItem: async (k: string, v: string) => { data.set(k, v); },
    };
}

describe('readDmPeerPins', () => {
    it('reads only this account\'s pins, under its key lower-cased, with ids folded', async () => {
        const s = memory({
            [dmPeerPinsStoreKey(ME)]: JSON.stringify({ [D0.toUpperCase()]: { peer: BEN.toUpperCase(), since: NOW, by: 'first-seen' } }),
            [dmPeerPinsStoreKey(OTHER)]: JSON.stringify({ [D0]: { peer: PUPPET, since: NOW, by: 'first-seen' } }),
        });
        expect(dmPeerPinsStoreKey(ME.toUpperCase())).toBe(dmPeerPinsStoreKey(ME));
        expect(await readDmPeerPins(s, ME.toUpperCase())).toEqual({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } });
    });

    it('nothing stored is no pins; storage that throws, or holds something that isn\'t a pin object, is the store error', async () => {
        expect(await readDmPeerPins(memory(), ME)).toEqual({});
        const throwing = { getItem: async () => { throw new Error('io'); } };
        await expect(readDmPeerPins(throwing, ME)).rejects.toThrow(DM_PIN_STORE_UNREAD_TEXT);
        for (const raw of ['{not json', '[]', '"x"', 'null']) {
            await expect(readDmPeerPins(memory({ [dmPeerPinsStoreKey(ME)]: raw }), ME)).rejects.toBeInstanceOf(DmPinStoreError);
        }
    });

    it('passes over an entry that isn\'t a pin, and drops former keys that aren\'t keys', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME)]: JSON.stringify({
            a: { peer: 'not-a-key' },
            b: 'x',
            [D0]: { peer: BEN, since: NOW, by: 'member', former: [PUPPET, 'zz', BEN, PUPPET], offered: { peer: 'nope', at: NOW } },
        }) });
        expect(await readDmPeerPins(s, ME)).toEqual({ [D0]: { peer: BEN, since: NOW, by: 'member', former: [PUPPET], offered: { peer: null, at: NOW } } });
    });

    it('a write that the storage refuses is the store error', async () => {
        await expect(writeDmPeerPins({ setItem: async () => { throw new Error('full'); } }, ME, {})).rejects.toBeInstanceOf(DmPinStoreError);
    });
});

describe('applyDmListings: a listing offers, never moves', () => {
    const pinned = (): DmPeerPins => ({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } });

    it('no pin: one other key in every listing pins it at first sight; disagreeing listings, several others or none pin nothing', () => {
        let p: DmPeerPins = {};
        expect(applyDmListings(p, D0.toUpperCase(), [[BEN]], NOW)).toBe(true);
        expect(p).toEqual({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } });
        for (const listings of [[[BEN], [PUPPET]], [[BEN, PUPPET]], [[]], []]) {
            p = {};
            expect(applyDmListings(p, D0, listings, NOW)).toBe(false);
            expect(p).toEqual({});
        }
    });

    it('a listing without the pinned key offers the other key and leaves the pin; one with it as well as others changes nothing', () => {
        const p = pinned();
        expect(applyDmListings(p, D0, [[BEN, PUPPET]], NOW)).toBe(false);
        expect(p[D0].offered).toBeUndefined();
        expect(applyDmListings(p, D0, [[PUPPET]], NOW)).toBe(true);
        expect(p[D0]).toEqual({ peer: BEN, since: NOW, by: 'first-seen', offered: { peer: PUPPET, at: NOW } });
        expect(applyDmListings(p, D0, [[PUPPET]], '2026-10-15T00:00:00.000Z')).toBe(false);   // the same offer keeps its time
        expect(p[D0].offered?.at).toBe(NOW);
    });

    it('a twin listed beside the DM (the same id in capitals) offers its key; the offer clears only once every listing names the pinned key', () => {
        const p = pinned();
        expect(applyDmListings(p, D0, [[BEN], [PUPPET]], NOW)).toBe(true);
        expect(p[D0].offered).toEqual({ peer: PUPPET, at: NOW });
        expect(applyDmListings(p, D0, [[BEN], []], NOW)).toBe(false);
        expect(p[D0].offered).toBeDefined();
        expect(applyDmListings(p, D0, [[BEN]], NOW)).toBe(true);
        expect(p[D0]).toEqual({ peer: BEN, since: NOW, by: 'first-seen' });
    });

    it('several other keys and not the pinned one: sends stop, with no key offered', () => {
        const p = pinned();
        expect(applyDmListings(p, D0, [[PUPPET, OTHER]], NOW)).toBe(true);
        expect(p[D0].offered).toEqual({ peer: null, at: NOW });
        expect(p[D0].peer).toBe(BEN);
    });
});

describe('pinAtFirstSight and dmOpenPeers', () => {
    it('never overwrites a pin, in any capitals of its id', () => {
        const p: DmPeerPins = {};
        expect(pinAtFirstSight(p, D0, BEN, NOW)).toBe(true);
        expect(pinAtFirstSight(p, D0.toUpperCase(), PUPPET, NOW)).toBe(false);
        expect(dmPinFor(p, D0.toUpperCase())?.peer).toBe(BEN);
        expect(pinAtFirstSight({}, D0, 'not-a-key', NOW)).toBe(false);
    });

    it('old lines open under the pinned key first, then the ones before it', () => {
        expect(dmOpenPeers({ peer: PUPPET, since: NOW, by: 'member', former: [BEN, PUPPET] })).toEqual([PUPPET, BEN]);
    });
});

describe('acceptOffer: the member\'s "Continue with the new key" (slice 2)', () => {
    const LATER = '2026-10-15T00:00:00.000Z';
    it('moves the pin to the key on offer, by the member, the old key first in former (pick 3), the offer gone', () => {
        const pins: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'first-seen', former: [OTHER], offered: { peer: PUPPET, at: NOW } } };
        expect(acceptOffer(pins, D0.toUpperCase(), PUPPET.toUpperCase(), LATER)).toBe(true);
        expect(pins[D0]).toEqual({ peer: PUPPET, since: LATER, by: 'member', former: [BEN, OTHER] });
    });
    it('never to a key that isn\'t on offer, nor when several keys are listed (peer null), nor with no pin', () => {
        const pins: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'first-seen', offered: { peer: PUPPET, at: NOW } } };
        const before = JSON.stringify(pins);
        expect(acceptOffer(pins, D0, OTHER, LATER)).toBe(false);
        expect(acceptOffer(pins, D0, BEN, LATER)).toBe(false);
        expect(acceptOffer(pins, D0, 'not a key', LATER)).toBe(false);
        expect(JSON.stringify(pins)).toBe(before);
        const several: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'first-seen', offered: { peer: null, at: NOW } } };
        expect(acceptOffer(several, D0, PUPPET, LATER)).toBe(false);
        expect(acceptOffer({}, D0, PUPPET, LATER)).toBe(false);
    });
    it('a first-seen pin with no offer: the member keeps that key as theirs, and only that key', () => {
        const pins: DmPeerPins = { [D0]: { peer: PUPPET, since: NOW, by: 'first-seen' } };
        expect(acceptOffer(pins, D0, BEN, LATER)).toBe(false);
        expect(acceptOffer(pins, D0, PUPPET, LATER)).toBe(true);
        expect(pins[D0]).toEqual({ peer: PUPPET, since: LATER, by: 'member' });
        expect(acceptOffer(pins, D0, PUPPET, LATER)).toBe(false);   // a member's pin with no offer: nothing to continue with
    });
    it('the former list holds each key once, never the pinned one', () => {
        const pins: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'member', former: [PUPPET, OTHER], offered: { peer: PUPPET, at: NOW } } };
        expect(acceptOffer(pins, D0, PUPPET, LATER)).toBe(true);
        expect(pins[D0].former).toEqual([BEN, OTHER]);
        expect(dmOpenPeers(pins[D0])).toEqual([PUPPET, BEN, OTHER]);
    });
});
