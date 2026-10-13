import { describe, it, expect, vi } from 'vitest';
import { readDmPeerPins, writeDmPeerPins, applyDmListings, pinAtFirstSight, dmPinFor, dmSightFor, judgeFirstSight, applySightVerdict, settleFirstSight, dmOpenPeers, acceptOffer, createDmPinBook, DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT, type DmPeerPins, type DmPeerPin } from '../dm-peer-pins';
import { dmPeerPinsStoreKey } from '../storage-keys';

// The pin store itself (utils/dm-peer-pins.ts): what a listing may do to a pin, and what an unreadable store does. The
// phone's real sync and send over it are in dm-line-binding.test.ts.

const ME = 'aa'.repeat(32);
const BEN = 'bb'.repeat(32);
const PUPPET = 'cc'.repeat(32);
const OTHER = 'dd'.repeat(32);
const D0 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-10-14T00:00:00.000Z';

/** The stored value: one account's pins and the community files seeded (§3.4 amendment 5). */
const record = (pins: Record<string, unknown>, seeded: string[] = []) => JSON.stringify({ pins, seeded });

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
            [dmPeerPinsStoreKey(ME)]: record({ [D0.toUpperCase()]: { peer: BEN.toUpperCase(), since: NOW, by: 'first-seen' } }),
            [dmPeerPinsStoreKey(OTHER)]: record({ [D0]: { peer: PUPPET, since: NOW, by: 'first-seen' } }),
        });
        expect(dmPeerPinsStoreKey(ME.toUpperCase())).toBe(dmPeerPinsStoreKey(ME));
        expect(await readDmPeerPins(s, ME.toUpperCase())).toEqual({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } });
    });

    it('nothing stored is no pins; storage that throws, or holds something that isn\'t a pin object, is the store error', async () => {
        expect(await readDmPeerPins(memory(), ME)).toEqual({});
        const throwing = { getItem: async () => { throw new Error('io'); } };
        await expect(readDmPeerPins(throwing, ME)).rejects.toThrow(DM_PIN_STORE_UNREAD_TEXT);
        // Not the record (§3.4 amendment 5): no pins object, or no list of the files seeded.
        for (const raw of ['{not json', '[]', '"x"', 'null', '{}', JSON.stringify({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }), '{"pins":{}}', '{"pins":[],"seeded":[]}', '{"pins":{},"seeded":"a.db"}']) {
            await expect(readDmPeerPins(memory({ [dmPeerPinsStoreKey(ME)]: raw }), ME)).rejects.toBeInstanceOf(DmPinStoreError);
        }
    });

    it('passes over an entry that isn\'t a pin, and drops former keys that aren\'t keys', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME)]: record({
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
});

describe('createDmPinBook: one copy per account, one queue (#1872 review, findings 6 and 7), one seed per community file (§3.4 amendment 5)', () => {
    const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
    const FA = 'community_a.db';
    const FB = 'community_b.db';
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
    const stored = (s: { data: Map<string, string> }, who = ME) => JSON.parse(s.data.get(dmPeerPinsStoreKey(who)) ?? '{"pins":{},"seeded":[]}');

    it('two first sights at once, each write held: both pins are kept, in storage and in memory', async () => {
        const s = slow({ [dmPeerPinsStoreKey(ME)]: record({}, [FA]) });
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
        const s = slow({ [dmPeerPinsStoreKey(ME)]: record({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }, [FA]) });
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
        const s = memory({ [dmPeerPinsStoreKey(ME)]: '{not json' });
        let seeds = 0;
        const book = bookOf(s, async () => { seeds++; return () => false; });
        await expect(book.read(ME, FA)).rejects.toBeInstanceOf(DmPinStoreError);
        await expect(book.update(ME, FA, (p) => pinAtFirstSight(p, D0, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(s.data.get(dmPeerPinsStoreKey(ME))).toBe('{not json');
        expect(seeds).toBe(0);
        s.data.set(dmPeerPinsStoreKey(ME), record({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }, [FA]));
        expect(dmPinFor(await book.read(ME, FA), D0)?.peer).toBe(BEN);
        expect(seeds).toBe(0);
    });

    it('a write the storage refuses throws, drops the copy, and the next ask holds what storage holds; the queue goes on', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME)]: record({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }, [FA]) });
        let refuse = true;
        const book = bookOf({ getItem: s.getItem, setItem: async (k, v) => { if (refuse) throw new Error('disk full'); await s.setItem(k, v); } });
        await expect(book.update(ME, FA, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(dmPinFor(await book.read(ME, FA), D1)).toBeNull();
        refuse = false;
        expect(await book.update(ME, FA, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).toBe(true);
        expect(Object.keys(stored(s).pins).sort()).toEqual([D0, D1].sort());
        expect(stored(s).seeded).toEqual([FA]);
    });

    it('each file is seeded once, at the first ask with its handle and before it answers: the rows held then, the pins and the file\'s name in one write', async () => {
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
        expect(writes.map((w) => JSON.parse(w))).toEqual([{ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } }, seeded: [FA] }]);
        rows[FA].push([D1, PUPPET]);   // the node's rows, written in A after the seed: never seeded
        await book.read(ME, FA);
        await book.read(ME, FB);       // the other community's file: its own seed, on its own rows
        expect(seen).toEqual([FA, FB]);
        expect(stored(s)).toEqual({ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true }, [D1]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } }, seeded: [FA, FB] });
        // A new run: both files are in the record, so neither is seeded again; nothing is written by asking.
        book.forget();
        writes.length = 0;
        await book.read(ME, FA);
        await book.read(ME, FB);
        expect({ seen, writes }).toEqual({ seen: [FA, FB], writes: [] });
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
        expect(s.data.has(dmPeerPinsStoreKey(ME))).toBe(false);
        expect(dmPinFor(await book.read(ME, FA), D0)).toMatchObject({ peer: BEN, checked: true });
        expect(seen).toEqual([FA, FA]);
        expect(stored(s).seeded).toEqual([FA]);
        fail = true;
        await expect(book.update(ME, FB, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(stored(s)).toEqual({ pins: { [D0]: { peer: BEN, since: NOW, by: 'first-seen', checked: true } }, seeded: [FA] });
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
        await writeDmPeerPins(s, ME, p);
        const back = await readDmPeerPins(s, ME);
        expect(dmSightFor(back, D0)).toEqual({ peer: BEN, since: NOW, by: 'first-seen', checked: true, heard: { tryKeys: [OTHER], rekeyedAt: NOW } });
        expect(dmSightFor(back, D1)).toEqual({ unplaced: true, since: NOW, listed: L, heard: { tryKeys: [BEN] } });
    });
});
