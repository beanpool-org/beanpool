import { describe, it, expect, vi } from 'vitest';
import { readDmPeerPins, writeDmPeerPins, applyDmListings, pinAtFirstSight, dmPinFor, dmSightFor, judgeFirstSight, applySightVerdict, settleFirstSight, dmOpenPeers, acceptOffer, createDmPinBook, DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT, markHeldLost, noRoomForFirstSight, rekeyDateOf, DmPinsFullError, DM_PINS_MAX_BYTES, FORMER_MAX, salvagePinIds, type DmPeerPins, type DmPeerPin } from '../dm-peer-pins';
import { dmPeerPinsStoreKey, dmPeerPinsSetAsideStoreKey } from '../storage-keys';

// The pin store itself (utils/dm-peer-pins.ts): what a listing may do to a pin, and what an unreadable store does. The
// phone's real sync and send over it are in dm-line-binding.test.ts.

const ME = 'aa'.repeat(32);
const BEN = 'bb'.repeat(32);
const PUPPET = 'cc'.repeat(32);
const OTHER = 'dd'.repeat(32);
const D0 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-10-14T00:00:00.000Z';

/** The stored value: one account's pins in one community file (§3.4 amendment 6); its presence records that file's seed. */
const record = (pins: Record<string, unknown>) => JSON.stringify({ pins });
const FA = 'community_a.db';
const FB = 'community_b.db';

function memory(seed: Record<string, string> = {}) {
    const data = new Map(Object.entries(seed));
    return {
        data,
        getItem: async (k: string) => data.get(k) ?? null,
        setItem: async (k: string, v: string) => { data.set(k, v); },
        removeItem: async (k: string) => { data.delete(k); },
    };
}

