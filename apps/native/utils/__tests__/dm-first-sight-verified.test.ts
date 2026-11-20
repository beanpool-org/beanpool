/**
 * First sight against the member's list of verified keys (#3316 F1; DESIGN-s7-blocks-verified-everywhere §3.3): ONE table over
 * the pure pin functions, closing the class the deciding review found. A chat the phone first meets in a community that lists
 * K1 for the person, whose older lines were sealed under the person's earlier key K0 (or under K1, or under a key the node
 * made, PUPPET). Rows = how the member's list stands (empty, {K1}, {K0, K1} after a Continue, {K0}) x what the phone keeps for
 * the chat when its lines are judged (nothing yet; the sync's unchecked pin on K1; that pin with PUPPET offered, written
 * while the list couldn't be read or because K1 is on it; a checked pin) x which key the lines open under.
 *
 * Each row runs what db.ts runs: the judgement on the thread's lines (getDmKeyContext: `listed` is the rows' key with nothing
 * kept, else the offered key or the pin's own), then the send (the resting rule, then settleFirstSight). Oracles: the key the
 * send seals to (or the pause), `former`, whether the older lines open, the pause, the notice count. The invariant: a judgement
 * never moves a pin off a key the member verified; it adds the key the lines place to `former` (so they open) unless those
 * lines are under a verified key and the listed key is not verified (row 3's pause); and the verdict is the same whether or
 * not the sync pinned the listed key before the lines were read.
 *
 * Then the mutants, each dying at its own row, and the review's three measured cases, as it measured them.
 */
import { describe, it, expect } from 'vitest';
import {
    applySightVerdict, applyDmListings, restDmEntry, settleFirstSight, judgeFirstSight, pinAtFirstSight, dmPinFor, dmOpenPeers,
    type DmPeerPins, type SightVerdict,
} from '../dm-peer-pins';
import { dmVerifiedKeysOf, showsVerifiedMark, DM_VERIFIED_UNREADABLE, type DmVerifiedKeys } from '../dm-verified-keys';

const K0 = 'b0'.repeat(32);       // the person's earlier key
const K1 = 'b1'.repeat(32);       // the key the community lists
const PUPPET = 'cc'.repeat(32);   // a key the node made
const KEY = { K0, K1, PUPPET } as const;
type Name = keyof typeof KEY;
const nameOf = (k: string): Name => (Object.keys(KEY) as Name[]).find((n) => KEY[n] === k)!;
const D0 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T11:00:00.000Z';

type ListName = 'empty' | '{K1}' | '{K0,K1}' | '{K0}';
const LISTS: Record<ListName, Name[]> = { empty: [], '{K1}': ['K1'], '{K0,K1}': ['K0', 'K1'], '{K0}': ['K0'] };
type Kept = 'nothing kept' | 'unchecked, no offer' | 'unchecked, PUPPET offered' | 'checked';

interface Impl { applySightVerdict: typeof applySightVerdict }
const REAL: Impl = { applySightVerdict };

interface Outcome { pin: Name; former: Name[]; open: boolean; pauses: boolean; notices: number }

/** What the phone keeps for the chat when its lines are judged, written by the real writers. */
function kept(state: Kept): DmPeerPins {
    const p: DmPeerPins = {};
    if (state === 'nothing kept') return p;
    // The sync's first sight: the listing names K1, no line checked yet.
    expect(pinAtFirstSight(p, D0, K1, NOW, undefined, state === 'checked')).toBe(true);
    if (state === 'unchecked, PUPPET offered') {
        // The listing then names PUPPET: only offered, as when the list can't be read (or K1 is on it).
        applyDmListings(p, D0, [[PUPPET]], NOW, DM_VERIFIED_UNREADABLE);
        expect(dmPinFor(p, D0)).toEqual({ peer: K1, since: NOW, by: 'first-seen', offered: { peer: PUPPET, at: NOW } });
    }
    return p;
}

/** One row: judge the thread's lines as db.ts does, then send; what the member gets. */
function run(impl: Impl, list: ListName, state: Kept, under: Name): Outcome {
    const verified: DmVerifiedKeys = dmVerifiedKeysOf(LISTS[list].map((n) => KEY[n]));
    const p = kept(state);
    const before = dmPinFor(p, D0);
    // getDmKeyContext: with nothing kept, the rows' key; with a pin, the offered key, else the pin's own.
    const listed = before ? (before.offered ? before.offered.peer : before.peer) : K1;
    const lines = [KEY[under], KEY[under]];
    impl.applySightVerdict(p, D0, judgeFirstSight(lines, listed) as SightVerdict, listed, undefined, LATER, verified);
    // The send: the resting rule, then a first-seen pin it seals to is settled.
    restDmEntry(p, D0, LATER, verified);
    const after = dmPinFor(p, D0);
    if (after && !after.checked && after.by === 'first-seen' && !after.offered) settleFirstSight(p, D0);
    const pin = dmPinFor(p, D0)!;
    expect(pin).not.toBeNull();
    expect(pin.checked || pin.by === 'member' || !!pin.offered).toBe(true);   // never judged again, or waiting for the member
    return {
        pin: nameOf(pin.peer),
        former: (pin.former ?? []).map(nameOf),
        open: dmOpenPeers(pin).includes(KEY[under]),
        pauses: !!pin.offered,
        notices: pin.changedAt?.length ?? 0,
    };
}

