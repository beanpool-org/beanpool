/**
 * Signal's model for a DM's key change (DESIGN-dm-key-signal-model §6; Marty, 16 Nov: "yes change to signals model"): ONE table,
 * (verified? x the kind of change) -> (does the pin move? may a line be sent, and to which key? card, notice or nothing?), run
 * on the pure functions of utils/dm-peer-pins.ts. The invariant it closes (§2.1): a DM line leaves this phone sealed to the one
 * key the community lists for the other person; for a person the member marked verified, to the verified key or to nobody; no
 * single listed key = nothing sent.
 *
 * S7c (DESIGN-s7-blocks-verified-everywhere §3, §4; Marty 21 Nov): "verified" is the member's one list of keys
 * (utils/dm-verified-keys.ts), handed to every rule and read only through isVerifiedPin. The port gives the VERIFIED half the
 * list (K1 on it); the NOT verified half runs with an empty list and its expectations are unchanged. Mark, Remove and Continue
 * are db.ts's rules over the list (`mark`, `remove`, `cont` below); utils/__tests__/dm-verified-once.test.ts runs them for real.
 *
 * Every row runs against an `impl` (the real functions by default). The mutants at the end each break one rule of the model and
 * must fail their own row, so the table is shown able to fail where it matters. The rows marked † in the design also run through
 * the real sync, send and thread in dm-line-binding.test.ts ("Signal's model through the real sync").
 */
import { describe, it, expect } from 'vitest';
import {
    applyDmListings, applySightVerdict, acceptOffer, restDmEntry, judgeFirstSight, dmSightFor, dmPinFor, markableKey,
    dmOpenPeers, isUnplacedSight, dmEntryRestless, dmEntryWaitsForMember, readDmPeerPins, writeDmPeerPins, pinsWithCarried,
    createDmPinBook, markHeldLost, applyResetVerdict, pinAtFirstSight, settleFirstSight, pinKeyOf,
    CHANGED_AT_MAX, FORMER_MAX, type DmPeerPins, type DmPeerPin, type DmHeard, type SightVerdict,
} from '../dm-peer-pins';
import { dmVerifiedKeysOf, isVerifiedPin, showsVerifiedMark, DM_VERIFIED_UNREADABLE, type DmVerifiedKeys } from '../dm-verified-keys';
import { dmPeerPinsStoreKey } from '../storage-keys';

const ME = 'aa'.repeat(32);
const K1 = 'b1'.repeat(32);       // the pinned key (Ben)
const K2 = 'b2'.repeat(32);       // the newly listed key
const PUPPET = 'cc'.repeat(32);
const X = 'dd'.repeat(32);        // an older key a restored phone's lines open under
const D0 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-16T10:00:00.000Z';
const LATER = '2026-11-16T11:00:00.000Z';
const AFTER = '2026-11-16T12:00:00.000Z';
const REKEYED = '2026-11-15T00:00:00.000Z';
const FA = 'community_a.db';

/** The member's list as a row keeps it: its keys. Every rule is handed it as the store reads it ({@link listOf}). */
type Keys = Set<string>;
const listOf = (keys: Keys): DmVerifiedKeys => dmVerifiedKeysOf(keys);
const none = (): Keys => new Set();
const marked = (...keys: string[]): Keys => new Set(keys);

interface Impl {
    applyDmListings: typeof applyDmListings;
    applySightVerdict: typeof applySightVerdict;
    acceptOffer: typeof acceptOffer;
    restDmEntry: typeof restDmEntry;
    /** db.ts markDmPeerVerified's rule: the key the pin still holds (the one shown, no offer) goes on the list; the pins untouched. */
    mark: (pins: DmPeerPins, keys: Keys, id: string, expected: string) => boolean;
    /** db.ts removeDmPeerVerification's: the chat's key comes off the list, then this chat rests. */
    remove: (pins: DmPeerPins, keys: Keys, id: string, now: string) => boolean;
    /** db.ts acceptOfferedPeer's: a verified person's new key goes on the list beside the old, then the pin moves. */
    cont: (pins: DmPeerPins, keys: Keys, id: string, peer: string, now: string) => boolean;
    /** The store's read of what was written (pinOf): a round trip through JSON. */
    readBack: (pins: DmPeerPins) => Promise<DmPeerPins>;
}

function memory() {
    const data = new Map<string, string>();
    return { data, getItem: async (k: string) => data.get(k) ?? null, setItem: async (k: string, v: string) => { data.set(k, v); } };
}

const REAL: Impl = {
    applyDmListings, applySightVerdict, acceptOffer, restDmEntry,
    mark: (pins, keys, id, expected) => {
        const key = markableKey(pins, id, expected);
        if (!key) return false;
        keys.add(key);
        return true;
    },
    remove: (pins, keys, id, now) => {
        const pin = dmPinFor(pins, id);
        if (!pin || !isVerifiedPin(pin, listOf(keys))) return false;
        keys.delete(pin.peer);
        REAL.restDmEntry(pins, id, now, listOf(keys));
        return true;
    },
    cont: (pins, keys, id, peer, now) => {
        const pin = dmPinFor(pins, id);
        const key = pinKeyOf(peer);
        if (!pin?.offered || !key || pin.offered.peer !== key) return false;
        if (isVerifiedPin(pin, listOf(keys))) keys.add(key);
        return acceptOffer(pins, id, peer, now);
    },
    readBack: async (pins) => { const s = memory(); await writeDmPeerPins(s, ME, FA, pins); return readDmPeerPins(s, ME, FA); },
};

