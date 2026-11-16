/**
 * Signal's model for a DM's key change (DESIGN-dm-key-signal-model §6; Marty, 16 Nov: "yes change to signals model"): ONE table,
 * (verified? x the kind of change) -> (does the pin move? may a line be sent, and to which key? card, notice or nothing?), run
 * on the pure functions of utils/dm-peer-pins.ts. The invariant it closes (§2.1): a DM line leaves this phone sealed to the one
 * key the community lists for the other person; for a person the member marked verified, to the verified key or to nobody; no
 * single listed key = nothing sent.
 *
 * Every row runs against an `impl` (the real functions by default). The mutants at the end each break one rule of the model and
 * must fail their own row, so the table is shown able to fail where it matters. The rows marked † in the design also run through
 * the real sync, send and thread in dm-line-binding.test.ts ("Signal's model through the real sync").
 */
import { describe, it, expect } from 'vitest';
import {
    applyDmListings, applySightVerdict, acceptOffer, markVerified, removeVerified, restDmEntry, judgeFirstSight, dmSightFor, dmPinFor,
    dmOpenPeers, isUnplacedSight, isVerifiedPin, dmEntryRestless, dmEntryWaitsForMember, readDmPeerPins, writeDmPeerPins, pinsWithCarried,
    createDmPinBook, markHeldLost, applyResetVerdict, pinAtFirstSight, settleFirstSight, pinKeyOf,
    CHANGED_AT_MAX, FORMER_MAX, type DmPeerPins, type DmPeerPin, type DmHeard, type SightVerdict,
} from '../dm-peer-pins';
import { dmPeerPinsStoreKey } from '../storage-keys';

const ME = 'aa'.repeat(32);
const K1 = 'b1'.repeat(32);       // the pinned key (Ben)
const K2 = 'b2'.repeat(32);       // the newly listed key
const PUPPET = 'cc'.repeat(32);
const X = 'dd'.repeat(32);        // an older key a restored phone's lines open under
const D0 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-16T11:00:00.000Z';
const REKEYED = '2026-11-15T00:00:00.000Z';
const FA = 'community_a.db';

interface Impl {
    applyDmListings: typeof applyDmListings;
    applySightVerdict: typeof applySightVerdict;
    acceptOffer: typeof acceptOffer;
    markVerified: typeof markVerified;
    removeVerified: typeof removeVerified;
    restDmEntry: typeof restDmEntry;
    /** The store's read of what was written (pinOf): a round trip through JSON. */
    readBack: (pins: DmPeerPins) => Promise<DmPeerPins>;
}

function memory() {
    const data = new Map<string, string>();
    return { data, getItem: async (k: string) => data.get(k) ?? null, setItem: async (k: string, v: string) => { data.set(k, v); } };
}

const REAL: Impl = {
    applyDmListings, applySightVerdict, acceptOffer, markVerified, removeVerified, restDmEntry,
    readBack: async (pins) => { const s = memory(); await writeDmPeerPins(s, ME, FA, pins); return readDmPeerPins(s, ME, FA); },
};

/** A pin on K1 this phone already holds (checked: it sealed there), marked verified or not. */
function pinned(verified: boolean): DmPeerPins {
    return { [D0]: { peer: K1, since: NOW, by: 'first-seen', checked: true, ...(verified ? { verified: { peer: K1, at: NOW } } : {}) } };
}

/**
 * What a send does now (db.ts getDmKeyContext 'seal' + requireDmKeyContext): the resting rule first, then the key it seals to,
 * or why nothing goes. Returns the key, 'paused' (DmKeyChangedError), or 'refused' (DmNotLockedError: no pin).
 */
function send(impl: Impl, pins: DmPeerPins, now = LATER): string | 'paused' | 'refused' {
    impl.restDmEntry(pins, D0, now);
    const entry = dmSightFor(pins, D0);
    if (!entry || isUnplacedSight(entry)) return 'refused';
    return entry.offered ? 'paused' : entry.peer;
}