const o = (pin: Name, former: Name[], open: boolean, pauses: boolean, notices: number): Outcome => ({ pin, former, open, pauses, notices });
/** The ordinary rule 3/4 result (Signal's model): the listed key is the pin, the lines' key kept as former, one notice. */
const ordinary = (listed: Name, placed: Name) => o(listed, [placed], true, false, 1);
/** Every line under the listed key (rule 2): pinned, nothing shown. */
const rule2 = (listed: Name) => o(listed, [], true, false, 0);
/** §3.3 row 3: lines under a verified key pin it and the listed key is only offered: the verified card's pause. */
const row3 = (placed: Name) => o(placed, [], true, true, 0);
/** Left as it was: the pin stays on K1 (paused when K1 is on the list with PUPPET offered); lines under another key stay shut. */
const untouched = (under: Name, pauses: boolean) => o('K1', [], under === 'K1', pauses, 0);

type Row = [ListName, Kept, Name, Outcome];
const ROWS: Row[] = [];
for (const state of ['nothing kept', 'unchecked, no offer'] as Kept[]) {
    // The same verdict whether or not the sync pinned K1 first: a K1 the member checked never pauses on lines under K0.
    for (const list of ['empty', '{K1}', '{K0,K1}'] as ListName[]) {
        ROWS.push([list, state, 'K0', ordinary('K1', 'K0')]);   // F1: K0 into former, the older lines open
        ROWS.push([list, state, 'K1', rule2('K1')]);
        ROWS.push([list, state, 'PUPPET', ordinary('K1', 'PUPPET')]);
    }
    ROWS.push(['{K0}', state, 'K0', row3('K0')]);              // K1 not checked: the lines prove the chat was with K0
    ROWS.push(['{K0}', state, 'K1', rule2('K1')]);
    ROWS.push(['{K0}', state, 'PUPPET', ordinary('K1', 'PUPPET')]);
}
// PUPPET offered, so PUPPET is the key listed now.
ROWS.push(['empty', 'unchecked, PUPPET offered', 'K0', ordinary('PUPPET', 'K0')]);
ROWS.push(['empty', 'unchecked, PUPPET offered', 'K1', ordinary('PUPPET', 'K1')]);
ROWS.push(['empty', 'unchecked, PUPPET offered', 'PUPPET', rule2('PUPPET')]);
for (const list of ['{K1}', '{K0,K1}'] as ListName[]) {
    // A pause on a verified key: no judgement moves it (T7); the member decides.
    for (const under of ['K0', 'K1', 'PUPPET'] as Name[]) ROWS.push([list, 'unchecked, PUPPET offered', under, untouched(under, true)]);
}
ROWS.push(['{K0}', 'unchecked, PUPPET offered', 'K0', row3('K0')]);
ROWS.push(['{K0}', 'unchecked, PUPPET offered', 'K1', ordinary('PUPPET', 'K1')]);
ROWS.push(['{K0}', 'unchecked, PUPPET offered', 'PUPPET', rule2('PUPPET')]);
// Checked: never judged again, on any list.
for (const list of Object.keys(LISTS) as ListName[]) {
    for (const under of ['K0', 'K1', 'PUPPET'] as Name[]) ROWS.push([list, 'checked', under, untouched(under, false)]);
}

const label = ([list, state, under]: Row | [ListName, Kept, Name]) => `list ${list} | ${state} | lines under ${under}`;

describe('first sight x the member\'s list: every list x what is kept x whose lines (#3316 F1, S7c §3.3)', () => {
    it('covers every cell once: 4 lists x 4 kept states x 3 line keys', () => {
        expect(new Set(ROWS.map((r) => label(r))).size).toBe(48);
        expect(ROWS).toHaveLength(48);
    });
    for (const row of ROWS) {
        it(label(row), () => {
            expect(run(REAL, row[0], row[1], row[2])).toEqual(row[3]);
        });
    }
});

describe('the review\'s three measured cases (#3316 F1): pinAtFirstSight K1, judge [K0, K0] with K1 listed, settleFirstSight', () => {
    for (const list of [[], [K1], [K0, K1]]) {
        it(`list of ${list.length} key(s): K1 pinned, K0 kept as former, both keys' lines open, one notice${list.includes(K1) ? ', Verified ✓' : ''}`, () => {
            const verified = dmVerifiedKeysOf(list);
            const p: DmPeerPins = {};
            pinAtFirstSight(p, D0, K1, NOW);
            expect(applySightVerdict(p, D0, judgeFirstSight([K0, K0], K1), K1, undefined, LATER, verified)).toBe(true);
            settleFirstSight(p, D0);
            const pin = dmPinFor(p, D0)!;
            expect(pin).toEqual({ peer: K1, since: LATER, by: 'listing', checked: true, former: [K0], changedAt: [LATER] });
            expect(dmOpenPeers(pin)).toEqual([K1, K0]);
            expect(showsVerifiedMark(pin, verified)).toBe(list.includes(K1));
        });
    }
});