describe('readDmPeerPins', () => {
    it('reads only this account\'s pins in this file, under its key lower-cased, with ids folded', async () => {
        const s = memory({
            [dmPeerPinsStoreKey(ME, FA)]: record({ [D0.toUpperCase()]: { peer: BEN.toUpperCase(), since: NOW, by: 'first-seen' } }),
            [dmPeerPinsStoreKey(OTHER, FA)]: record({ [D0]: { peer: PUPPET, since: NOW, by: 'first-seen' } }),
            [dmPeerPinsStoreKey(ME, FB)]: record({ [D0]: { peer: PUPPET, since: NOW, by: 'first-seen' } }),
        });
        expect(dmPeerPinsStoreKey(ME.toUpperCase(), FA)).toBe(dmPeerPinsStoreKey(ME, FA));
        expect(await readDmPeerPins(s, ME.toUpperCase(), FA)).toEqual({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } });
    });

    it('nothing stored is no pins; storage that throws, or holds something that isn\'t a pin object, is the store error', async () => {
        expect(await readDmPeerPins(memory(), ME, FA)).toEqual({});
        expect(await readDmPeerPins(memory({ [dmPeerPinsStoreKey(ME, FA)]: '{"pins":{}}' }), ME, FA)).toEqual({});
        const throwing = { getItem: async () => { throw new Error('io'); } };
        await expect(readDmPeerPins(throwing, ME, FA)).rejects.toThrow(DM_PIN_STORE_UNREAD_TEXT);
        // Not the value (§3.4 amendment 6): no pins object.
        for (const raw of ['{not json', '[]', '"x"', 'null', '{}', JSON.stringify({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }), '{"pins":[]}', '{"pins":"x"}', '{"pins":null}']) {
            await expect(readDmPeerPins(memory({ [dmPeerPinsStoreKey(ME, FA)]: raw }), ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        }
    });

    it('passes over an entry that isn\'t a pin, and drops former keys that aren\'t keys', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: record({
            a: { peer: 'not-a-key' },
            b: 'x',
            [D0]: { peer: BEN, since: NOW, by: 'member', former: [PUPPET, 'zz', BEN, PUPPET], offered: { peer: 'nope', at: NOW } },
        }) });
        expect(await readDmPeerPins(s, ME, FA)).toEqual({ [D0]: { peer: BEN, since: NOW, by: 'member', former: [PUPPET], offered: { peer: null, at: NOW } } });
    });

    it('a write that the storage refuses is the store error', async () => {
        await expect(writeDmPeerPins({ setItem: async () => { throw new Error('full'); } }, ME, FA, {})).rejects.toBeInstanceOf(DmPinStoreError);
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
        expect((p[D0] as DmPeerPin).offered).toBeUndefined();
        expect(applyDmListings(p, D0, [[PUPPET]], NOW)).toBe(true);
        expect(p[D0]).toEqual({ peer: BEN, since: NOW, by: 'first-seen', offered: { peer: PUPPET, at: NOW } });
        expect(applyDmListings(p, D0, [[PUPPET]], '2026-10-15T00:00:00.000Z')).toBe(false);   // the same offer keeps its time
        expect((p[D0] as DmPeerPin).offered?.at).toBe(NOW);
    });

    it('a twin listed beside the DM (the same id in capitals) offers its key; the offer clears only once every listing names the pinned key', () => {
        const p = pinned();
        expect(applyDmListings(p, D0, [[BEN], [PUPPET]], NOW)).toBe(true);
        expect((p[D0] as DmPeerPin).offered).toEqual({ peer: PUPPET, at: NOW });
        expect(applyDmListings(p, D0, [[BEN], []], NOW)).toBe(false);
        expect((p[D0] as DmPeerPin).offered).toBeDefined();
        expect(applyDmListings(p, D0, [[BEN]], NOW)).toBe(true);
        expect(p[D0]).toEqual({ peer: BEN, since: NOW, by: 'first-seen' });
    });

    it('several other keys and not the pinned one: sends stop, with no key offered', () => {
        const p = pinned();
        expect(applyDmListings(p, D0, [[PUPPET, OTHER]], NOW)).toBe(true);
        expect((p[D0] as DmPeerPin).offered).toEqual({ peer: null, at: NOW });
        expect((p[D0] as DmPeerPin).peer).toBe(BEN);
    });

    it('a pause the member\'s reset made stays one when a later listing offers a third key (§3.4 amendment 7 §1; #1872/#1873 confirmation 6, finding 4)', () => {
        const LATER = '2026-10-15T00:00:00.000Z';
        const p: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'first-seen', offered: { peer: PUPPET, at: NOW, firstSight: true, afterReset: true } } };
        expect(applyDmListings(p, D0, [[OTHER]], LATER)).toBe(true);
        expect((p[D0] as DmPeerPin).offered).toEqual({ peer: OTHER, at: LATER, firstSight: true, afterReset: true });
    });

    it('a first-sight pause ends only on the member\'s tap: no listing lifts it, and a third key in between keeps it a first-sight pause (§3.4 amendment 2, option H)', () => {
        const LATER = '2026-10-15T00:00:00.000Z';
        const p: DmPeerPins = { [D0]: { peer: PUPPET, since: NOW, by: 'first-seen', checked: true, offered: { peer: BEN, at: NOW, firstSight: true } } };
        expect(applyDmListings(p, D0, [[PUPPET]], LATER)).toBe(false);   // the node names the pin: still paused
        expect((p[D0] as DmPeerPin).offered).toEqual({ peer: BEN, at: NOW, firstSight: true });
        expect(applyDmListings(p, D0, [[OTHER]], LATER)).toBe(true);     // a detour through a third key
        expect((p[D0] as DmPeerPin).offered).toEqual({ peer: OTHER, at: LATER, firstSight: true });
        expect(applyDmListings(p, D0, [[PUPPET, OTHER]], LATER)).toBe(false);
        expect(applyDmListings(p, D0, [[OTHER, BEN]], LATER)).toBe(true);
        expect((p[D0] as DmPeerPin).offered).toEqual({ peer: null, at: LATER, firstSight: true });
        expect(applyDmListings(p, D0, [[PUPPET]], LATER)).toBe(false);
        expect(dmPinFor(p, D0)).toMatchObject({ peer: PUPPET, offered: { firstSight: true } });
        // An existing phone's offer (no firstSight) still clears when the listing names the pin again, and never becomes one.
        const q = pinned();
        applyDmListings(q, D0, [[PUPPET]], NOW);
        applyDmListings(q, D0, [[OTHER]], NOW);
        expect((q[D0] as DmPeerPin).offered).toEqual({ peer: OTHER, at: NOW });
        expect(applyDmListings(q, D0, [[BEN]], NOW)).toBe(true);
        expect((q[D0] as DmPeerPin).offered).toBeUndefined();
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
    const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    const D2 = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
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
    it('a pin with no offer, checked or not, and a rule-5 record (no key placed): nothing to continue with', () => {
        const pins: DmPeerPins = {
            [D0]: { peer: PUPPET, since: NOW, by: 'first-seen' },
            [D1]: { peer: PUPPET, since: NOW, by: 'first-seen', checked: true },
            [D2]: { unplaced: true, since: NOW, listed: PUPPET },
        };
        const before = JSON.stringify(pins);
        for (const id of [D0, D1, D2]) {
            expect(acceptOffer(pins, id, PUPPET, LATER)).toBe(false);
            expect(acceptOffer(pins, id, BEN, LATER)).toBe(false);
        }
        expect(JSON.stringify(pins)).toBe(before);
        expect(dmPinFor(pins, D2)).toBeNull();
    });
    it('a first-sight pause (rules 3-4) continues to the key on offer only; the verdict, the offer and what was heard go', () => {
        const pins: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true, heard: { tryKeys: [BEN], rekeyedAt: NOW }, offered: { peer: PUPPET, at: NOW, firstSight: true, nodeSays: { rekeyedAt: NOW } } } };
        expect(acceptOffer(pins, D0, BEN, LATER)).toBe(false);
        expect(acceptOffer(pins, D0, PUPPET, LATER)).toBe(true);
        expect(pins[D0]).toEqual({ peer: PUPPET, since: LATER, by: 'member', former: [BEN] });
        expect(acceptOffer(pins, D0, PUPPET, LATER)).toBe(false);   // a member's pin with no offer: nothing to continue with
    });
    it('an id the node chose ("__proto__") is an entry like any other: never a pin through the prototype', () => {
        const pins = Object.create(null) as DmPeerPins;
        expect(acceptOffer(pins, '__proto__', PUPPET, LATER)).toBe(false);
        pins[D0] = { peer: BEN, since: NOW, by: 'first-seen', checked: true, offered: { peer: PUPPET, at: NOW } };
        expect(acceptOffer(pins, '__proto__', PUPPET, LATER)).toBe(false);
        expect(Object.keys(pins)).toEqual([D0]);
        expect(({} as any).peer).toBeUndefined();
    });
    it('the former list holds each key once, never the pinned one', () => {
        const pins: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'member', former: [PUPPET, OTHER], offered: { peer: PUPPET, at: NOW } } };
        expect(acceptOffer(pins, D0, PUPPET, LATER)).toBe(true);
        expect(dmPinFor(pins, D0)!.former).toEqual([BEN, OTHER]);
        expect(dmOpenPeers(dmPinFor(pins, D0)!)).toEqual([PUPPET, BEN, OTHER]);
    });
    it('former keeps the 4 newest (§3.4 amendment 6): five Continues in a row drop the oldest each time past 4, newest first', () => {
        const keys = Array.from({ length: 6 }, (_, i) => String(i + 1).padStart(2, '0').repeat(32));
        const pins: DmPeerPins = { [D0]: { peer: keys[0], since: NOW, by: 'first-seen', checked: true } };
        for (let i = 1; i <= 5; i++) {
            pins[D0] = { ...(pins[D0] as DmPeerPin), offered: { peer: keys[i], at: NOW } };
            expect(acceptOffer(pins, D0, keys[i], LATER)).toBe(true);
        }
        expect(FORMER_MAX).toBe(4);
        expect(dmPinFor(pins, D0)).toEqual({ peer: keys[5], since: LATER, by: 'member', former: [keys[4], keys[3], keys[2], keys[1]] });
    });
});