/** What the member sees: the card (the chat waits for them, the Inbox tag with it), and how many thread notices. */
function shows(pins: DmPeerPins): { card: boolean; notices: number; continueTo: string | null } {
    const entry = dmSightFor(pins, D0);
    const pin = dmPinFor(pins, D0);
    return { card: dmEntryWaitsForMember(entry), notices: pin?.changedAt?.length ?? 0, continueTo: pin?.offered?.peer ?? null };
}

const pinOf = (pins: DmPeerPins) => dmPinFor(pins, D0) as DmPeerPin;
const heardRekey: DmHeard = { tryKeys: [K1], rekeyedAt: REKEYED };

type Row = { id: string; run: (impl: Impl) => Promise<void> | void };

const ROWS: Row[] = [
    {
        id: 'T1 re-key with succession, NOT verified: the pin follows K2, K1 kept as former, one notice, the send goes to K2; no card',
        run: (impl) => {
            const p = pinned(false);
            expect(impl.applyDmListings(p, D0, [[K2]], LATER, heardRekey)).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true, former: [K1], changedAt: [LATER] });
            expect(send(impl, p)).toBe(K2);
            expect(shows(p)).toEqual({ card: false, notices: 1, continueTo: null });
            expect(dmOpenPeers(pinOf(p))).toEqual([K2, K1]);   // K1's old lines, photos and voice still open
        },
    },
    {
        id: 'T1 re-key with succession, VERIFIED: K2 only offered with the date, the send pauses, the card; tick + Continue moves to K2 and stays verified, one notice',
        run: (impl) => {
            const p = pinned(true);
            expect(impl.applyDmListings(p, D0, [[K2]], LATER, heardRekey)).toBe(true);
            expect(pinOf(p)).toMatchObject({ peer: K1, verified: { peer: K1 }, offered: { peer: K2, at: LATER, nodeSays: { rekeyedAt: REKEYED } } });
            expect(send(impl, p)).toBe('paused');
            expect(shows(p)).toEqual({ card: true, notices: 0, continueTo: K2 });
            const AFTER = '2026-11-16T12:00:00.000Z';
            expect(impl.acceptOffer(p, D0, K2, AFTER)).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K2, since: AFTER, by: 'member', former: [K1], changedAt: [AFTER], verified: { peer: K2, at: AFTER } });
            expect(isVerifiedPin(pinOf(p))).toBe(true);
            expect(send(impl, p)).toBe(K2);
            expect(shows(p)).toEqual({ card: false, notices: 1, continueTo: null });
        },
    },
    {
        id: 'T2 node-listed new key, no statement: as T1 in both halves, the verified card with no date line',
        run: (impl) => {
            const p = pinned(false);
            impl.applyDmListings(p, D0, [[K2]], LATER);
            expect(pinOf(p)).toMatchObject({ peer: K2, by: 'listing', former: [K1] });
            expect(send(impl, p)).toBe(K2);
            const v = pinned(true);
            impl.applyDmListings(v, D0, [[K2]], LATER);
            expect(pinOf(v).offered).toEqual({ peer: K2, at: LATER });
            expect(send(impl, v)).toBe('paused');
        },
    },
    {
        id: 'T3 several other keys without K1, or two listings of the chat that disagree: no move, nobody offered, refused, the "no single key" card; verified or not',
        run: (impl) => {
            for (const verified of [false, true]) {
                for (const listings of [[[K2, PUPPET]], [[K2], [PUPPET]]]) {
                    const p = pinned(verified);
                    expect(impl.applyDmListings(p, D0, listings, LATER)).toBe(true);
                    expect(pinOf(p).peer).toBe(K1);
                    expect(pinOf(p).offered).toEqual({ peer: null, at: LATER });
                    expect(send(impl, p)).toBe('paused');
                    expect(shows(p)).toEqual({ card: true, notices: 0, continueTo: null });
                    expect(isVerifiedPin(pinOf(p))).toBe(verified);
                }
            }
        },
    },
    {
        id: 'T4 the listing names K1 and extras: nothing changes, sealed to K1 (the extras can\'t read it); verified or not',
        run: (impl) => {
            for (const verified of [false, true]) {
                const p = pinned(verified);
                const before = JSON.stringify(p);
                expect(impl.applyDmListings(p, D0, [[K1, PUPPET]], LATER)).toBe(false);
                expect(JSON.stringify(p)).toBe(before);
                expect(send(impl, p)).toBe(K1);
                expect(shows(p)).toEqual({ card: false, notices: 0, continueTo: null });
            }
        },
    },
    {
        id: 'T5 K1 alone again after a pause (T3, or T1 verified): the offer cleared, sealed to K1, nothing shown; still verified',
        run: (impl) => {
            for (const [verified, first] of [[false, [[K2, PUPPET]]], [true, [[K2, PUPPET]]], [true, [[K2]]]] as const) {
                const p = pinned(verified);
                impl.applyDmListings(p, D0, first.map((l) => [...l]), LATER);
                expect(impl.applyDmListings(p, D0, [[K1]], LATER)).toBe(true);
                expect(pinOf(p).offered).toBeUndefined();
                expect(pinOf(p).peer).toBe(K1);
                expect(send(impl, p)).toBe(K1);
                expect(shows(p)).toEqual({ card: false, notices: 0, continueTo: null });
                expect(isVerifiedPin(pinOf(p))).toBe(verified);
            }
        },
    },
    {
        id: 'T6 first sight, no lines (rule 1) or every line under the listed key (rule 2): pin the listed key, the send goes, nothing shown',
        run: (impl) => {
            const r1: DmPeerPins = {};
            impl.applySightVerdict(r1, D0, judgeFirstSight([], K2), K2, undefined, NOW);
            expect(pinOf(r1)).toEqual({ peer: K2, since: NOW, by: 'first-seen' });
            const r2: DmPeerPins = {};
            impl.applySightVerdict(r2, D0, judgeFirstSight([K2, K2], K2), K2, undefined, NOW);
            expect(pinOf(r2)).toEqual({ peer: K2, since: NOW, by: 'first-seen', checked: true });
            for (const p of [r1, r2]) {
                expect(send(impl, p)).toBe(K2);
                expect(shows(p)).toEqual({ card: false, notices: 0, continueTo: null });
            }
        },
    },
    {
        id: 'T7 first sight, one other key X (rule 3) or X then the listed key (rule 4), one key listed: pin the listed key, X as former, one notice, the send goes; a verified pin is never judged',
        run: (impl) => {
            for (const lines of [[X, X], [X, K2]]) {
                const p: DmPeerPins = {};
                expect(impl.applySightVerdict(p, D0, judgeFirstSight(lines, K2), K2, heardRekey, NOW)).toBe(true);
                expect(pinOf(p)).toEqual({ peer: K2, since: NOW, by: 'listing', checked: true, former: [X], changedAt: [NOW] });
                expect(dmOpenPeers(pinOf(p))).toEqual([K2, X]);   // every line reads
                expect(send(impl, p)).toBe(K2);
                expect(shows(p)).toEqual({ card: false, notices: 1, continueTo: null });
            }
            // Verified: checked, so first sight never judges it again (a prune and relist can't).
            const v = pinned(true);
            const before = JSON.stringify(v);
            expect(impl.applySightVerdict(v, D0, judgeFirstSight([PUPPET, PUPPET], PUPPET), PUPPET, undefined, LATER)).toBe(false);
            expect(JSON.stringify(v)).toBe(before);
        },
    },
    {
        id: 'T8 rule 3 with no single key listed: pin X, a keyless pause, refused, the "no single key" card',
        run: (impl) => {
            const p: DmPeerPins = {};
            impl.applySightVerdict(p, D0, judgeFirstSight([X], null), null, undefined, NOW);
            expect(pinOf(p)).toMatchObject({ peer: X, checked: true, offered: { peer: null } });
            expect(send(impl, p)).toBe('paused');
            expect(shows(p)).toEqual({ card: true, notices: 0, continueTo: null });
        },
    },
    {
        id: 'T9 rule 5 (no key places the lines), one key listed (a restored phone with only old lines of a never-re-keyed person): pin it, no former, no notice, no card; the send goes',
        run: (impl) => {
            const p: DmPeerPins = {};
            expect(impl.applySightVerdict(p, D0, judgeFirstSight([null, null], K1), K1, undefined, NOW)).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K1, since: NOW, by: 'listing', checked: true });
            expect(send(impl, p)).toBe(K1);
            expect(shows(p)).toEqual({ card: false, notices: 0, continueTo: null });
        },
    },
    {
        id: 'T10 rule 5 with no single key listed: a record, no pin, refused, the card',
        run: (impl) => {
            const p: DmPeerPins = {};
            impl.applySightVerdict(p, D0, judgeFirstSight([null], null), null, undefined, NOW);
            expect(dmSightFor(p, D0)).toEqual({ unplaced: true, since: NOW, listed: null });
            expect(send(impl, p)).toBe('refused');
            expect(shows(p)).toEqual({ card: true, notices: 0, continueTo: null });
        },
    },
    {
        id: 'T11 a kept rule-5 record or heldLost mark, then a listing names one key: it becomes a pin on it, the send goes, nothing shown',
        run: (impl) => {
            const record: DmPeerPins = {};
            impl.applySightVerdict(record, D0, judgeFirstSight([null], null), null, undefined, NOW);
            const lost: DmPeerPins = {};
            markHeldLost(lost, [D0], NOW);
            for (const p of [record, lost]) {
                expect(impl.applyDmListings(p, D0, [[K2]], LATER)).toBe(true);
                expect(pinOf(p)).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true });
                expect(send(impl, p)).toBe(K2);
                expect(shows(p)).toEqual({ card: false, notices: 0, continueTo: null });
            }
        },
    },
    {
        id: 'T12 Remove verification: no pause, only the mark goes; during T1\'s pause the mark goes AND the pin moves to K2 in the same change, one notice; during T3\'s, still paused',
        run: (impl) => {
            const calm = pinned(true);
            expect(impl.removeVerified(calm, D0, LATER)).toBe(true);
            expect(pinOf(calm)).toEqual({ peer: K1, since: NOW, by: 'first-seen', checked: true });
            const t1 = pinned(true);
            impl.applyDmListings(t1, D0, [[K2]], LATER);
            const AFTER = '2026-11-16T12:00:00.000Z';
            expect(impl.removeVerified(t1, D0, AFTER)).toBe(true);
            expect(pinOf(t1)).toEqual({ peer: K2, since: AFTER, by: 'listing', checked: true, former: [K1], changedAt: [AFTER] });
            expect(shows(t1)).toEqual({ card: false, notices: 1, continueTo: null });
            const t3 = pinned(true);
            impl.applyDmListings(t3, D0, [[K2, PUPPET]], LATER);
            expect(impl.removeVerified(t3, D0, AFTER)).toBe(true);
            expect(pinOf(t3)).toMatchObject({ peer: K1, offered: { peer: null } });
            expect(pinOf(t3).verified).toBeUndefined();
            expect(send(impl, t3)).toBe('paused');
            expect(impl.removeVerified(pinned(false), D0, AFTER)).toBe(false);
        },
    },
    {
        id: 'T13 Mark as verified: the key whose code was shown, checked; refused when the pin moved since, or while an offer is held',
        run: (impl) => {
            const p: DmPeerPins = { [D0]: { peer: K1, since: NOW, by: 'first-seen' } };
            expect(impl.markVerified(p, D0, K1, LATER)).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K1, since: NOW, by: 'first-seen', checked: true, verified: { peer: K1, at: LATER } });
            // The screen showed K1's code; a sync moved the pin to PUPPET before the tap: nothing written.
            const moved = pinned(false);
            impl.applyDmListings(moved, D0, [[PUPPET]], LATER);
            const before = JSON.stringify(moved);
            expect(impl.markVerified(moved, D0, K1, LATER)).toBe(false);
            expect(JSON.stringify(moved)).toBe(before);
            // An offer held (no single key listed): nothing to mark until it clears.
            const held = pinned(false);
            impl.applyDmListings(held, D0, [[K2, PUPPET]], LATER);
            expect(impl.markVerified(held, D0, K1, LATER)).toBe(false);
            expect(pinOf(held).verified).toBeUndefined();
            expect(impl.markVerified({}, D0, K1, LATER)).toBe(false);
        },
    },
    {
        id: 'T14 a stored pin holding a one-key offer with no mark (an older build\'s pause), no sync yet: the first check or send moves it, as T2; the Inbox shows no tag for it',
        run: (impl) => {
            const p: DmPeerPins = { [D0]: { peer: K1, since: NOW, by: 'member', offered: { peer: K2, at: NOW, firstSight: true } } };
            expect(dmEntryRestless(dmSightFor(p, D0))).toBe(true);
            expect(shows(p).card).toBe(false);
            expect(send(impl, p)).toBe(K2);
            expect(pinOf(p)).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true, former: [K1], changedAt: [LATER] });
            expect(impl.restDmEntry(p, D0, LATER)).toBe(false);   // at rest: a second call writes nothing
        },
    },
    {
        id: 'T15 a flap K1→K2→K1→K2→K1→K2: not verified, every pass moves, former ≤ 4 with no repeats, changedAt ≤ 4; verified, the pin never moves and the offer is set and cleared',
        run: (impl) => {
            const p = pinned(false);
            const times = Array.from({ length: 6 }, (_, i) => `2026-11-16T1${i}:30:00.000Z`);
            const keys = [K2, K1, K2, K1, K2, PUPPET];
            keys.forEach((k, i) => expect(impl.applyDmListings(p, D0, [[k]], times[i])).toBe(true));
            const pin = pinOf(p);
            expect(pin.peer).toBe(PUPPET);
            expect(pin.former!.length).toBeLessThanOrEqual(FORMER_MAX);
            expect(new Set(pin.former).size).toBe(pin.former!.length);
            expect(pin.former).toEqual([K2, K1]);
            expect(pin.changedAt).toEqual([times[5], times[4], times[3], times[2]]);
            expect(CHANGED_AT_MAX).toBe(4);
            expect(JSON.stringify(p).length).toBeLessThan(1000);
            const v = pinned(true);
            [K2, K1, K2, K1].forEach((k, i) => impl.applyDmListings(v, D0, [[k]], times[i]));
            expect(pinOf(v)).toMatchObject({ peer: K1, verified: { peer: K1 } });
            expect(pinOf(v).offered).toBeUndefined();
            impl.applyDmListings(v, D0, [[K2]], times[4]);
            expect(pinOf(v).offered?.peer).toBe(K2);
        },
    },
    {
        id: 'T16 storage: a mark naming another key than the pin\'s is dropped; nine notice dates keep the newest 4; by "listing" reads back; the community copy carry keeps both fields',
        run: async (impl) => {
            const dates = Array.from({ length: 9 }, (_, i) => `2026-11-0${i + 1}T00:00:00.000Z`);
            const stored: DmPeerPins = {
                [D0]: { peer: K2, since: NOW, by: 'listing', checked: true, former: [K1], verified: { peer: K1, at: NOW }, changedAt: dates },
            };
            const back = await impl.readBack(stored);
            expect(dmPinFor(back, D0)).toEqual({ peer: K2, since: NOW, by: 'listing', checked: true, former: [K1], changedAt: dates.slice(0, 4) });
            const kept: DmPeerPins = { [D0]: { peer: K2, since: NOW, by: 'member', verified: { peer: K2, at: NOW }, changedAt: [NOW] } };
            expect(dmPinFor(await impl.readBack(kept), D0)).toEqual(kept[D0]);
            // The carry: a community followed to its new address brings its pins, marks and notice dates with it.
            const carried = JSON.stringify({ pins: kept });
            expect(pinsWithCarried(null, carried, LATER)).toBe(carried);
            const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
            const here = JSON.stringify({ pins: { [D1]: { peer: K1, since: NOW, by: 'first-seen', checked: true } } });
            const merged = JSON.parse(pinsWithCarried(here, carried, LATER)!).pins;
            expect(merged[D0]).toEqual(kept[D0]);
        },
    },
];