/** A pin on K1 this phone already holds (checked: it sealed there). Whether Ben is verified is the row's list. */
function pinned(): DmPeerPins {
    return { [D0]: { peer: K1, since: NOW, by: 'first-seen', checked: true } };
}

/**
 * What a send does now (db.ts getDmKeyContext 'seal' + requireDmKeyContext): the resting rule first, then the key it seals to,
 * or why nothing goes. Returns the key, 'paused' (DmKeyChangedError), or 'refused' (DmNotLockedError: no pin).
 */
function send(impl: Impl, pins: DmPeerPins, keys: Keys | DmVerifiedKeys, now = LATER): string | 'paused' | 'refused' {
    impl.restDmEntry(pins, D0, now, keys instanceof Set ? listOf(keys) : keys);
    const entry = dmSightFor(pins, D0);
    if (!entry || isUnplacedSight(entry)) return 'refused';
    return entry.offered ? 'paused' : entry.peer;
}

/** What the member sees: the card (the chat waits for them, Chat's tag with it), and how many thread notices. */
function shows(pins: DmPeerPins, keys: Keys | DmVerifiedKeys): { card: boolean; notices: number; continueTo: string | null } {
    const entry = dmSightFor(pins, D0);
    const pin = dmPinFor(pins, D0);
    return { card: dmEntryWaitsForMember(entry, keys instanceof Set ? listOf(keys) : keys), notices: pin?.changedAt?.length ?? 0, continueTo: pin?.offered?.peer ?? null };
}

const pinOf = (pins: DmPeerPins) => dmPinFor(pins, D0) as DmPeerPin;
const heardRekey: DmHeard = { tryKeys: [K1], rekeyedAt: REKEYED };

type Row = { id: string; run: (impl: Impl) => Promise<void> | void };

