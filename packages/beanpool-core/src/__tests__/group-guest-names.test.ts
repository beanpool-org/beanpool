import { describe, it, expect } from 'vitest';
import { guestNameRows, GUEST_NAMES_KEPT, type GuestListed } from '../group-guest-names.js';

// G2 part 2: the rows a member's device names guests' lines by (both apps call this; each app's guest-names.table test runs
// it through its own code). The invariant: a guest's line is named by the newest row this device has for that key, in every
// state; only a guest listed `in` by the host now may be given a key.

const SOL = 'e'.repeat(64);
const DAX = 'd'.repeat(64);
const SOL_LINE = 'Sol · riverside.example · guest';
const row = (state: string, name = 'Sol'): GuestListed => ({ key: SOL, home: 'riverside.example', name, state });

/** What this device kept from an earlier read where Sol was in. */
const keptIn = guestNameRows(null, [row('in')], 1).json;

// (the host's word now) x (what this device kept before) -> Sol's rows: shown (named, a key may go), named (gone or not), or none.
const NOW: Record<string, GuestListed[] | null> = {
    in: [row('in')],
    'asked again (a convenor\'s list)': [row('invited', 'Sol R')],
    'left or removed (not listed)': [],
    'list unread': null,
};
const TABLE: Array<[string, 'nothing' | 'in', { shown: string[]; named: Array<{ callsign: string; gone: boolean }> }]> = [
    ['in', 'nothing', { shown: [SOL_LINE], named: [] }],
    ['in', 'in', { shown: [SOL_LINE], named: [] }],
    ["asked again (a convenor's list)", 'nothing', { shown: [], named: [{ callsign: 'Sol R · riverside.example · guest', gone: true }] }],
    ["asked again (a convenor's list)", 'in', { shown: [], named: [{ callsign: 'Sol R · riverside.example · guest', gone: true }] }],
    ['left or removed (not listed)', 'nothing', { shown: [], named: [] }],
    ['left or removed (not listed)', 'in', { shown: [], named: [{ callsign: SOL_LINE, gone: true }] }],
    ['list unread', 'nothing', { shown: [], named: [] }],
    // Last seen in, the list not read now: named with no hint, and still never given a key.
    ['list unread', 'in', { shown: [], named: [{ callsign: SOL_LINE, gone: false }] }],
];

describe('guestNameRows: (the host now) x (kept before) -> the rows lines are named by', () => {
    it.each(TABLE)('host: %s; kept: %s', (now, kept, want) => {
        const out = guestNameRows(kept === 'in' ? keptIn : null, NOW[now], 2);
        expect(out.shown.map((r) => r.callsign)).toEqual(want.shown);
        expect(out.shown.every((r) => r.memberPubkey === SOL && !r.gone)).toBe(true);
        expect(out.named.map((r) => ({ callsign: r.callsign, gone: !!r.gone }))).toEqual(want.named);
        // A key that is shown is never also a kept name, so a line is named once and a key goes only by `shown`.
        expect(out.named.some((r) => out.shown.some((s) => s.memberPubkey === r.memberPubkey))).toBe(false);
    });
});

describe('what the device keeps', () => {
    it('the newest row wins, and a read that changes nothing keeps nothing new', () => {
        const a = guestNameRows(null, [row('in'), { key: DAX, home: 'eastside.example', name: 'Dax', state: 'invited' }], 1);
        expect(a.json).not.toBeNull();
        expect(guestNameRows(a.json, [row('in'), { key: DAX, home: 'eastside.example', name: 'Dax', state: 'invited' }], 5).json).toBeNull();
        const renamed = guestNameRows(a.json, [row('in', 'Solveig')], 6);
        expect(renamed.shown).toEqual([{ memberPubkey: SOL, callsign: 'Solveig · riverside.example · guest' }]);
        expect(renamed.named).toEqual([{ memberPubkey: DAX, callsign: 'Dax · eastside.example · guest', gone: true }]);
        // Out once: reading it again keeps nothing new.
        expect(guestNameRows(renamed.json, [row('in', 'Solveig')], 7).json).toBeNull();
    });

    it(`at most ${GUEST_NAMES_KEPT} kept; the ones that changed longest ago go; one listed in is shown whatever was kept`, () => {
        const many: GuestListed[] = Array.from({ length: GUEST_NAMES_KEPT + 5 }, (_, i) => ({ key: i.toString(16).padStart(64, '0'), home: 'h.example', name: `G${i}`, state: 'in' }));
        let json: string | null = null;
        many.forEach((g, i) => { json = guestNameRows(json, [g], i + 1).json ?? json; });
        const kept = Object.keys(JSON.parse(json!));
        expect(kept).toHaveLength(GUEST_NAMES_KEPT);
        expect(kept).not.toContain(many[0].key);
        expect(kept).toContain(many[many.length - 1].key);
        expect(guestNameRows(json, [many[0]], 999).shown.map((r) => r.memberPubkey)).toEqual([many[0].key]);
    });

    it('anything kept that is not a row is left out; a listed row that is not a guest is never shown', () => {
        const junk = JSON.stringify({ notakey: { name: 'x', home: 'h', state: 'in', at: 1 }, [SOL]: { name: 5 }, [DAX]: { name: 'Dax', home: 'e.example', state: 'in', at: 1 } });
        expect(guestNameRows(junk, null, 2).named.map((r) => r.memberPubkey)).toEqual([DAX]);
        expect(guestNameRows('not json', null, 2)).toMatchObject({ shown: [], named: [] });
        expect(guestNameRows(null, [{ key: 'short', home: 'h', name: 'x', state: 'in' }, null as never], 2)).toMatchObject({ shown: [], named: [] });
    });
});