describe('Signal\'s model: the one table (DESIGN-dm-key-signal-model §6)', () => {
    for (const row of ROWS) it(row.id, () => row.run(REAL));

    it('the store keeps one write per change, and a resting rule at rest writes nothing (one setItem per change)', async () => {
        const s = memory();
        let writes = 0;
        s.data.set(dmPeerPinsStoreKey(ME, FA), JSON.stringify({ pins: { [D0]: { peer: K1, since: NOW, by: 'first-seen', offered: { peer: K2, at: NOW } } } }));
        const book = createDmPinBook<string>({ ...s, setItem: async (k, v) => { writes++; await s.setItem(k, v); } }, (f) => f);
        expect(await book.update(ME, FA, (p) => restDmEntry(p, D0, LATER))).toBe(true);
        expect(writes).toBe(1);
        expect(await book.update(ME, FA, (p) => restDmEntry(p, D0, LATER))).toBe(false);
        expect(await book.update(ME, FA, (p) => markVerified(p, D0, K1, LATER))).toBe(false);   // moved since: nothing written
        expect(await book.update(ME, FA, (p) => markVerified(p, D0, K2, LATER))).toBe(true);
        expect(writes).toBe(2);
        expect(JSON.parse(s.data.get(dmPeerPinsStoreKey(ME, FA))!).pins[D0]).toMatchObject({ peer: K2, verified: { peer: K2 }, changedAt: [LATER] });
    });
});