const ROWS: Row[] = [
    {
        id: 'T1 re-key with succession, NOT verified: the pin follows K2, K1 kept as former, one notice, the send goes to K2; no card',
        run: (impl) => {
            const p = pinned();
            const keys = none();
            expect(impl.applyDmListings(p, D0, [[K2]], LATER, listOf(keys), heardRekey)).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true, former: [K1], changedAt: [LATER] });
            expect(send(impl, p, keys)).toBe(K2);
            expect(shows(p, keys)).toEqual({ card: false, notices: 1, continueTo: null });
            expect(dmOpenPeers(pinOf(p))).toEqual([K2, K1]);   // K1's old lines, photos and voice still open
        },
    },
    {
        id: 'T1 re-key with succession, VERIFIED: K2 only offered with the date, the send pauses, the card; tick + Continue moves to K2 and K2 joins the list beside K1, one notice',
        run: (impl) => {
            const p = pinned();
            const keys = marked(K1);
            expect(impl.applyDmListings(p, D0, [[K2]], LATER, listOf(keys), heardRekey)).toBe(true);
            expect(pinOf(p)).toMatchObject({ peer: K1, offered: { peer: K2, at: LATER, nodeSays: { rekeyedAt: REKEYED } } });
            expect(send(impl, p, keys)).toBe('paused');
            expect(shows(p, keys)).toEqual({ card: true, notices: 0, continueTo: K2 });
            expect(impl.cont(p, keys, D0, K2, AFTER)).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K2, since: AFTER, by: 'member', former: [K1], changedAt: [AFTER] });
            // The old key stays on the list: other communities may still list it (S7c §3.2).
            expect([...keys].sort()).toEqual([K1, K2].sort());
            expect(isVerifiedPin(pinOf(p), listOf(keys))).toBe(true);
            expect(send(impl, p, keys)).toBe(K2);
            expect(shows(p, keys)).toEqual({ card: false, notices: 1, continueTo: null });
        },
    },
    {
        id: 'T2 node-listed new key, no statement: as T1 in both halves, the verified card with no date line',
        run: (impl) => {
            const p = pinned();
            impl.applyDmListings(p, D0, [[K2]], LATER, listOf(none()));
            expect(pinOf(p)).toMatchObject({ peer: K2, by: 'listing', former: [K1] });
            expect(send(impl, p, none())).toBe(K2);
            const v = pinned();
            const keys = marked(K1);
            impl.applyDmListings(v, D0, [[K2]], LATER, listOf(keys));
            expect(pinOf(v).offered).toEqual({ peer: K2, at: LATER });
            expect(send(impl, v, keys)).toBe('paused');
        },
    },
    {
        id: 'T3 several other keys without K1, or two listings of the chat that disagree: no move, nobody offered, refused, the "no single key" card; verified or not',
        run: (impl) => {
            for (const verified of [false, true]) {
                for (const listings of [[[K2, PUPPET]], [[K2], [PUPPET]]]) {
                    const p = pinned();
                    const keys = verified ? marked(K1) : none();
                    expect(impl.applyDmListings(p, D0, listings, LATER, listOf(keys))).toBe(true);
                    expect(pinOf(p).peer).toBe(K1);
                    expect(pinOf(p).offered).toEqual({ peer: null, at: LATER });
                    expect(send(impl, p, keys)).toBe('paused');
                    expect(shows(p, keys)).toEqual({ card: true, notices: 0, continueTo: null });
                    expect(isVerifiedPin(pinOf(p), listOf(keys))).toBe(verified);
                }
            }
        },
    },
    {
        id: 'T4 the listing names K1 and extras: nothing changes, sealed to K1 (the extras can\'t read it); verified or not',
        run: (impl) => {
            for (const verified of [false, true]) {
                const p = pinned();
                const keys = verified ? marked(K1) : none();
                const before = JSON.stringify(p);
                expect(impl.applyDmListings(p, D0, [[K1, PUPPET]], LATER, listOf(keys))).toBe(false);
                expect(JSON.stringify(p)).toBe(before);
                expect(send(impl, p, keys)).toBe(K1);
                expect(shows(p, keys)).toEqual({ card: false, notices: 0, continueTo: null });
            }
        },
    },
    {
        id: 'T5 K1 alone again after a pause (T3, or T1 verified): the offer cleared, sealed to K1, nothing shown; still verified',
        run: (impl) => {
            for (const [verified, first] of [[false, [[K2, PUPPET]]], [true, [[K2, PUPPET]]], [true, [[K2]]]] as const) {
                const p = pinned();
                const keys = verified ? marked(K1) : none();
                impl.applyDmListings(p, D0, first.map((l) => [...l]), LATER, listOf(keys));
                expect(impl.applyDmListings(p, D0, [[K1]], LATER, listOf(keys))).toBe(true);
                expect(pinOf(p).offered).toBeUndefined();
                expect(pinOf(p).peer).toBe(K1);
                expect(send(impl, p, keys)).toBe(K1);
                expect(shows(p, keys)).toEqual({ card: false, notices: 0, continueTo: null });
                expect(isVerifiedPin(pinOf(p), listOf(keys))).toBe(verified);
            }
        },
    },
    {
        id: 'T6 first sight, no lines (rule 1) or every line under the listed key (rule 2): pin the listed key, the send goes, nothing shown; a listed key already on the list is verified there at once (S7c)',
        run: (impl) => {
            const r1: DmPeerPins = {};
            impl.applySightVerdict(r1, D0, judgeFirstSight([], K2), K2, undefined, NOW, listOf(none()));
            expect(pinOf(r1)).toEqual({ peer: K2, since: NOW, by: 'first-seen' });
            const r2: DmPeerPins = {};
            impl.applySightVerdict(r2, D0, judgeFirstSight([K2, K2], K2), K2, undefined, NOW, listOf(none()));
            expect(pinOf(r2)).toEqual({ peer: K2, since: NOW, by: 'first-seen', checked: true });
            for (const p of [r1, r2]) {
                expect(send(impl, p, none())).toBe(K2);
                expect(shows(p, none())).toEqual({ card: false, notices: 0, continueTo: null });
            }
            // Verified once: K2 marked in another chat, so this new chat on K2 shows Verified ✓ with no tap here.
            const v: DmPeerPins = {};
            impl.applySightVerdict(v, D0, judgeFirstSight([K2], K2), K2, undefined, NOW, listOf(marked(K2)));
            expect(pinOf(v)).toEqual({ peer: K2, since: NOW, by: 'first-seen', checked: true });
            expect(showsVerifiedMark(pinOf(v), listOf(marked(K2)))).toBe(true);
        },
    },
    {
        id: 'T7 first sight, one other key X (rule 3) or X then the listed key (rule 4), one key listed: pin the listed key, X as former, one notice, the send goes; VERIFIED: lines under a verified key pin it and only offer the listed one (§3.3 row 3); a verified pin checked, or waiting on an offer, is never judged; an unchecked one with its own key listed keeps X as former and stays (#3316 F1)',
        run: (impl) => {
            for (const lines of [[X, X], [X, K2]]) {
                const p: DmPeerPins = {};
                expect(impl.applySightVerdict(p, D0, judgeFirstSight(lines, K2), K2, heardRekey, NOW, listOf(none()))).toBe(true);
                expect(pinOf(p)).toEqual({ peer: K2, since: NOW, by: 'listing', checked: true, former: [X], changedAt: [NOW] });
                expect(dmOpenPeers(pinOf(p))).toEqual([K2, X]);   // every line reads
                expect(send(impl, p, none())).toBe(K2);
                expect(shows(p, none())).toEqual({ card: false, notices: 1, continueTo: null });
            }
            // S7c §3.3 row 3: the phone first meets the chat here; its lines open under K1, which the member verified in
            // another community's chat; the community lists K2. The lines prove the chat was with K1: the verified card's pause.
            for (const lines of [[K1, K1], [K1, K2]]) {
                const keys = marked(K1);
                const f: DmPeerPins = {};
                expect(impl.applySightVerdict(f, D0, judgeFirstSight(lines, K2), K2, heardRekey, NOW, listOf(keys))).toBe(true);
                expect(pinOf(f)).toEqual({ peer: K1, since: NOW, by: 'first-seen', checked: true, offered: { peer: K2, at: NOW, nodeSays: { rekeyedAt: REKEYED } } });
                expect(send(impl, f, keys)).toBe('paused');
                expect(shows(f, keys)).toEqual({ card: true, notices: 0, continueTo: K2 });
            }
            // Verified and checked: never judged again (a prune and relist can't move it). Verified, unchecked, with an offer
            // waiting (the listing named PUPPET; the judgement is handed it, as db.ts does): untouched, the member decides.
            // Verified, unchecked, another key listed with nothing offered: untouched too. No judgement moves a verified pin.
            const waiting = { [D0]: { peer: K1, since: NOW, by: 'first-seen', offered: { peer: PUPPET, at: NOW } } } as DmPeerPins;
            for (const v of [pinned(), waiting, { [D0]: { peer: K1, since: NOW, by: 'first-seen' } } as DmPeerPins]) {
                const before = JSON.stringify(v);
                expect(impl.applySightVerdict(v, D0, judgeFirstSight([PUPPET, PUPPET], PUPPET), PUPPET, undefined, LATER, listOf(marked(K1)))).toBe(false);
                expect(JSON.stringify(v)).toBe(before);
            }
            expect(send(impl, waiting, marked(K1))).toBe('paused');
            // Verified, unchecked, its own key listed and nothing offered (the sync's first-sight pin on a chat met in place,
            // #3316 F1): judged. Lines under an older key X keep X as former and the pin doesn't move: one notice, every line
            // reads, the send goes to K1, Verified ✓ stays. Not row 3's pause: the member checked K1.
            for (const lines of [[X, X], [X, K1]]) {
                const keys = marked(K1);
                const u = { [D0]: { peer: K1, since: NOW, by: 'first-seen' } } as DmPeerPins;
                expect(impl.applySightVerdict(u, D0, judgeFirstSight(lines, K1), K1, undefined, LATER, listOf(keys))).toBe(true);
                expect(pinOf(u)).toEqual({ peer: K1, since: LATER, by: 'listing', checked: true, former: [X], changedAt: [LATER] });
                expect(dmOpenPeers(pinOf(u))).toEqual([K1, X]);
                expect(send(impl, u, keys)).toBe(K1);
                expect(shows(u, keys)).toEqual({ card: false, notices: 1, continueTo: null });
                expect(showsVerifiedMark(pinOf(u), listOf(keys))).toBe(true);
            }
        },
    },
    {
        id: 'T8 rule 3 with no single key listed: pin X, a keyless pause, refused, the "no single key" card',
        run: (impl) => {
            const p: DmPeerPins = {};
            impl.applySightVerdict(p, D0, judgeFirstSight([X], null), null, undefined, NOW, listOf(none()));
            expect(pinOf(p)).toMatchObject({ peer: X, checked: true, offered: { peer: null } });
            expect(send(impl, p, none())).toBe('paused');
            expect(shows(p, none())).toEqual({ card: true, notices: 0, continueTo: null });
        },
    },
    {
        id: 'T9 rule 5 (no key places the lines), one key listed (a restored phone with only old lines of a never-re-keyed person): pin it, no former, no notice, no card; the send goes',
        run: (impl) => {
            const p: DmPeerPins = {};
            expect(impl.applySightVerdict(p, D0, judgeFirstSight([null, null], K1), K1, undefined, NOW, listOf(none()))).toBe(true);
            expect(pinOf(p)).toEqual({ peer: K1, since: NOW, by: 'listing', checked: true });
            expect(send(impl, p, none())).toBe(K1);
            expect(shows(p, none())).toEqual({ card: false, notices: 0, continueTo: null });
        },
    },
    {
        id: 'T10 rule 5 with no single key listed: a record, no pin, refused, the card',
        run: (impl) => {
            const p: DmPeerPins = {};
            impl.applySightVerdict(p, D0, judgeFirstSight([null], null), null, undefined, NOW, listOf(none()));
            expect(dmSightFor(p, D0)).toEqual({ unplaced: true, since: NOW, listed: null });
            expect(send(impl, p, none())).toBe('refused');
            expect(shows(p, none())).toEqual({ card: true, notices: 0, continueTo: null });
        },
    },
    {
        id: 'T11 a kept rule-5 record or heldLost mark, then a listing names one key: it becomes a pin on it, the send goes, nothing shown',
        run: (impl) => {
            const record: DmPeerPins = {};
            impl.applySightVerdict(record, D0, judgeFirstSight([null], null), null, undefined, NOW, listOf(none()));
            const lost: DmPeerPins = {};
            markHeldLost(lost, [D0], NOW);
            for (const p of [record, lost]) {
                expect(impl.applyDmListings(p, D0, [[K2]], LATER, listOf(none()))).toBe(true);
                expect(pinOf(p)).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true });
                expect(send(impl, p, none())).toBe(K2);
                expect(shows(p, none())).toEqual({ card: false, notices: 0, continueTo: null });
            }
        },
    },
    {
        id: 'T12 Remove verification: no pause, only the key leaves the list; during T1\'s pause the key leaves AND this chat\'s pin moves to K2, one notice; during T3\'s, still paused',
        run: (impl) => {
            const calm = pinned();
            const ck = marked(K1);
            expect(impl.remove(calm, ck, D0, LATER)).toBe(true);
            expect(pinOf(calm)).toEqual({ peer: K1, since: NOW, by: 'first-seen', checked: true });
            expect([...ck]).toEqual([]);
            const t1 = pinned();
            const k1 = marked(K1);
            impl.applyDmListings(t1, D0, [[K2]], LATER, listOf(k1));
            expect(impl.remove(t1, k1, D0, AFTER)).toBe(true);
            expect(pinOf(t1)).toEqual({ peer: K2, since: AFTER, by: 'listing', checked: true, former: [K1], changedAt: [AFTER] });
            expect(shows(t1, k1)).toEqual({ card: false, notices: 1, continueTo: null });
            const t3 = pinned();
            const k3 = marked(K1);
            impl.applyDmListings(t3, D0, [[K2, PUPPET]], LATER, listOf(k3));
            expect(impl.remove(t3, k3, D0, AFTER)).toBe(true);
            expect(pinOf(t3)).toMatchObject({ peer: K1, offered: { peer: null } });
            expect(isVerifiedPin(pinOf(t3), listOf(k3))).toBe(false);
            expect(send(impl, t3, k3)).toBe('paused');
            expect(impl.remove(pinned(), none(), D0, AFTER)).toBe(false);
        },
    },
    {
        id: 'T13 Mark as verified: the key whose code was shown goes on the list, the pins untouched; refused when the pin moved since, or while an offer is held',
        run: (impl) => {
            const p: DmPeerPins = { [D0]: { peer: K1, since: NOW, by: 'first-seen' } };
            const keys = none();
            const untouched = JSON.stringify(p);
            expect(impl.mark(p, keys, D0, K1)).toBe(true);
            expect([...keys]).toEqual([K1]);
            expect(JSON.stringify(p)).toBe(untouched);   // nothing goes into the community's file (S7c §3.2)
            // The screen showed K1's code; a sync moved the pin to PUPPET before the tap: nothing written.
            const moved = pinned();
            const mk = none();
            impl.applyDmListings(moved, D0, [[PUPPET]], LATER, listOf(mk));
            const before = JSON.stringify(moved);
            expect(impl.mark(moved, mk, D0, K1)).toBe(false);
            expect(JSON.stringify(moved)).toBe(before);
            expect([...mk]).toEqual([]);
            // An offer held (no single key listed): nothing to mark until it clears.
            const held = pinned();
            const hk = none();
            impl.applyDmListings(held, D0, [[K2, PUPPET]], LATER, listOf(hk));
            expect(impl.mark(held, hk, D0, K1)).toBe(false);
            expect([...hk]).toEqual([]);
            expect(impl.mark({}, none(), D0, K1)).toBe(false);
        },
    },
    {
        id: 'T14 a stored pin holding a one-key offer with no mark (an older build\'s pause), no sync yet: the first check or send moves it, as T2; Chat shows no tag for it',
        run: (impl) => {
            const p: DmPeerPins = { [D0]: { peer: K1, since: NOW, by: 'member', offered: { peer: K2, at: NOW, firstSight: true } } };
            expect(dmEntryRestless(dmSightFor(p, D0), listOf(none()))).toBe(true);
            expect(shows(p, none()).card).toBe(false);
            expect(send(impl, p, none())).toBe(K2);
            expect(pinOf(p)).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true, former: [K1], changedAt: [LATER] });
            expect(impl.restDmEntry(p, D0, LATER, listOf(none()))).toBe(false);   // at rest: a second call writes nothing
        },
    },
    {
        id: 'T15 a flap K1→K2→K1→K2→K1→K2: not verified, every pass moves, former ≤ 4 with no repeats, changedAt ≤ 4; verified, the pin never moves and the offer is set and cleared',
        run: (impl) => {
            const p = pinned();
            const times = Array.from({ length: 6 }, (_, i) => `2026-11-16T1${i}:30:00.000Z`);
            const keys = [K2, K1, K2, K1, K2, PUPPET];
            keys.forEach((k, i) => expect(impl.applyDmListings(p, D0, [[k]], times[i], listOf(none()))).toBe(true));
            const pin = pinOf(p);
            expect(pin.peer).toBe(PUPPET);
            expect(pin.former!.length).toBeLessThanOrEqual(FORMER_MAX);
            expect(new Set(pin.former).size).toBe(pin.former!.length);
            expect(pin.former).toEqual([K2, K1]);
            expect(pin.changedAt).toEqual([times[5], times[4], times[3], times[2]]);
            expect(CHANGED_AT_MAX).toBe(4);
            expect(JSON.stringify(p).length).toBeLessThan(1000);
            const v = pinned();
            const vk = marked(K1);
            [K2, K1, K2, K1].forEach((k, i) => impl.applyDmListings(v, D0, [[k]], times[i], listOf(vk)));
            expect(pinOf(v)).toMatchObject({ peer: K1 });
            expect(pinOf(v).offered).toBeUndefined();
            impl.applyDmListings(v, D0, [[K2]], times[4], listOf(vk));
            expect(pinOf(v).offered?.peer).toBe(K2);
        },
    },
    {
        id: 'T16 storage: a mark an older build kept on a pin is not read, whichever key it names (S7c day zero, question 1); nine notice dates keep the newest 4; by "listing" reads back; the community copy carry keeps the rest',
        run: async (impl) => {
            const dates = Array.from({ length: 9 }, (_, i) => `2026-11-0${i + 1}T00:00:00.000Z`);
            for (const named of [K1, K2]) {
                const stored = {
                    [D0]: { peer: K2, since: NOW, by: 'listing', checked: true, former: [K1], verified: { peer: named, at: NOW }, changedAt: dates },
                } as unknown as DmPeerPins;
                const back = await impl.readBack(stored);
                expect(dmPinFor(back, D0)).toEqual({ peer: K2, since: NOW, by: 'listing', checked: true, former: [K1], changedAt: dates.slice(0, 4) });
            }
            const kept: DmPeerPins = { [D0]: { peer: K2, since: NOW, by: 'member', changedAt: [NOW] } };
            expect(dmPinFor(await impl.readBack(kept), D0)).toEqual(kept[D0]);
            // The carry: a community followed to its new address brings its pins and notice dates with it (the list stays put).
            const carried = JSON.stringify({ pins: kept });
            expect(pinsWithCarried(null, carried, LATER)).toBe(carried);
            const D1 = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
            const here = JSON.stringify({ pins: { [D1]: { peer: K1, since: NOW, by: 'first-seen', checked: true } } });
            const merged = JSON.parse(pinsWithCarried(here, carried, LATER)!).pins;
            expect(merged[D0]).toEqual(kept[D0]);
        },
    },
    {
        id: 'T17 the list can\'t be read (S7c §3.2): no chat follows a key change by itself (the listing only offers, first sight pauses), sends to the key already pinned carry on, and no ✓ shows',
        run: (impl) => {
            const p = pinned();
            expect(send(impl, p, DM_VERIFIED_UNREADABLE)).toBe(K1);
            expect(impl.applyDmListings(p, D0, [[K2]], LATER, DM_VERIFIED_UNREADABLE)).toBe(true);
            expect(pinOf(p)).toMatchObject({ peer: K1, offered: { peer: K2 } });
            expect(send(impl, p, DM_VERIFIED_UNREADABLE)).toBe('paused');
            expect(shows(p, DM_VERIFIED_UNREADABLE)).toEqual({ card: true, notices: 0, continueTo: K2 });
            expect(showsVerifiedMark(pinOf(p), DM_VERIFIED_UNREADABLE)).toBe(false);
            const f: DmPeerPins = {};
            impl.applySightVerdict(f, D0, judgeFirstSight([X, X], K2), K2, undefined, NOW, DM_VERIFIED_UNREADABLE);
            expect(pinOf(f)).toMatchObject({ peer: X, offered: { peer: K2 } });
            // A pin the listing gave at first sight with no line checked (a chat met in place) is still judged: its lines
            // under X make X the pin and K2 only offered. Never sealed to K2 on the node's word (found by dm-verified-once).
            const u: DmPeerPins = { [D0]: { peer: K2, since: NOW, by: 'first-seen' } };
            expect(impl.applySightVerdict(u, D0, judgeFirstSight([X, X], K2), K2, undefined, NOW, DM_VERIFIED_UNREADABLE)).toBe(true);
            expect(pinOf(u)).toMatchObject({ peer: X, checked: true, offered: { peer: K2 } });
            expect(send(impl, u, DM_VERIFIED_UNREADABLE)).toBe('paused');
            // A pause held on an unchecked pin is not judged while the list can't be read: lines all under K2 don't carry it there.
            const held: DmPeerPins = { [D0]: { peer: K1, since: NOW, by: 'first-seen', offered: { peer: K2, at: NOW } } };
            expect(impl.applySightVerdict(held, D0, judgeFirstSight([K2, K2], K2), K2, undefined, NOW, DM_VERIFIED_UNREADABLE)).toBe(false);
            expect(pinOf(held)).toMatchObject({ peer: K1, offered: { peer: K2 } });
            // Once it reads (nobody on it), the next check moves the pin, with its notice.
            expect(send(impl, p, none(), AFTER)).toBe(K2);
            expect(shows(p, none())).toEqual({ card: false, notices: 1, continueTo: null });
        },
    },
];