describe('createDmPinBook: one copy per (account, file), one queue (#1872 review, findings 6 and 7; §3.4 amendment 6), one seed per community file (§3.4 amendment 5)', () => {
    const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    /** A book over `s` whose handles are the file names themselves. */
    const bookOf = (s: Parameters<typeof createDmPinBook>[0], seedFile?: (me: string, at: string, file: string) => Promise<(pins: DmPeerPins) => boolean>) => createDmPinBook<string>(s, (f) => f, seedFile);
    /** Storage that counts its reads and lets a test hold each write until it says. */
    function slow(seed: Record<string, string> = {}) {
        const s = memory(seed);
        let reads = 0;
        const held: Array<() => void> = [];
        return {
            ...s,
            reads: () => reads,
            held,
            getItem: async (k: string) => { reads++; return s.getItem(k); },
            setItem: async (k: string, v: string) => { await new Promise<void>((r) => held.push(r)); await s.setItem(k, v); },
        };
    }
    const stored = (s: { data: Map<string, string> }, file = FA, who = ME) => JSON.parse(s.data.get(dmPeerPinsStoreKey(who, file)) ?? 'null');

    it('two first sights at once, each write held: both pins are kept, in storage and in memory', async () => {
        const s = slow({ [dmPeerPinsStoreKey(ME, FA)]: record({}) });
        const book = bookOf(s);
        const a = book.update(ME, FA, (p) => pinAtFirstSight(p, D0, BEN, NOW));
        const b = book.update(ME, FA, (p) => pinAtFirstSight(p, D1, PUPPET, NOW));
        await vi.waitFor(() => expect(s.held.length).toBe(1));
        s.held.shift()!();   // the first write lands only now; the second waits its turn behind it
        await vi.waitFor(() => expect(s.held.length).toBe(1));
        s.held.shift()!();
        expect(await Promise.all([a, b])).toEqual([true, true]);
        expect(Object.keys(stored(s).pins).sort()).toEqual([D0, D1].sort());
        expect(Object.keys(await book.read(ME, FA)).sort()).toEqual([D0, D1].sort());
    });

    it('reads storage once for the app\'s run, however many ask at once, and a change that changes nothing writes nothing', async () => {
        const s = slow({ [dmPeerPinsStoreKey(ME, FA)]: record({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }) });
        const book = bookOf(s);
        const copies = await Promise.all([book.read(ME, FA), book.read(ME, FA), book.read(ME.toUpperCase(), FA)]);
        expect(new Set(copies).size).toBe(1);
        expect(await book.update(ME, FA, (p) => pinAtFirstSight(p, D0, PUPPET, NOW))).toBe(false);
        expect(dmPinFor(await book.read(ME, FA), D0)?.peer).toBe(BEN);
        expect({ reads: s.reads(), writes: s.held.length }).toEqual({ reads: 1, writes: 0 });
        const other = book.read(OTHER, FA);   // another account: its own copy, read from its own key (and its own seed write)
        await vi.waitFor(() => expect(s.held.length).toBe(1));
        s.held.shift()!();
        await other;
        expect(s.reads()).toBe(2);
    });

    it('an unreadable store keeps nothing in memory: every ask refuses until it reads, and neither a seed nor a change is written over it', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: '{not json' });
        let seeds = 0;
        const book = bookOf(s, async () => { seeds++; return () => false; });
        await expect(book.read(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        await expect(book.update(ME, FA, (p) => pinAtFirstSight(p, D0, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(s.data.get(dmPeerPinsStoreKey(ME, FA))).toBe('{not json');
        expect(seeds).toBe(0);
        // Another file's pins are their own: read and seeded whatever A's value holds.
        expect(await book.read(ME, FB)).toEqual({});
        expect(seeds).toBe(1);
        s.data.set(dmPeerPinsStoreKey(ME, FA), record({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }));
        expect(dmPinFor(await book.read(ME, FA), D0)?.peer).toBe(BEN);
        expect(seeds).toBe(1);
    });

    it('a write the storage refuses throws, drops the copy, and the next ask holds what storage holds; the queue goes on', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: record({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }) });
        let refuse = true;
        const book = bookOf({ getItem: s.getItem, setItem: async (k, v) => { if (refuse) throw new Error('disk full'); await s.setItem(k, v); } });
        await expect(book.update(ME, FA, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(dmPinFor(await book.read(ME, FA), D1)).toBeNull();
        refuse = false;
        expect(await book.update(ME, FA, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).toBe(true);
        expect(Object.keys(stored(s).pins).sort()).toEqual([D0, D1].sort());
        expect(stored(s, FB)).toBeNull();
    });

    it('each file is seeded once, at the first ask with its handle and before it answers: the rows held then, as that file\'s value, whose presence is the record', async () => {
        const s = memory();
        const writes: string[] = [];
        const rows: Record<string, Array<[string, string]>> = { [FA]: [[D0, BEN]], [FB]: [[D1, BEN]] };
        const seen: string[] = [];
        const book = createDmPinBook<string>({ getItem: s.getItem, setItem: async (k, v) => { writes.push(v); await s.setItem(k, v); } }, (f) => f, async (_me, at, file) => {
            expect(at).toBe(file);
            seen.push(file);
            const held = [...rows[file]];
            return (pins) => { let c = false; for (const [id, pk] of held) if (pinAtFirstSight(pins, id, pk, NOW, undefined, true)) c = true; return c; };
        });
        await Promise.all([book.read(ME, FA), book.read(ME, FA), book.update(ME, FA, () => false)]);   // two readers share one seed
        expect(seen).toEqual([FA]);
        expect(writes.map((w) => JSON.parse(w))).toEqual([{ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } } }]);
        rows[FA].push([D1, PUPPET]);   // the node's rows, written in A after the seed: never seeded
        await book.read(ME, FA);
        expect(await book.read(ME, FB)).toEqual({ [D1]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } });   // its own seed, on its own rows, answered with its own pins only
        expect(seen).toEqual([FA, FB]);
        expect(stored(s, FA)).toEqual({ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } } });
        expect(stored(s, FB)).toEqual({ pins: { [D1]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } } });
        // A file whose rows pin nothing is recorded too, as `{ pins: {} }`.
        rows.empty = [];
        await book.read(ME, 'empty');
        expect(stored(s, 'empty')).toEqual({ pins: {} });
        // A new run: both files are in the record, so neither is seeded again; nothing is written by asking.
        book.forget();
        writes.length = 0;
        await book.read(ME, FA);
        await book.read(ME, FB);
        await book.read(ME, 'empty');
        expect({ seen, writes }).toEqual({ seen: [FA, FB, 'empty'], writes: [] });
    });

    it('a seed whose write is refused records nothing: the ask throws, the next ask seeds the file again from its rows; a seed that throws writes nothing; a handle with no file is refused', async () => {
        const s = memory();
        let refuse = 1;
        let fail = false;
        const seen: string[] = [];
        const book = createDmPinBook<string>({ getItem: s.getItem, setItem: async (k, v) => { if (refuse-- > 0) throw new Error('disk full'); await s.setItem(k, v); } }, (f) => (f === 'none' ? undefined : f), async (_me, _at, file) => {
            seen.push(file);
            if (fail) throw new Error('rows unreadable');
            return (pins) => pinAtFirstSight(pins, D0, BEN, NOW, undefined, true);
        });
        await expect(book.read(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        expect(s.data.has(dmPeerPinsStoreKey(ME, FA))).toBe(false);
        expect(dmPinFor(await book.read(ME, FA), D0)).toMatchObject({ peer: BEN, checked: true });
        expect(seen).toEqual([FA, FA]);
        expect(stored(s, FA)).toEqual({ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } } });
        fail = true;
        await expect(book.update(ME, FB, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(stored(s, FB)).toBeNull();
        expect(stored(s, FA)).toEqual({ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } } });
        await expect(book.read(ME, 'none')).rejects.toBeInstanceOf(DmPinStoreError);
    });
});