/** A mutant: the real functions with one rule of the model broken. Each must fail the row named beside it. */
const verdictOf = (pins: DmPeerPins) => dmPinFor(pins, D0);
const MUTANTS: Array<{ name: string; row: string; impl: Impl }> = [
    {
        name: 'the move ignoring the mark (a verified pin follows the listing)', row: 'T1 re-key with succession, VERIFIED',
        impl: { ...REAL, applyDmListings: (p, id, l, now, h) => { const pin = verdictOf(p); const v = pin?.verified; if (pin) delete pin.verified; const r = applyDmListings(p, id, l, now, h); const after = verdictOf(p); if (after && v && after.peer === v.peer) after.verified = v; return r; } },
    },
    {
        name: 'the old rule (a pause for everyone)', row: 'T1 re-key with succession, NOT verified',
        impl: { ...REAL, applyDmListings: (p, id, l, now, h) => { const pin = verdictOf(p); if (pin && !pin.verified) pin.verified = { peer: pin.peer, at: NOW }; const r = applyDmListings(p, id, l, now, h); const after = verdictOf(p); if (after && after.verified?.at === NOW) delete after.verified; return r; }, restDmEntry: () => false },
    },
    {
        name: 'no changedAt (no notice)', row: 'T1 re-key with succession, NOT verified',
        impl: { ...REAL, applyDmListings: (p, id, l, now, h) => { const r = applyDmListings(p, id, l, now, h); const pin = verdictOf(p); if (pin) delete pin.changedAt; return r; } },
    },
    {
        name: 'former dropped at the move', row: 'T1 re-key with succession, NOT verified',
        impl: { ...REAL, applyDmListings: (p, id, l, now, h) => { const r = applyDmListings(p, id, l, now, h); const pin = verdictOf(p); if (pin?.by === 'listing') delete pin.former; return r; } },
    },
    {
        name: 'Continue dropping the mark', row: 'T1 re-key with succession, VERIFIED',
        impl: { ...REAL, acceptOffer: (p, id, k, now) => { const r = acceptOffer(p, id, k, now); const pin = verdictOf(p); if (pin) delete pin.verified; return r; } },
    },
    {
        name: 'the expected-key guard off in Mark as verified', row: 'T13 Mark as verified',
        impl: { ...REAL, markVerified: (p, id, _k, now) => { const pin = verdictOf(p); if (!pin || pin.offered) return false; return markVerified(p, id, pin.peer, now); } },
    },
    {
        name: 'moving when listings disagree (the last listing wins)', row: 'T3 several other keys without K1',
        impl: { ...REAL, applyDmListings: (p, id, l, now, h) => applyDmListings(p, id, l.length > 1 ? [l[l.length - 1]] : l, now, h) },
    },
    {
        name: 'rule 5 writing a notice', row: 'T9 rule 5',
        impl: { ...REAL, applySightVerdict: (p, id, v: SightVerdict, l, h, now) => { const r = applySightVerdict(p, id, v, l, h, now); const pin = verdictOf(p); if (v.rule === 5 && pin) pin.changedAt = [now]; return r; } },
    },
    {
        name: 'rule 5 keeping a record (refusing) though one key is listed', row: 'T9 rule 5',
        impl: { ...REAL, applySightVerdict: (p, id, v: SightVerdict, l, h, now) => (v.rule === 5 ? applySightVerdict(p, id, v, null, h, now) : applySightVerdict(p, id, v, l, h, now)) },
    },
    {
        name: 'a mark read when it names another key', row: 'T16 storage',
        impl: { ...REAL, readBack: async (pins) => JSON.parse(JSON.stringify(pins)) },
    },
    {
        name: 'the resting rule out of Remove verification', row: 'T12 Remove verification',
        impl: { ...REAL, removeVerified: (p) => { const pin = verdictOf(p); if (!pin?.verified) return false; delete pin.verified; return true; }, restDmEntry: () => false },
    },
];

