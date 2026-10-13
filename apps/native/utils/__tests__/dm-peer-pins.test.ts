import { describe, it, expect, vi } from 'vitest';
import { readDmPeerPins, writeDmPeerPins, applyDmListings, pinAtFirstSight, dmPinFor, dmSightFor, judgeFirstSight, applySightVerdict, settleFirstSight, dmOpenPeers, createDmPinBook, DmPinStoreError, DM_PIN_STORE_UNREAD_TEXT, type DmPeerPins, type DmPeerPin } from '../dm-peer-pins';
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

describe('createDmPinBook: one copy per account, one queue (#1872 review, findings 6 and 7)', () => {
    const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
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
    const stored = (s: { data: Map<string, string> }, who = ME) => JSON.parse(s.data.get(dmPeerPinsStoreKey(who)) ?? '{}');

    it('two first sights at once, each write held: both pins are kept, in storage and in memory', async () => {
        const s = slow();
        const book = createDmPinBook(s);
        const a = book.update(ME, (p) => pinAtFirstSight(p, D0, BEN, NOW));
        const b = book.update(ME, (p) => pinAtFirstSight(p, D1, PUPPET, NOW));
        await vi.waitFor(() => expect(s.held.length).toBe(1));
        s.held.shift()!();   // the first write lands only now; the second waits its turn behind it
        await vi.waitFor(() => expect(s.held.length).toBe(1));
        s.held.shift()!();
        expect(await Promise.all([a, b])).toEqual([true, true]);
        expect(Object.keys(stored(s)).sort()).toEqual([D0, D1].sort());
        expect(Object.keys(await book.read(ME)).sort()).toEqual([D0, D1].sort());
    });

    it('reads storage once for the app\'s run, however many ask at once, and a change that changes nothing writes nothing', async () => {
        const s = slow({ [dmPeerPinsStoreKey(ME)]: JSON.stringify({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }) });
        const book = createDmPinBook(s);
        const copies = await Promise.all([book.read(ME), book.read(ME), book.read(ME.toUpperCase())]);
        expect(new Set(copies).size).toBe(1);
        expect(await book.update(ME, (p) => pinAtFirstSight(p, D0, PUPPET, NOW))).toBe(false);
        expect(dmPinFor(await book.read(ME), D0)?.peer).toBe(BEN);
        expect({ reads: s.reads(), writes: s.held.length }).toEqual({ reads: 1, writes: 0 });
        await book.read(OTHER);   // another account: its own copy, read from its own key
        expect(s.reads()).toBe(2);
    });

    it('an unreadable store keeps nothing in memory: every ask refuses until it reads, and a change is never written over it', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME)]: '{not json' });
        const book = createDmPinBook(s);
        await expect(book.read(ME)).rejects.toBeInstanceOf(DmPinStoreError);
        await expect(book.update(ME, (p) => pinAtFirstSight(p, D0, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(s.data.get(dmPeerPinsStoreKey(ME))).toBe('{not json');
        s.data.set(dmPeerPinsStoreKey(ME), JSON.stringify({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }));
        expect(dmPinFor(await book.read(ME), D0)?.peer).toBe(BEN);
    });

    it('a write the storage refuses throws, drops the copy, and the next ask holds what storage holds; the queue goes on', async () => {
        const s = memory({ [dmPeerPinsStoreKey(ME)]: JSON.stringify({ [D0]: { peer: BEN, since: NOW, by: 'first-seen' } }) });
        let refuse = true;
        const book = createDmPinBook({ getItem: s.getItem, setItem: async (k, v) => { if (refuse) throw new Error('disk full'); await s.setItem(k, v); } });
        await expect(book.update(ME, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).rejects.toBeInstanceOf(DmPinStoreError);
        expect(dmPinFor(await book.read(ME), D1)).toBeNull();
        refuse = false;
        expect(await book.update(ME, (p) => pinAtFirstSight(p, D1, PUPPET, NOW))).toBe(true);
        expect(Object.keys(stored(s)).sort()).toEqual([D0, D1].sort());
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
        expect(dmPinFor(p, D0)).toEqual({ peer: BEN, since: NOW, by: 'first-seen', checked: true, offered: { peer: L, at: NOW, nodeSays: { rekeyedAt: NOW } } });
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

    it('the book says "fresh" only until its first write for the account', async () => {
        const s = memory();
        const book = createDmPinBook(s);
        const seen: boolean[] = [];
        await book.update(ME, (_p, { fresh }) => { seen.push(fresh); return false; });
        await book.update(ME, (_p, { fresh }) => { seen.push(fresh); return true; });
        await book.update(ME, (_p, { fresh }) => { seen.push(fresh); return false; });
        book.forget();
        await book.update(ME, (_p, { fresh }) => { seen.push(fresh); return false; });
        expect(seen).toEqual([true, true, false, false]);
    });
});