describe('first sight judged on the thread (§3.4 amendment): judgeFirstSight, applySightVerdict, the rule-5 record', () => {
    const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    const L = PUPPET;
    it('rules 1-5 as the amendment states them: the oldest opening line\'s key is the pin, the listing only offers', () => {
        expect(judgeFirstSight([], L)).toEqual({ rule: 1 });
        expect(judgeFirstSight([L, L], L)).toEqual({ rule: 2, pin: L, offer: false });
        expect(judgeFirstSight([BEN, BEN], L)).toEqual({ rule: 3, pin: BEN, offer: true });
        expect(judgeFirstSight([BEN, BEN, L], L)).toEqual({ rule: 4, pin: BEN, offer: true });
        for (const lines of [[BEN, OTHER], [BEN, L, OTHER], [BEN, null, L], [null, null], [L, BEN], [BEN, L, BEN], [null]]) {
            expect(judgeFirstSight(lines, L)).toEqual({ rule: 5 });
        }
        expect(judgeFirstSight([BEN, L], null)).toEqual({ rule: 5 });
    });

    it('rule 5 keeps no pin, only a record; neither the listing nor rule 1 or 2 ever pins over it; rule 3 or 4 replaces it with a pause', () => {
        const p: DmPeerPins = {};
        expect(applySightVerdict(p, D0, { rule: 5 }, L, undefined, NOW)).toBe(true);
        expect(dmPinFor(p, D0)).toBeNull();
        expect(dmSightFor(p, D0)).toEqual({ unplaced: true, since: NOW, listed: L });
        expect(pinAtFirstSight(p, D0, L, NOW)).toBe(false);
        expect(applyDmListings(p, D0, [[L]], NOW)).toBe(false);
        expect(applySightVerdict(p, D0, { rule: 1 }, L, undefined, NOW)).toBe(false);
        expect(applySightVerdict(p, D0, { rule: 2, pin: L, offer: false }, L, undefined, NOW)).toBe(false);
        expect(dmPinFor(p, D0)).toBeNull();
        // The listing names other keys to try: the record is judged again, and only a pause can come of it.
        expect(applyDmListings(p, D0, [[L]], NOW, { tryKeys: [BEN] })).toBe(true);
        expect(dmSightFor(p, D0)).toMatchObject({ unplaced: true, stale: true, heard: { tryKeys: [BEN] } });
        expect(applySightVerdict(p, D0, { rule: 2, pin: L, offer: false }, L, { tryKeys: [BEN] }, NOW)).toBe(true);
        expect(dmPinFor(p, D0)).toBeNull();
        expect(dmSightFor(p, D0)).not.toHaveProperty('stale');
        applyDmListings(p, D0, [[L]], NOW, { tryKeys: [BEN], rekeyedAt: NOW });
        expect(applySightVerdict(p, D0, { rule: 4, pin: BEN, offer: true }, L, { tryKeys: [BEN], rekeyedAt: NOW }, NOW)).toBe(true);
        expect(dmPinFor(p, D0)).toEqual({ peer: BEN, since: NOW, by: 'first-seen', checked: true, offered: { peer: L, at: NOW, firstSight: true, nodeSays: { rekeyedAt: NOW } } });
    });

    it('a checked pin or one the member chose is never judged again; an unchecked one is, and a send settles it', () => {
        const p: DmPeerPins = {};
        pinAtFirstSight(p, D0, L, NOW);
        expect(dmPinFor(p, D0)?.checked).toBeUndefined();
        expect(applySightVerdict(p, D0, { rule: 1 }, L, undefined, NOW)).toBe(false);
        expect(settleFirstSight(p, D0)).toBe(true);
        expect(dmPinFor(p, D0)?.checked).toBe(true);
        expect(applySightVerdict(p, D0, { rule: 3, pin: BEN, offer: true }, L, undefined, NOW)).toBe(false);
        expect(dmPinFor(p, D0)?.peer).toBe(L);
        const q: DmPeerPins = { [D0]: { peer: BEN, since: NOW, by: 'member' } };
        expect(applySightVerdict(q, D0, { rule: 3, pin: OTHER, offer: true }, L, undefined, NOW)).toBe(false);
        // An offer stops a settle: nothing is sealed while one waits.
        const r: DmPeerPins = {};
        pinAtFirstSight(r, D0, BEN, NOW);
        applyDmListings(r, D0, [[L]], NOW);
        expect(settleFirstSight(r, D0)).toBe(false);
    });

    it('the stored record survives a read: checked, heard and the rule-5 record come back as written; a stray field is dropped', async () => {
        const s = memory();
        const p: DmPeerPins = {};
        pinAtFirstSight(p, D0, BEN, NOW, { tryKeys: [OTHER], rekeyedAt: NOW }, true);
        applySightVerdict(p, D1, { rule: 5 }, L, { tryKeys: [BEN] }, NOW);
        await writeDmPeerPins(s, ME, FA, p);
        const back = await readDmPeerPins(s, ME, FA);
        expect(dmSightFor(back, D0)).toEqual({ peer: BEN, since: NOW, by: 'first-seen', checked: true, heard: { tryKeys: [OTHER], rekeyedAt: NOW } });
        expect(dmSightFor(back, D1)).toEqual({ unplaced: true, since: NOW, listed: L, heard: { tryKeys: [BEN] } });
    });
});