describe('the table can fail: each mutant dies at its own row (§6)', () => {
    for (const m of MUTANTS) {
        it(`${m.name} → ${m.row} fails`, async () => {
            const row = ROWS.find((r) => r.id.startsWith(m.row));
            expect(row, m.row).toBeDefined();
            let failed = false;
            try { await row!.run(m.impl); } catch { failed = true; }
            expect(failed).toBe(true);
        });
    }
});

// S2 (DESIGN-dm-key-signal-model §7): the dead words, flags and branch went only because S1 left no way to reach them. This
// walks EVERY state the pure writers reach from nothing (day zero: no pin stored by an older build), each writer with each
// argument shape, and holds the two facts the removal rests on in every one of them, as written and as read back (pinOf):
//  (a) no offer naming a key carries first sight's flags (`firstSight`; `afterReset` is gone from the format): only an
//      offer naming nobody is first sight's, and its card is the "no single key" one, so the restored-phone, reset and
//      first-sight openings had nothing left to open;
//  (b) no rule-5 record names a key: `listed` is null, so getDmKeyChange's rule-5 card offers no key, and Continue's
//      rule-5 branch (acceptOffer) had nothing left to continue to.
describe('S2: what S1 left unreachable stays unreachable (every state the writers reach from nothing)', () => {
    const LISTINGS: string[][][] = [[[K1]], [[K2]], [[K1, K2]], [[K2, PUPPET]], [[K2], [PUPPET]], [[K1], [K2]]];
    const VERDICTS: SightVerdict[] = [{ rule: 1 }, { rule: 2, pin: K1, offer: false }, { rule: 3, pin: X, offer: true }, { rule: 4, pin: X, offer: true }, { rule: 5 }];
    const OPS: Array<[string, (p: DmPeerPins) => unknown]> = [
        ...LISTINGS.map((l): [string, (p: DmPeerPins) => unknown] => [`listings ${JSON.stringify(l)}`, (p) => applyDmListings(p, D0, l, LATER)]),
        ['listings [[K2]] with a re-key date', (p) => applyDmListings(p, D0, [[K2]], LATER, { rekeyedAt: REKEYED })],
        ...VERDICTS.flatMap((v) => ([K1, K2, null] as Array<string | null>).map((listed): [string, (p: DmPeerPins) => unknown] =>
            [`verdict ${v.rule} listed ${listed?.slice(0, 2) ?? 'none'}`, (p) => applySightVerdict(p, D0, v, listed, undefined, LATER)])),
        ...VERDICTS.map((v): [string, (p: DmPeerPins) => unknown] => [`reset verdict ${v.rule}`, (p) => applyResetVerdict(p, D0, v, K2, LATER)]),
        ['heldLost mark', (p) => markHeldLost(p, [D0], LATER)],
        ['first sight K2', (p) => pinAtFirstSight(p, D0, K2, LATER)],
        ['a send settles', (p) => settleFirstSight(p, D0)],
        ['resting rule', (p) => restDmEntry(p, D0, LATER)],
        ['mark K1', (p) => markVerified(p, D0, K1, LATER)],
        ['mark K2', (p) => markVerified(p, D0, K2, LATER)],
        ['remove the mark', (p) => removeVerified(p, D0, LATER)],
        ['continue to K1', (p) => acceptOffer(p, D0, K1, LATER)],
        ['continue to K2', (p) => acceptOffer(p, D0, K2, LATER)],
    ];
    const deadShapes = (p: DmPeerPins): string[] => Object.entries(p).flatMap(([id, e]) => {
        if (isUnplacedSight(e)) return pinKeyOf(e.listed) ? [`${id}: a rule-5 record naming a key`] : [];
        const o = (e as DmPeerPin).offered as unknown as (Record<string, unknown> & { peer: string | null }) | undefined;
        if (!o) return [];
        const bad: string[] = [];
        if (o.peer !== null && o.firstSight) bad.push(`${id}: an offer naming a key with firstSight`);
        if ('afterReset' in o) bad.push(`${id}: afterReset`);
        return bad;
    });

    it('from nothing, five writes deep: no offer naming a key is first sight\'s, and no rule-5 record names a key', async () => {
        const seen = new Map<string, string>([['{}', 'nothing']]);
        let frontier: Array<[string, string]> = [['{}', 'nothing']];
        for (let depth = 0; depth < 5; depth++) {
            const next: Array<[string, string]> = [];
            for (const [state, path] of frontier) {
                for (const [what, op] of OPS) {
                    const p = JSON.parse(state) as DmPeerPins;
                    op(p);
                    const after = JSON.stringify(p);
                    const via = `${path} → ${what}`;
                    expect(deadShapes(p), via).toEqual([]);
                    if (!seen.has(after)) { seen.set(after, via); next.push([after, via]); }
                }
            }
            frontier = next;
        }
        // The walk covers what the table's rows name: a verified pause, a keyless pause, a moved pin, a rule-5 record, a mark.
        const states = [...seen.keys()].map((s) => JSON.parse(s) as DmPeerPins);
        const kinds = new Set(states.map((p) => {
            const e = p[D0];
            if (!e) return 'nothing';
            if (isUnplacedSight(e)) return e.heldLost ? 'heldLost' : 'rule-5';
            const pin = e as DmPeerPin;
            return [pin.offered ? (pin.offered.peer ? 'offers a key' : 'offers nobody') : 'no offer', isVerifiedPin(pin) ? 'verified' : 'not verified', pin.by].join(', ');
        }));
        for (const k of ['nothing', 'rule-5', 'heldLost', 'offers a key, verified, member', 'offers a key, verified, first-seen', 'offers nobody, verified, first-seen',
            'offers nobody, not verified, first-seen', 'no offer, not verified, listing', 'no offer, verified, member']) expect(kinds.has(k), k).toBe(true);
        expect(seen.size).toBeGreaterThan(40);
        // Read back as the store reads it (pinOf), and carried into another community's copy (pinsWithCarried): still none.
        for (const p of states) expect(deadShapes(await REAL.readBack(p))).toEqual([]);
        const values = states.map((p) => JSON.stringify({ pins: p }));
        for (const here of values) for (const carried of values) {
            const out = pinsWithCarried(here, carried, LATER);
            if (out) expect(deadShapes((JSON.parse(out) as { pins: DmPeerPins }).pins)).toEqual([]);
        }
    });

    it('Continue has no rule-5 branch left: a record, with a key or without, is never continued from (its key comes by the resting rule)', () => {
        for (const listed of [K2, null]) {
            const p: DmPeerPins = { [D0]: { unplaced: true, since: NOW, listed } };
            for (const k of [K1, K2, PUPPET]) expect(acceptOffer(p, D0, k, LATER)).toBe(false);
            expect(dmSightFor(p, D0)).toEqual({ unplaced: true, since: NOW, listed });
            expect(dmEntryWaitsForMember(dmSightFor(p, D0))).toBe(listed === null);
        }
    });
});