describe('Signal\'s model: the one table (DESIGN-dm-key-signal-model §6), its verified half on the member\'s list (S7c)', () => {
    for (const row of ROWS) it(row.id, () => row.run(REAL));

    it('the store keeps one write per change, a resting rule at rest writes nothing, and Mark writes no pin (one setItem per change)', async () => {
        const s = memory();
        let writes = 0;
        s.data.set(dmPeerPinsStoreKey(ME, FA), JSON.stringify({ pins: { [D0]: { peer: K1, since: NOW, by: 'first-seen', offered: { peer: K2, at: NOW } } } }));
        const book = createDmPinBook<string>({ ...s, setItem: async (k, v) => { writes++; await s.setItem(k, v); } }, (f) => f);
        expect(await book.update(ME, FA, (p) => restDmEntry(p, D0, LATER, listOf(none())))).toBe(true);
        expect(writes).toBe(1);
        expect(await book.update(ME, FA, (p) => restDmEntry(p, D0, LATER, listOf(none())))).toBe(false);
        const keys = none();
        expect(await book.update(ME, FA, (p) => { REAL.mark(p, keys, D0, K1); return false; })).toBe(false);   // moved since: nothing
        expect(await book.update(ME, FA, (p) => { REAL.mark(p, keys, D0, K2); return false; })).toBe(false);
        expect([...keys]).toEqual([K2]);
        expect(writes).toBe(1);
        expect(JSON.parse(s.data.get(dmPeerPinsStoreKey(ME, FA))!).pins[D0]).toEqual({ peer: K2, since: LATER, by: 'listing', checked: true, former: [K1], changedAt: [LATER] });
    });
});