describe('the caps: a node can\'t make the phone keep unbounded pins (§3.4 amendment 6)', () => {
    const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    const D2 = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

    it('an id over 64 characters after folding gets no entry of any kind (no pin, no judgement, no mark); one of 64 does', () => {
        const p: DmPeerPins = {};
        const long = 'a'.repeat(65);
        expect(pinAtFirstSight(p, long, BEN, NOW)).toBe(false);
        expect(applyDmListings(p, long, [[BEN]], NOW)).toBe(false);
        expect(applySightVerdict(p, long, { rule: 2, pin: BEN, offer: false }, BEN, undefined, NOW)).toBe(false);
        expect(applySightVerdict(p, long, { rule: 5 }, BEN, undefined, NOW)).toBe(false);
        expect(markHeldLost(p, [long, long.toUpperCase()], NOW)).toBe(false);
        expect(Object.keys(p)).toEqual([]);
        const ok = 'B'.repeat(64);
        expect(pinAtFirstSight(p, ok, BEN, NOW)).toBe(true);
        expect(Object.keys(p)).toEqual(['b'.repeat(64)]);
    });

    it('a value of exactly 1 MiB as UTF-8 is written; one byte more is refused as full, nothing written', async () => {
        const frame = JSON.stringify({ pins: { [D0]: { peer: BEN, since: '', by: 'first-seen' } } }).length;
        const at = (bytes: number) => ({ [D0]: { peer: BEN, since: 'é'.repeat(8) + 'a'.repeat(bytes - frame - 16), by: 'first-seen' } }) as DmPeerPins;
        const s = memory();
        await writeDmPeerPins(s, ME, FA, at(DM_PINS_MAX_BYTES));
        expect(Buffer.byteLength(s.data.get(dmPeerPinsStoreKey(ME, FA))!)).toBe(DM_PINS_MAX_BYTES);
        const t = memory();
        await expect(writeDmPeerPins(t, ME, FA, at(DM_PINS_MAX_BYTES + 1))).rejects.toBeInstanceOf(DmPinsFullError);
        expect(t.data.size).toBe(0);
    });

    it('in a book: a new first-sight pin is added only while the value stays within the cap, a change to a kept pin always applies, and a write still over the cap is refused (DmPinsFullError): the copy dropped and read again', async () => {
        const frame = JSON.stringify({ pins: { [D0]: { peer: BEN, since: '', by: 'first-seen' } } }).length;
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: record({ [D0]: { peer: BEN, since: 'a'.repeat(DM_PINS_MAX_BYTES - 150 - frame), by: 'first-seen' } }) });
        const writes: string[] = [];
        const book = createDmPinBook<string>({ ...s, setItem: async (k, v) => { writes.push(v); await s.setItem(k, v); } }, (f) => f);
        expect(Buffer.byteLength(s.data.get(dmPeerPinsStoreKey(ME, FA))!)).toBe(DM_PINS_MAX_BYTES - 150);
        // A first-sight pin under a UUID takes 168 bytes with its comma: no room. Refused, nothing written.
        expect(noRoomForFirstSight(await book.read(ME, FA), D1)).toBe(true);
        expect(await book.update(ME, FA, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).toBe(false);
        expect(await book.update(ME, FA, (p) => applyDmListings(p, D1, [[PUPPET]], NOW))).toBe(false);
        expect(await book.update(ME, FA, (p) => applySightVerdict(p, D1, { rule: 1 }, PUPPET, undefined, NOW))).toBe(false);
        expect(writes).toEqual([]);
        // An offer on the kept pin (118 bytes) always applies.
        expect(await book.update(ME, FA, (p) => applyDmListings(p, D0, [[PUPPET]], NOW))).toBe(true);
        expect(Buffer.byteLength(writes[0])).toBe(DM_PINS_MAX_BYTES - 32);
        // A judgement on a DM with nothing kept is a replacement too: it applies, and the write is over: refused whole.
        await expect(book.update(ME, FA, (p) => applySightVerdict(p, D2, { rule: 3, pin: BEN, offer: true }, PUPPET, undefined, NOW))).rejects.toBeInstanceOf(DmPinsFullError);
        expect(writes).toHaveLength(1);
        const again = await book.read(ME, FA);
        expect(dmSightFor(again, D2)).toBeNull();
        expect(dmPinFor(again, D0)?.offered?.peer).toBe(PUPPET);
    });

    it('a re-key date is kept as the instant it parses to, 24 characters, never the node\'s string; one that doesn\'t parse, not at all; former keys read back the newest 4', async () => {
        expect(rekeyDateOf('2026-10-03T00:00:00.000Z')).toBe('2026-10-03T00:00:00.000Z');
        expect(rekeyDateOf(`Thu Oct 01 2026 00:00:00 GMT+0000 (${'x'.repeat(100_000)})`)).toBe('2026-10-01T00:00:00.000Z');
        for (const bad of ['', 'soon', 'x'.repeat(100_000), 7, null]) expect(rekeyDateOf(bad)).toBeUndefined();
        const formers = [OTHER, PUPPET, 'ee'.repeat(32), 'ff'.repeat(32), '11'.repeat(32), '22'.repeat(32)];
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: record({
            [D0]: { peer: BEN, since: NOW, by: 'member', former: formers, offered: { peer: PUPPET, at: NOW, nodeSays: { rekeyedAt: `Thu Oct 01 2026 00:00:00 GMT+0000 (${'x'.repeat(1000)})` } } },
            [D1]: { unplaced: true, since: NOW, listed: PUPPET, heard: { tryKeys: Array.from({ length: 20 }, (_, i) => String(i).padStart(2, '0').repeat(32)), rekeyedAt: 'not a date' } },
        }) });
        const back = await readDmPeerPins(s, ME, FA);
        expect(dmPinFor(back, D0)).toEqual({ peer: BEN, since: NOW, by: 'member', former: formers.slice(0, FORMER_MAX), offered: { peer: PUPPET, at: NOW, nodeSays: { rekeyedAt: '2026-10-01T00:00:00.000Z' } } });
        expect(FORMER_MAX).toBe(4);
        expect(dmSightFor(back, D1)).toEqual({ unplaced: true, since: NOW, listed: PUPPET, heard: { tryKeys: Array.from({ length: 8 }, (_, i) => String(i).padStart(2, '0').repeat(32)) } });
    });

    it('the member\'s reset of one file: the raw value is set aside (the newest kept) and replaced by the reset\'s marker, the copy forgotten, and the next ask seeds the file again, handed the marker\'s date, whose one pin write replaces it; another file is untouched; a value storage can\'t return is removed with nothing set aside and the marker written; a marker is never set aside (§3.4 amendment 7 §2)', async () => {
        const s = memory({
            [dmPeerPinsStoreKey(ME, FA)]: '{not json',
            [dmPeerPinsStoreKey(ME, FB)]: record({ [D1]: { peer: BEN, since: NOW, by: 'first-seen' } }),
            [dmPeerPinsSetAsideStoreKey(ME, FA)]: 'an older one',
        });
        let seeds = 0;
        const handed: Array<string | undefined> = [];
        const book = createDmPinBook<string>(s, (f) => f, async (_me, _at, _file, reset) => { seeds++; handed.push(reset); return (p) => pinAtFirstSight(p, D0, BEN, NOW, undefined, true); });
        const marker = (key: string) => { const v = JSON.parse(s.data.get(key)!); expect(Object.keys(v)).toEqual(['reset']); expect(v.reset).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); return v.reset as string; };
        await expect(book.read(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        await expect(book.read(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);   // never reset by the phone on its own
        expect(seeds).toBe(0);
        expect(await book.reset(ME, FA)).toBe('set-aside');
        expect(s.data.get(dmPeerPinsSetAsideStoreKey(ME, FA))).toBe('{not json');
        const date = marker(dmPeerPinsStoreKey(ME, FA));
        expect(dmPinFor(await book.read(ME, FA), D0)).toMatchObject({ peer: BEN, checked: true });
        expect(seeds).toBe(1);
        expect(handed).toEqual([date]);
        // The seed's one pin write replaced the marker: pins, and no `reset`.
        expect(Object.keys(JSON.parse(s.data.get(dmPeerPinsStoreKey(ME, FA))!))).toEqual(['pins']);
        expect(s.data.get(dmPeerPinsStoreKey(ME, FB))).toBe(record({ [D1]: { peer: BEN, since: NOW, by: 'first-seen' } }));
        // A readable value is set aside as it was, too, and the copy in memory is forgotten.
        const before = s.data.get(dmPeerPinsStoreKey(ME, FA));
        expect(await book.reset(ME, FA)).toBe('set-aside');
        expect(s.data.get(dmPeerPinsSetAsideStoreKey(ME, FA))).toBe(before);
        marker(dmPeerPinsStoreKey(ME, FA));
        // Reset again before a seed: the marker isn't set aside over the copy kept, and is written again.
        expect(await book.reset(ME, FA)).toBe('nothing-stored');
        expect(s.data.get(dmPeerPinsSetAsideStoreKey(ME, FA))).toBe(before);
        marker(dmPeerPinsStoreKey(ME, FA));
        // Nothing stored at all (a file never seeded): the marker is written, so its seed judges too.
        s.data.delete(dmPeerPinsStoreKey(ME, FB));
        expect(await book.reset(ME, FB)).toBe('nothing-stored');
        marker(dmPeerPinsStoreKey(ME, FB));
        // Storage can't return it (a value past the read window): removed, nothing set aside.
        const t = memory({ [dmPeerPinsStoreKey(ME, FA)]: 'x' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const throwing = createDmPinBook<string>({ ...t, getItem: async () => { throw new Error('Row too big to fit into CursorWindow'); } }, (f) => f);
        try {
            expect(await throwing.reset(ME, FA)).toBe('unreadable-removed');
            expect(warn).toHaveBeenCalled();
        } finally { warn.mockRestore(); }
        expect([...t.data.keys()]).toEqual([dmPeerPinsStoreKey(ME, FA)]);
        expect(Object.keys(JSON.parse(t.data.get(dmPeerPinsStoreKey(ME, FA))!))).toEqual(['reset']);
    });

    it('the reset\'s marker as read (§3.4 amendment 7 §2): no pins and \'reset\' a 24-character date reads as unseeded (no pins); any other value with no pins is unreadable; a pin write that fails leaves the marker, and the next ask is handed it again; a marker that can\'t be written fails the reset, and this run\'s seed still judges', async () => {
        const date = '2026-10-14T09:00:00.000Z';
        expect(await readDmPeerPins(memory({ [dmPeerPinsStoreKey(ME, FA)]: JSON.stringify({ reset: date }) }), ME, FA)).toEqual({});
        for (const raw of [JSON.stringify({ reset: 'soon' }), JSON.stringify({ reset: 'Thu Oct 01 2026' }), JSON.stringify({ reset: 7 }), '{}', JSON.stringify({ reset: date, pins: [] })]) {
            await expect(readDmPeerPins(memory({ [dmPeerPinsStoreKey(ME, FA)]: raw }), ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        }
        // The seed's pin write throws once: the marker stays, and the next ask is handed it again.
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: JSON.stringify({ reset: date }) });
        let fail = 1;
        const handed: Array<string | undefined> = [];
        const flaky = { ...s, setItem: async (k: string, v: string) => { if (fail-- > 0) throw new Error('disk full'); return s.setItem(k, v); } };
        const book = createDmPinBook<string>(flaky, (f) => f, async (_me, _at, _file, reset) => { handed.push(reset); return (p) => pinAtFirstSight(p, D0, BEN, NOW); });
        await expect(book.read(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        expect(s.data.get(dmPeerPinsStoreKey(ME, FA))).toBe(JSON.stringify({ reset: date }));
        expect(dmPinFor(await book.read(ME, FA), D0)).toMatchObject({ peer: BEN });
        expect(handed).toEqual([date, date]);
        expect(Object.keys(JSON.parse(s.data.get(dmPeerPinsStoreKey(ME, FA))!))).toEqual(['pins']);
        // A value storage can't return, removed, and then the marker can't be written: the reset throws, the value is gone,
        // and this run's seed of that file is still handed a date (never the update's trust).
        const t = memory({ [dmPeerPinsStoreKey(ME, FA)]: 'x'.repeat(10) });
        let refuse = true;
        const handedT: Array<string | undefined> = [];
        const tb = createDmPinBook<string>({
            ...t,
            getItem: async (k: string) => { if (refuse && k === dmPeerPinsStoreKey(ME, FA)) throw new Error('Row too big to fit into CursorWindow'); return t.getItem(k); },
            setItem: async (k: string, v: string) => { if (refuse && k === dmPeerPinsStoreKey(ME, FA)) throw new Error('disk full'); return t.setItem(k, v); },
        }, (f) => f, async (_me, _at, _file, reset) => { handedT.push(reset); return () => false; });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try { await expect(tb.reset(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError); } finally { warn.mockRestore(); }
        expect(t.data.has(dmPeerPinsStoreKey(ME, FA))).toBe(false);
        refuse = false;
        await tb.read(ME, FA);
        expect(handedT).toHaveLength(1);
        expect(handedT[0]).toMatch(/^\d{4}-\d\d-\d\dT/);
    });
});

// #1938 case 14, Q2 (ii) (adopted): a stored value the member's reset can't read as pins still names the DMs it pinned. The
// reset hands the guard list the ids salvaged from it (each JSON string literal standing as an object key, parsed so a
// damaged one costs only itself, lower-cased, at most 64 characters, never one of the format's own member names), where
// it handed nothing before; a value storage can't return still hands null (the stated residual).
describe('salvagePinIds and the reset\'s ids for the guard list (#1938 case 14 Q2 (ii))', () => {
    const [I1, I2, I3] = ['6F9619FF-8B86-D011-B42D-00C04FC964FF', '7c9e6679-7425-40de-944b-e07fc1f90ae7', '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'];
    /** Every shape the format writes: a checked pin with an offer and what the listing said, a member's pin, a first sight's record. */
    const honest = () => record({
        [I1]: { peer: BEN, since: NOW, by: 'first-seen', checked: true, former: [OTHER], offered: { peer: PUPPET, at: NOW, nodeSays: { rekeyedAt: NOW }, firstSight: true, afterReset: true }, heard: { tryKeys: [PUPPET], rekeyedAt: NOW } },
        [I2]: { peer: BEN, since: NOW, by: 'member' },
        [I3]: { unplaced: true, since: NOW, listed: PUPPET, heard: { tryKeys: [BEN] }, stale: true, heldLost: true },
    });

    it('a value whose tail is cut: every id, lower-cased, in order; never a format name, never a key or a date from a value', () => {
        const raw = honest();
        expect(salvagePinIds(raw)).toEqual([I1.toLowerCase(), I2, I3]);
        expect(salvagePinIds(raw.slice(0, -5))).toEqual([I1.toLowerCase(), I2, I3]);
    });

    it('the middle entry\'s id damaged (a raw control character, a bad escape): it alone is lost, the ids around it kept', () => {
        for (const bad of [`${I2.slice(0, 8)}\u0001${I2.slice(8)}`, `${I2.slice(0, 8)}\\q${I2.slice(8)}`]) {
            const raw = honest().replace(I2, bad).slice(0, -2);
            expect(salvagePinIds(raw)).toEqual([I1.toLowerCase(), I3]);
        }
    });

    it('junk adds no id: no pins, a value with no key left, keys only the format names, a key over 64 characters, a reset marker', () => {
        expect(salvagePinIds('{"pins":{}}')).toEqual([]);
        expect(salvagePinIds('{"pins": {corrupt')).toEqual([]);
        expect(salvagePinIds('{"garbage')).toEqual([]);
        expect(salvagePinIds(JSON.stringify({ reset: NOW }))).toEqual([]);
        expect(salvagePinIds('{"pins":{"x":{"peer":"' + BEN + '","since":"' + NOW + '","by":"member","checked":true,"former":[],"offered":{"peer":null,"at":"","nodeSays":{"rekeyedAt":""},"firstSight":true,"afterReset":true},"heard":{"tryKeys":[],"rekeyedAt":""},"unplaced":true,"listed":null,"stale":true,"heldLost":true')).toEqual(['x']);
        const long = 'e'.repeat(65);
        expect(salvagePinIds(`{"pins":{"${'g'.repeat(64)}":{},"${long}":{},"${I2}":{`)).toEqual(['g'.repeat(64), I2]);
        // A value is never a key: a peer's key, a date, a string with a colon in it.
        expect(salvagePinIds(`{"pins":{"${I2}":{"peer":"${BEN}","since":"a:b","by":"x:"`)).toEqual([I2]);
    });

    // #1938 confirmation 10, finding 2: one changed byte in `former` or `heard.tryKeys` (`,` or `]` turned into `:`) made
    // `,"<64-hex>":` read as a key, and the list then refused that key's enterprise for good. Hardening (a): a key counts
    // only when its value opens an object, as every pins entry's does; (b): a 64-hex key (a member's key) is never an id.
    it('one changed byte in former or heard.tryKeys salvages no key: (a) no object follows it, (b) it is key-shaped', () => {
        const [K1, K2, K3] = ['1a'.repeat(32), '2b'.repeat(32), '3C'.repeat(32)];
        const raw = record({
            [I1]: { peer: BEN, since: NOW, by: 'first-seen', checked: true, former: [K1, K2, K3] },
            [I2]: { unplaced: true, since: NOW, listed: PUPPET, heard: { tryKeys: [K1, K2, K3] } },
        });
        const damaged = [
            raw.replace(`"${K2}",`, `"${K2}":`),                       // an array separator turned into `:`
            raw.replace(`"${K3}"]`, `"${K3}":`),                       // an array's `]` turned into `:`
            raw.replace(`"${K3}"]`, `"${K3}":`).replace(`"${K2}",`, `"${K2}":`),
        ];
        for (const v of damaged) {
            expect(() => JSON.parse(v)).toThrow();
            const got = salvagePinIds(v);
            for (const k of [K1, K2, K3]) expect(got).not.toContain(k.toLowerCase());
            expect(got).toEqual([I1.toLowerCase(), I2]);
        }
        // (a) alone: a value-key with an object after it would still be a key-shaped id, and (b) refuses it.
        expect(salvagePinIds(`{"pins":{"${K1}":{"peer":"${BEN}"},"${I2}":{`)).toEqual([I2]);
        // (b) alone: a non-hex key with no object after it is refused by (a).
        expect(salvagePinIds(`{"pins":{"${I3}":"x","${I2}":{`)).toEqual([I2]);
    });

    it('nine adversarial values of 1-2 MiB: each salvaged quickly (measured, logged)', () => {
        const MiB = 1024 * 1024;
        const values = [
            '{"' + 'a'.repeat(2 * MiB),
            '{' + '"x":'.repeat(MiB / 4),
            '{' + '",'.repeat(MiB / 2),
            '{"' + '\\"'.repeat(MiB / 2),
            '{' + '"a",'.repeat(MiB / 4),
            ',"'.repeat(MiB / 2) + ':',
            '{"pins":{' + Array.from({ length: 28_000 }, (_, i) => `"${i.toString(16).padStart(36, '0')}":{"peer":"${BEN}"},`).join(''),
            '{' + ' '.repeat(2 * MiB) + '"x"',
            '{"' + '\\u12'.repeat(MiB / 3),
        ];
        const took = values.map((v) => { const t = performance.now(); salvagePinIds(v); return Math.round(performance.now() - t); });
        console.log(`salvagePinIds adversarial ms: ${JSON.stringify(took)}`);
        for (const ms of took) expect(ms).toBeLessThan(1000);
    });

    it('the reset hands the guard list: a corrupt value\'s salvage; a readable value\'s pins; a marker nothing; a value storage can\'t return null', async () => {
        const handedFor = async (s: ReturnType<typeof memory> | Parameters<typeof createDmPinBook>[0]) => {
            const handed: Array<string[] | null> = [];
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            try { await createDmPinBook<string>(s, (f) => f).reset(ME, FA, async (ids) => { handed.push(ids); }); } finally { warn.mockRestore(); }
            return handed;
        };
        expect(await handedFor(memory({ [dmPeerPinsStoreKey(ME, FA)]: honest().slice(0, -5) }))).toEqual([[I1.toLowerCase(), I2, I3]]);
        expect(await handedFor(memory({ [dmPeerPinsStoreKey(ME, FA)]: honest() }))).toEqual([[I1.toLowerCase(), I2, I3]]);
        expect(await handedFor(memory({ [dmPeerPinsStoreKey(ME, FA)]: JSON.stringify({ reset: NOW }) }))).toEqual([[]]);
        expect(await handedFor(memory())).toEqual([[]]);
        const t = memory({ [dmPeerPinsStoreKey(ME, FA)]: honest() });
        expect(await handedFor({ ...t, getItem: async () => { throw new Error('Row too big to fit into CursorWindow'); } })).toEqual([null]);
        // The value is read once: what is set aside is the value the ids came from.
        const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: honest().slice(0, -5) });
        let reads = 0;
        await handedFor({ ...s, getItem: async (k: string) => { reads++; return s.getItem(k); } });
        expect(reads).toBe(1);
        expect(s.data.get(dmPeerPinsSetAsideStoreKey(ME, FA))).toBe(honest().slice(0, -5));
    });

    // #1938 confirmation 10, finding 3 (mutant P7: the reset ignoring the copy held in memory when storage can't give the
    // value): the pins were read earlier this run, then storage throws, or returns a corrupt value, at the tap. The guard
    // list is handed the copy's ids, never null (the throw's residual) or the corrupt value's salvage ([]).
    for (const how of ['storage throws at the tap', 'storage returns a corrupt value at the tap'] as const) {
        it(`a copy of the pins held (read earlier this run), then ${how}: the reset hands the list the copy's ids`, async () => {
            const s = memory({ [dmPeerPinsStoreKey(ME, FA)]: honest() });
            let bad = false;
            const storage = { ...s, getItem: async (k: string) => { if (bad && how.includes('throws')) throw new Error('Row too big to fit into CursorWindow'); return s.getItem(k); } };
            const book = createDmPinBook<string>(storage, (f) => f);
            const held = await book.read(ME, FA);
            expect(Object.keys(held)).toEqual([I1.toLowerCase(), I2, I3]);
            bad = true;
            if (how.includes('corrupt')) s.data.set(dmPeerPinsStoreKey(ME, FA), '{"pins": {corrupt');
            const handed: Array<string[] | null> = [];
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            try { await book.reset(ME, FA, async (ids) => { handed.push(ids); }); } finally { warn.mockRestore(); }
            expect(handed).toEqual([[I1.toLowerCase(), I2, I3]]);
        });
    }
});