/** A mutant: the real judgement with one part of the rule broken. Each must fail the row named beside it. */
const MUTANTS: Array<{ name: string; row: [ListName, Kept, Name]; impl: Impl }> = [
    {
        name: 'F1\'s early return back (an unchecked pin on a verified key is never judged)',
        row: ['{K1}', 'unchecked, no offer', 'K0'],
        impl: {
            applySightVerdict: (p, id, v, l, h, now, vk) => {
                const pin = dmPinFor(p, id);
                return pin && !pin.checked && showsVerifiedMark(pin, vk) ? false : applySightVerdict(p, id, v, l, h, now, vk);
            },
        },
    },
    {
        name: 'row 3\'s pause though the member checked the listed key (the listed key\'s mark ignored)',
        row: ['{K0,K1}', 'unchecked, no offer', 'K0'],
        impl: {
            applySightVerdict: (p, id, v, l, h, now, vk) => {
                const others = [K0, K1, PUPPET].filter((k) => k !== l && showsVerifiedMark({ peer: k }, vk));
                return applySightVerdict(p, id, v, l, h, now, dmVerifiedKeysOf(others));
            },
        },
    },
    {
        name: 'the same, only where the sync pinned nothing first (the verdict depends on the path)',
        row: ['{K0,K1}', 'nothing kept', 'K0'],
        impl: {
            applySightVerdict: (p, id, v, l, h, now, vk) => {
                if (dmPinFor(p, id)) return applySightVerdict(p, id, v, l, h, now, vk);
                const others = [K0, K1, PUPPET].filter((k) => k !== l && showsVerifiedMark({ peer: k }, vk));
                return applySightVerdict(p, id, v, l, h, now, dmVerifiedKeysOf(others));
            },
        },
    },
    {
        name: 'a judgement moving a pause on a verified key (the list ignored while an offer waits)',
        row: ['{K1}', 'unchecked, PUPPET offered', 'PUPPET'],
        impl: {
            applySightVerdict: (p, id, v, l, h, now, vk) => applySightVerdict(p, id, v, l, h, now, dmPinFor(p, id)?.offered ? dmVerifiedKeysOf([]) : vk),
        },
    },
    {
        name: 'the list ignored at first sight (no row-3 pause)',
        row: ['{K0}', 'nothing kept', 'K0'],
        impl: { applySightVerdict: (p, id, v, l, h, now) => applySightVerdict(p, id, v, l, h, now, dmVerifiedKeysOf([])) },
    },
    {
        name: 'a checked pin judged again',
        row: ['empty', 'checked', 'K0'],
        impl: {
            applySightVerdict: (p, id, v, l, h, now, vk) => {
                const pin = dmPinFor(p, id);
                if (pin?.checked) delete pin.checked;
                return applySightVerdict(p, id, v, l, h, now, vk);
            },
        },
    },
];

describe('the table can fail: each mutant dies at its own row', () => {
    for (const m of MUTANTS) {
        it(`${m.name} → ${label(m.row)} fails`, () => {
            const want = ROWS.find((r) => label(r) === label(m.row));
            expect(want, label(m.row)).toBeDefined();
            let failed = false;
            try { expect(run(m.impl, m.row[0], m.row[1], m.row[2])).toEqual(want![3]); } catch { failed = true; }
            expect(failed).toBe(true);
        });
    }
});

describe('a twin spelling while the list can\'t be read (#3316 max review N3, dm-peer-pins.ts judged(): showsVerifiedMark, never isVerifiedPin, for a pin with nothing offered)', () => {
    it('an unchecked first-seen pin on K1, Ben\'s lines under K0, and a twin in capitals listing another key (db.ts getDmKeyContext: no single key listed, rule 3 with offer): judged, so the keyless pause on K0; nothing is sealed to K1', () => {
        const p = kept('unchecked, no offer');
        expect(dmPinFor(p, D0)).toMatchObject({ peer: K1, by: 'first-seen' });
        expect(dmPinFor(p, D0)!.checked).toBeFalsy();
        const verdict = judgeFirstSight([K0, K0], K1) as SightVerdict;
        expect(verdict.rule === 3 || verdict.rule === 4).toBe(true);
        // getDmKeyContext's twin rule: rules 3-4 against a disagreeing twin become a keyless pause, and no key is listed.
        const twinVerdict = { rule: 3, pin: (verdict as any).pin, offer: true } as SightVerdict;
        applySightVerdict(p, D0, twinVerdict, null, undefined, LATER, DM_VERIFIED_UNREADABLE);
        restDmEntry(p, D0, LATER, DM_VERIFIED_UNREADABLE);
        const pin = dmPinFor(p, D0)!;
        expect(pin).toEqual({ peer: K0, since: LATER, by: 'first-seen', checked: true, offered: { peer: null, at: LATER, firstSight: true, keyless: true } });
        // The send's settle never runs on a pin that waits: nothing goes to K1 (or to K0) until one key is listed.
        expect(settleFirstSight(p, D0)).toBe(false);
        expect(pin.peer).not.toBe(K1);
    });
});