/** A mutant: the real functions with one rule of the model broken. Each must fail the row named beside it. */
const verdictOf = (pins: DmPeerPins) => dmPinFor(pins, D0);
const NOBODY = dmVerifiedKeysOf([]);
const MUTANTS: Array<{ name: string; row: string; impl: Impl }> = [
    {
        name: 'the move ignoring the list (a verified pin follows the listing)', row: 'T1 re-key with succession, VERIFIED',
        impl: { ...REAL, applyDmListings: (p, id, l, now, _v, h) => applyDmListings(p, id, l, now, NOBODY, h) },
    },
    {
        name: 'the old rule (a pause for everyone)', row: 'T1 re-key with succession, NOT verified',
        impl: { ...REAL, applyDmListings: (p, id, l, now, _v, h) => applyDmListings(p, id, l, now, DM_VERIFIED_UNREADABLE, h), restDmEntry: () => false },
    },
    {
        name: 'no changedAt (no notice)', row: 'T1 re-key with succession, NOT verified',
        impl: { ...REAL, applyDmListings: (p, id, l, now, v, h) => { const r = applyDmListings(p, id, l, now, v, h); const pin = verdictOf(p); if (pin) delete pin.changedAt; return r; } },
    },
    {
        name: 'former dropped at the move', row: 'T1 re-key with succession, NOT verified',
        impl: { ...REAL, applyDmListings: (p, id, l, now, v, h) => { const r = applyDmListings(p, id, l, now, v, h); const pin = verdictOf(p); if (pin?.by === 'listing') delete pin.former; return r; } },
    },
    {
        name: 'Continue dropping the mark (the new key never joins the list)', row: 'T1 re-key with succession, VERIFIED',
        impl: { ...REAL, cont: (p, _keys, id, peer, now) => acceptOffer(p, id, peer, now) },
    },
    {
        name: 'the expected-key guard off in Mark as verified', row: 'T13 Mark as verified',
        impl: { ...REAL, mark: (p, keys, id) => { const pin = dmPinFor(p, id); if (!pin || pin.offered) return false; keys.add(pin.peer); return true; } },
    },
    {
        name: 'moving when listings disagree (the last listing wins)', row: 'T3 several other keys without K1',
        impl: { ...REAL, applyDmListings: (p, id, l, now, v, h) => applyDmListings(p, id, l.length > 1 ? [l[l.length - 1]] : l, now, v, h) },
    },
    {
        name: 'rule 5 writing a notice', row: 'T9 rule 5',
        impl: { ...REAL, applySightVerdict: (p, id, v: SightVerdict, l, h, now, vk) => { const r = applySightVerdict(p, id, v, l, h, now, vk); const pin = verdictOf(p); if (v.rule === 5 && pin) pin.changedAt = [now]; return r; } },
    },
    {
        name: 'rule 5 keeping a record (refusing) though one key is listed', row: 'T9 rule 5',
        impl: { ...REAL, applySightVerdict: (p, id, v: SightVerdict, l, h, now, vk) => (v.rule === 5 ? applySightVerdict(p, id, v, null, h, now, vk) : applySightVerdict(p, id, v, l, h, now, vk)) },
    },
    {
        name: 'a stored old mark still read (the pin keeps its own verified)', row: 'T16 storage',
        impl: { ...REAL, readBack: async (pins) => JSON.parse(JSON.stringify(pins)) },
    },
    {
        name: 'the resting rule out of Remove verification', row: 'T12 Remove verification',
        impl: { ...REAL, remove: (p, keys, id) => { const pin = dmPinFor(p, id); if (!pin || !keys.has(pin.peer)) return false; keys.delete(pin.peer); return true; } },
    },
    {
        name: 'first sight ignoring the list (S7c §4)', row: 'T7 first sight',
        impl: { ...REAL, applySightVerdict: (p, id, v: SightVerdict, l, h, now) => applySightVerdict(p, id, v, l, h, now, NOBODY) },
    },
    {
        name: 'an unchecked pin on a verified key never judged (#3316 F1: its older key never kept, its lines never open)', row: 'T7 first sight',
        impl: {
            ...REAL,
            applySightVerdict: (p, id, s: SightVerdict, l, h, now, v) => {
                const pin = dmPinFor(p, id);
                return pin && !pin.checked && showsVerifiedMark(pin, v) ? false : applySightVerdict(p, id, s, l, h, now, v);
            },
        },
    },
    {
        name: 'an unchecked pin left unjudged while the list can\'t be read (every pin "verified")', row: 'T17 the list can\'t be read',
        impl: {
            ...REAL,
            applySightVerdict: (p, id, s: SightVerdict, l, h, now, v) => {
                const pin = dmPinFor(p, id);
                return !v.readable && pin && !pin.checked ? false : applySightVerdict(p, id, s, l, h, now, v);
            },
        },
    },
    {
        name: 'an unreadable list read as empty (S7c §4)', row: 'T17 the list can\'t be read',
        impl: {
            ...REAL,
            applyDmListings: (p, id, l, now, v, h) => applyDmListings(p, id, l, now, v.readable ? v : NOBODY, h),
            applySightVerdict: (p, id, s: SightVerdict, l, h, now, v) => applySightVerdict(p, id, s, l, h, now, v.readable ? v : NOBODY),
            restDmEntry: (p, id, now, v) => restDmEntry(p, id, now, v.readable ? v : NOBODY),
        },
    },
];

describe('the table can fail: each mutant dies at its own row (§6, S7c §4)', () => {
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
// S7c: the walk runs under three lists of verified keys (nobody, K1, K1 and K2), since the list now decides what a writer does;
// Mark writes no pin, and Remove is the resting rule under a list without the key.
describe('S2: what S1 left unreachable stays unreachable (every state the writers reach from nothing)', () => {
    const LISTINGS: string[][][] = [[[K1]], [[K2]], [[K1, K2]], [[K2, PUPPET]], [[K2], [PUPPET]], [[K1], [K2]]];
    const VERDICTS: SightVerdict[] = [{ rule: 1 }, { rule: 2, pin: K1, offer: false }, { rule: 3, pin: X, offer: true }, { rule: 4, pin: X, offer: true }, { rule: 3, pin: K1, offer: true }, { rule: 5 }];
    const opsUnder = (v: DmVerifiedKeys): Array<[string, (p: DmPeerPins) => unknown]> => [
        ...LISTINGS.map((l): [string, (p: DmPeerPins) => unknown] => [`listings ${JSON.stringify(l)}`, (p) => applyDmListings(p, D0, l, LATER, v)]),
        ['listings [[K2]] with a re-key date', (p) => applyDmListings(p, D0, [[K2]], LATER, v, { rekeyedAt: REKEYED })],
        ...VERDICTS.flatMap((s) => ([K1, K2, null] as Array<string | null>).map((listed): [string, (p: DmPeerPins) => unknown] =>
            [`verdict ${s.rule} listed ${listed?.slice(0, 2) ?? 'none'}`, (p) => applySightVerdict(p, D0, s, listed, undefined, LATER, v)])),
        ...VERDICTS.map((s): [string, (p: DmPeerPins) => unknown] => [`reset verdict ${s.rule}`, (p) => applyResetVerdict(p, D0, s, K2, LATER, v)]),
        ['heldLost mark', (p) => markHeldLost(p, [D0], LATER)],
        ['first sight K2', (p) => pinAtFirstSight(p, D0, K2, LATER)],
        ['a send settles', (p) => settleFirstSight(p, D0)],
        ['resting rule', (p) => restDmEntry(p, D0, LATER, v)],
        ['remove the mark (rest with nobody verified)', (p) => restDmEntry(p, D0, LATER, NOBODY)],
        ['continue to K1', (p) => acceptOffer(p, D0, K1, LATER)],
        ['continue to K2', (p) => acceptOffer(p, D0, K2, LATER)],
    ];
    const deadShapes = (p: DmPeerPins): string[] => Object.entries(p).flatMap(([id, e]) => {
        if (isUnplacedSight(e)) return pinKeyOf(e.listed) ? [`${id}: a rule-5 record naming a key`] : [];
        const o = (e as DmPeerPin).offered as unknown as (Record<string, unknown> & { peer: string | null }) | undefined;
        const bad: string[] = [];
        if ('verified' in (e as object)) bad.push(`${id}: a pin carrying its own mark`);
        if (!o) return bad;
        if (o.peer !== null && o.firstSight) bad.push(`${id}: an offer naming a key with firstSight`);
        if ('afterReset' in o) bad.push(`${id}: afterReset`);
        return bad;
    });

    it('from nothing, five writes deep, under each list: no offer naming a key is first sight\'s, no rule-5 record names a key, and no pin carries a mark', async () => {
        const kinds = new Set<string>();
        const all: DmPeerPins[] = [];
        for (const keys of [[], [K1], [K1, K2]]) {
            const v = dmVerifiedKeysOf(keys);
            const OPS = opsUnder(v);
            const seen = new Map<string, string>([['{}', 'nothing']]);
            let frontier: Array<[string, string]> = [['{}', 'nothing']];
            for (let depth = 0; depth < 5; depth++) {
                const next: Array<[string, string]> = [];
                for (const [state, path] of frontier) {
                    for (const [what, op] of OPS) {
                        const p = JSON.parse(state) as DmPeerPins;
                        op(p);
                        const after = JSON.stringify(p);
                        const via = `[${keys.length} verified] ${path} → ${what}`;
                        expect(deadShapes(p), via).toEqual([]);
                        if (!seen.has(after)) { seen.set(after, via); next.push([after, via]); }
                    }
                }
                frontier = next;
            }
            expect(seen.size).toBeGreaterThan(20);
            for (const s of seen.keys()) {
                const p = JSON.parse(s) as DmPeerPins;
                all.push(p);
                const e = p[D0];
                if (!e) { kinds.add('nothing'); continue; }
                if (isUnplacedSight(e)) { kinds.add(e.heldLost ? 'heldLost' : 'rule-5'); continue; }
                const pin = e as DmPeerPin;
                kinds.add([pin.offered ? (pin.offered.peer ? 'offers a key' : 'offers nobody') : 'no offer', isVerifiedPin(pin, v) ? 'verified' : 'not verified', pin.by].join(', '));
            }
        }
        // The walk covers what the table's rows name: a verified pause (at first sight too), a keyless pause, a moved pin, a rule-5 record, a mark.
        for (const k of ['nothing', 'rule-5', 'heldLost', 'offers a key, verified, member', 'offers a key, verified, first-seen', 'offers nobody, verified, first-seen',
            'offers nobody, not verified, first-seen', 'no offer, not verified, listing', 'no offer, verified, member']) expect(kinds.has(k), k).toBe(true);
        // Read back as the store reads it (pinOf), and carried into another community's copy (pinsWithCarried): still none.
        for (const p of all) expect(deadShapes(await REAL.readBack(p))).toEqual([]);
        const values = [...new Set(all.map((p) => JSON.stringify({ pins: p })))].slice(0, 120);
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
            expect(dmEntryWaitsForMember(dmSightFor(p, D0), NOBODY)).toBe(listed === null);
        }
    });
});
